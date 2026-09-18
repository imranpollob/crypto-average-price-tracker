import { planSyncWindow } from "@/domain/sync/window";
import { validateBatch } from "@/domain/transactions/validate";
import type {
  NormalizedBalance,
  NormalizedLedgerEntry,
  NormalizedTrade,
  NormalizedTransfer,
} from "@/domain/transactions/types";
import { safeErrorMessage } from "@/lib/redact";
import { type PortfolioProvider, ProviderError } from "@/providers/types";

/**
 * Provider-agnostic REST synchronization ("REST makes the portfolio correct").
 *
 *   1. read last_successful_sync_at
 *   2. fix the window end (now) and start = last success − overlap (or full history)
 *   3. fetch everything from the provider — nothing is written yet
 *   4. validate every record
 *   5. in ONE transaction: insert new records (idempotent), store the balance
 *      snapshot, mark the run succeeded, advance last_successful_sync_at
 *
 * Any failure before or during step 5 leaves the database exactly as it was
 * apart from the failed sync_run row: the previous timestamp is preserved and
 * the next run re-fetches the same window.
 *
 * Later phases extend the pipeline (reconciliation, prices, lot rebuild) via
 * the application layer; the store contract stays the same.
 */

export type SyncMode = "initial" | "recovery" | "manual" | "periodic" | "reconnect";

export interface SyncBatch {
  readonly trades: readonly NormalizedTrade[];
  readonly ledgerEntries: readonly NormalizedLedgerEntry[];
  readonly transfers: readonly NormalizedTransfer[];
  readonly balances: readonly NormalizedBalance[];
}

export interface PersistCounts {
  readonly received: number;
  readonly inserted: number;
  readonly duplicates: number;
}

/** Persistence port. Implemented by the Prisma repository (and an in-memory fake if needed). */
export interface SyncStore {
  getLastSuccessfulSyncAt(providerAccountId: string): Promise<Date | null>;
  startSyncRun(run: {
    providerAccountId: string;
    mode: SyncMode;
    syncFrom: Date | null;
    syncTo: Date;
    startedAt: Date;
  }): Promise<string>;
  /** Atomically persist the batch, mark the run succeeded and set last_successful_sync_at = syncTo. */
  commitSync(commit: {
    runId: string;
    providerAccountId: string;
    syncTo: Date;
    finishedAt: Date;
    batch: SyncBatch;
  }): Promise<PersistCounts>;
  failSyncRun(fail: { runId: string; finishedAt: Date; errorMessage: string }): Promise<void>;
  /** Mark runs left "running" by a crash/shutdown as interrupted. */
  markInterruptedRuns(providerAccountId: string, at: Date): Promise<number>;
}

export type SyncResult =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly mode: SyncMode;
      readonly syncFrom: Date | null;
      readonly syncTo: Date;
      readonly counts: PersistCounts;
      readonly lastSuccessfulSyncAt: Date;
    }
  | {
      readonly ok: false;
      readonly runId: string | null;
      readonly mode: SyncMode;
      readonly errorMessage: string;
      readonly retryable: boolean;
      readonly isNetworkError: boolean;
      /** Unchanged previous value — data must be shown "as of" this time. */
      readonly lastSuccessfulSyncAt: Date | null;
    };

export interface SyncServiceOptions {
  readonly store: SyncStore;
  readonly now?: () => Date;
  readonly overlapMs?: number;
}

export class SyncService {
  private readonly inFlight = new Map<string, Promise<SyncResult>>();
  private readonly now: () => Date;

  constructor(private readonly options: SyncServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Run a sync for one account. Concurrent calls for the same account share
   * the in-flight run instead of starting a second one.
   */
  sync(provider: PortfolioProvider, mode: SyncMode): Promise<SyncResult> {
    const key = provider.providerAccountId;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const run = this.runSync(provider, mode).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  /** Startup: clean up crashed runs, then recovery-sync before data is considered current. */
  async recoverOnStartup(provider: PortfolioProvider): Promise<SyncResult> {
    await this.options.store.markInterruptedRuns(provider.providerAccountId, this.now());
    return this.sync(provider, "recovery");
  }

  private async runSync(provider: PortfolioProvider, requestedMode: SyncMode): Promise<SyncResult> {
    const { store } = this.options;
    const accountId = provider.providerAccountId;
    const last = await store.getLastSuccessfulSyncAt(accountId);
    const window = planSyncWindow({ lastSuccessfulSyncAt: last, now: this.now(), overlapMs: this.options.overlapMs });
    const mode: SyncMode = window.mode === "initial" ? "initial" : requestedMode;

    let runId: string | null = null;
    try {
      runId = await store.startSyncRun({
        providerAccountId: accountId,
        mode,
        syncFrom: window.since,
        syncTo: window.until,
        startedAt: this.now(),
      });

      const connection = await provider.testConnection();
      if (!connection.ok) throw new ProviderError(connection.code, connection.message);

      const params = { since: window.since, until: window.until };
      const cap = provider.capabilities;
      const trades = cap.trades ? await provider.syncTrades(params) : [];
      const ledgerEntries = cap.ledger ? await provider.syncLedgerEntries(params) : [];
      const transfers = cap.transfers ? await provider.syncTransfers(params) : [];
      const balances = cap.balances ? await provider.getBalances() : [];
      const batch: SyncBatch = { trades, ledgerEntries, transfers, balances };

      const problems = validateBatch(batch, accountId);
      if (problems.length > 0) {
        const sample = problems.slice(0, 3).map((p) => `${p.record}: ${p.problem}`).join("; ");
        throw new ProviderError(
          "invalid_response",
          `Provider returned ${problems.length} invalid record(s): ${sample}`,
          false,
        );
      }

      const counts = await store.commitSync({
        runId,
        providerAccountId: accountId,
        syncTo: window.until,
        finishedAt: this.now(),
        batch,
      });
      return {
        ok: true,
        runId,
        mode,
        syncFrom: window.since,
        syncTo: window.until,
        counts,
        lastSuccessfulSyncAt: window.until,
      };
    } catch (error) {
      const errorMessage = safeErrorMessage(error);
      if (runId) {
        try {
          await store.failSyncRun({ runId, finishedAt: this.now(), errorMessage });
        } catch {
          // Recording the failure must not mask the original error.
        }
      }
      const pe = error instanceof ProviderError ? error : null;
      return {
        ok: false,
        runId,
        mode,
        errorMessage,
        retryable: pe ? pe.retryable : true,
        isNetworkError: pe?.code === "network",
        lastSuccessfulSyncAt: last,
      };
    }
  }
}
