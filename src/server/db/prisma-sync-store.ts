import type {
  PersistCounts,
  SyncBatch,
  SyncMode,
  SyncStore,
} from "@/application/sync/sync-service";
import { dedupeBy } from "@/domain/transactions/identity";
import type { Db } from "./client";
import { balanceToRow, ledgerToRow, tradeToRow, transferToRow } from "./codec";

/** SQLite has a bound-parameter limit; look up existing keys in chunks. */
const KEY_CHUNK = 500;

type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Insert-if-absent for one record type. The domain dedupes the batch, existing
 * keys are skipped, and the (account, external id) unique index is the final
 * guard. Existing rows are never modified: history is immutable once imported.
 */
async function insertNew<T>(params: {
  records: readonly T[];
  keyOf: (r: T) => string;
  findExisting: (keys: string[]) => Promise<string[]>;
  insert: (records: T[]) => Promise<number>;
}): Promise<{ inserted: number; duplicates: number }> {
  const { unique, duplicates: inBatch } = dedupeBy(params.records, params.keyOf);
  const existing = new Set<string>();
  for (const chunk of chunks(unique.map(params.keyOf), KEY_CHUNK)) {
    for (const k of await params.findExisting(chunk)) existing.add(k);
  }
  const fresh = unique.filter((r) => !existing.has(params.keyOf(r)));
  const inserted = fresh.length > 0 ? await params.insert(fresh) : 0;
  return { inserted, duplicates: inBatch.length + existing.size };
}

async function persistBatch(tx: Tx, accountId: string, batch: SyncBatch, runId: string): Promise<PersistCounts> {
  const trades = await insertNew({
    records: batch.trades,
    keyOf: (t) => t.externalTradeId,
    findExisting: async (keys) =>
      (
        await tx.trade.findMany({
          where: { providerAccountId: accountId, externalTradeId: { in: keys } },
          select: { externalTradeId: true },
        })
      ).map((r) => r.externalTradeId),
    insert: async (rows) => (await tx.trade.createMany({ data: rows.map(tradeToRow) })).count,
  });

  const transfers = await insertNew({
    records: batch.transfers,
    keyOf: (t) => t.externalTransferId,
    findExisting: async (keys) =>
      (
        await tx.transfer.findMany({
          where: { providerAccountId: accountId, externalTransferId: { in: keys } },
          select: { externalTransferId: true },
        })
      ).map((r) => r.externalTransferId),
    insert: async (rows) => (await tx.transfer.createMany({ data: rows.map(transferToRow) })).count,
  });

  const ledger = await insertNew({
    records: batch.ledgerEntries,
    keyOf: (e) => e.externalLedgerId,
    findExisting: async (keys) =>
      (
        await tx.ledgerEntry.findMany({
          where: { providerAccountId: accountId, externalLedgerId: { in: keys } },
          select: { externalLedgerId: true },
        })
      ).map((r) => r.externalLedgerId),
    insert: async (rows) => (await tx.ledgerEntry.createMany({ data: rows.map(ledgerToRow) })).count,
  });

  if (batch.balances.length > 0) {
    await tx.balanceSnapshot.createMany({ data: batch.balances.map((b) => balanceToRow(b, runId)) });
  }

  const received = batch.trades.length + batch.transfers.length + batch.ledgerEntries.length;
  const inserted = trades.inserted + transfers.inserted + ledger.inserted;
  return { received, inserted, duplicates: trades.duplicates + transfers.duplicates + ledger.duplicates };
}

export class PrismaSyncStore implements SyncStore {
  constructor(private readonly db: Db) {}

  async getLastSuccessfulSyncAt(providerAccountId: string): Promise<Date | null> {
    const account = await this.db.providerAccount.findUniqueOrThrow({
      where: { id: providerAccountId },
      select: { lastSuccessfulSyncAt: true },
    });
    return account.lastSuccessfulSyncAt;
  }

  async startSyncRun(run: {
    providerAccountId: string;
    mode: SyncMode;
    syncFrom: Date | null;
    syncTo: Date;
    startedAt: Date;
  }): Promise<string> {
    const created = await this.db.syncRun.create({
      data: { ...run, status: "running" },
      select: { id: true },
    });
    return created.id;
  }

  async commitSync(commit: {
    runId: string;
    providerAccountId: string;
    syncTo: Date;
    finishedAt: Date;
    batch: SyncBatch;
  }): Promise<PersistCounts> {
    return this.db.$transaction(async (tx) => {
      const counts = await persistBatch(tx, commit.providerAccountId, commit.batch, commit.runId);
      await tx.syncRun.update({
        where: { id: commit.runId },
        data: {
          status: "succeeded",
          finishedAt: commit.finishedAt,
          recordsReceived: counts.received,
          recordsInserted: counts.inserted,
        },
      });
      // Advanced only here, inside the same transaction as the data it vouches for.
      await tx.providerAccount.update({
        where: { id: commit.providerAccountId },
        data: { lastSuccessfulSyncAt: commit.syncTo },
      });
      return counts;
    });
  }

  async failSyncRun(fail: { runId: string; finishedAt: Date; errorMessage: string }): Promise<void> {
    await this.db.syncRun.update({
      where: { id: fail.runId },
      data: { status: "failed", finishedAt: fail.finishedAt, errorMessage: fail.errorMessage },
    });
  }

  async markInterruptedRuns(providerAccountId: string, at: Date): Promise<number> {
    const result = await this.db.syncRun.updateMany({
      where: { providerAccountId, status: "running" },
      data: {
        status: "interrupted",
        finishedAt: at,
        errorMessage: "Interrupted: the app stopped before this sync completed",
      },
    });
    return result.count;
  }
}
