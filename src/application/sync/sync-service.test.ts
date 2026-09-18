import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncService, type SyncResult } from "@/application/sync/sync-service";
import { createAccountingConfig } from "@/domain/accounting/config";
import { dec } from "@/domain/decimal";
import { runLotEngine } from "@/domain/lots/engine";
import { deriveAssetFlows } from "@/domain/lots/flows";
import { calculatePositionMetrics } from "@/domain/pnl/position";
import type { NormalizedTrade } from "@/domain/transactions/types";
import { InMemoryProvider } from "@/providers/testing/in-memory-provider";
import { ProviderError } from "@/providers/types";
import type { Db } from "@/server/db/client";
import { HistoryRepository } from "@/server/db/history-repository";
import { PrismaSyncStore } from "@/server/db/prisma-sync-store";
import { buy, deposit, sell } from "@/test/builders";
import { createTestDb } from "@/test/test-db";

/**
 * Sync tests against a real SQLite database (migrations applied), using the
 * scriptable in-memory provider. Covers spec §29 #21–#25.
 */

let db: Db;
let cleanup: () => Promise<void>;
let repo: HistoryRepository;
let store: PrismaSyncStore;
let accountId: string;
let clock: Date;

const at = (iso: string) => new Date(iso);
const minutes = (n: number) => n * 60_000;

function service(): SyncService {
  return new SyncService({ store, now: () => new Date(clock.getTime()) });
}

function tradeFor(t: NormalizedTrade): NormalizedTrade {
  return { ...t, providerAccountId: accountId };
}

function newProvider(): InMemoryProvider {
  return new InMemoryProvider(accountId);
}

function expectOk(r: SyncResult): Extract<SyncResult, { ok: true }> {
  if (!r.ok) throw new Error(`sync failed: ${r.errorMessage}`);
  return r;
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  repo = new HistoryRepository(db);
  store = new PrismaSyncStore(db);
  await repo.ensureProvider("in-memory", "exchange", "In-memory test provider");
  accountId = await repo.createAccount("in-memory", "Test account");
  clock = at("2026-09-24T12:00:00Z");
});

afterEach(async () => {
  await cleanup();
});

describe("initial sync", () => {
  it("imports full history, balances, and records the fixed end timestamp", async () => {
    const p = newProvider();
    p.trades = [
      tradeFor(buy("100", "20", { id: "T1", at: at("2026-01-01T00:00:00Z") })),
      tradeFor(buy("100", "10", { id: "T2", at: at("2026-02-01T00:00:00Z") })),
    ];
    p.transfers = [{ ...deposit("BTC", "1", { id: "D1", at: at("2026-03-01T00:00:00Z") }), providerAccountId: accountId }];
    p.balances = [
      { provider: "in-memory", providerAccountId: accountId, asset: "ADA", total: dec("200"), available: null, asOf: clock, rawData: { ADA: "200.0000" } },
    ];

    const r = expectOk(await service().sync(p, "manual"));
    expect(r.mode).toBe("initial");
    expect(r.syncFrom).toBeNull();
    expect(r.counts).toEqual({ received: 3, inserted: 3, duplicates: 0 });
    expect(await store.getLastSuccessfulSyncAt(accountId)).toEqual(clock);
    expect((await repo.loadLatestBalances(accountId))[0]!.total.toFixed()).toBe("200");

    const run = await db.syncRun.findFirstOrThrow();
    expect(run).toMatchObject({ status: "succeeded", mode: "initial", recordsReceived: 3, recordsInserted: 3 });
    // raw provider payload preserved
    const row = await db.trade.findFirstOrThrow({ where: { externalTradeId: "T1" } });
    expect(JSON.parse(row.rawJson)).toEqual({ test: true });
  });
});

describe("#21 duplicate imported transactions", () => {
  it("running the same sync repeatedly never duplicates records", async () => {
    const p = newProvider();
    p.trades = [tradeFor(buy("1", "1", { id: "T1", at: at("2026-09-24T11:58:00Z") }))];
    expectOk(await service().sync(p, "manual"));
    clock = at("2026-09-24T12:01:00Z");
    const second = expectOk(await service().sync(p, "manual"));
    expect(second.counts).toEqual({ received: 1, inserted: 0, duplicates: 1 });
    expect(await db.trade.count()).toBe(1);
  });

  it("duplicates inside one provider response are inserted once", async () => {
    const p = newProvider();
    const t = tradeFor(buy("1", "1", { id: "T1" }));
    p.trades = [t, { ...t }];
    const r = expectOk(await service().sync(p, "manual"));
    expect(r.counts.inserted).toBe(1);
    expect(await db.trade.count()).toBe(1);
  });

  it("the database unique key is the final guard", async () => {
    const p = newProvider();
    p.trades = [tradeFor(buy("1", "1", { id: "T1" }))];
    expectOk(await service().sync(p, "manual"));
    const row = await db.trade.findFirstOrThrow();
    const { id: _id, importedAt: _i, ...copy } = row;
    await expect(db.trade.create({ data: copy })).rejects.toThrow();
  });
});

describe("#22 duplicate WebSocket + REST event", () => {
  it("a trade already stored from a live event is not re-inserted by REST", async () => {
    const live = tradeFor(buy("5", "2", { id: "TX-LIVE", at: at("2026-09-24T11:59:00Z") }));
    // Simulate a WebSocket-delivered trade stored earlier (Phase 7 path).
    await db.trade.create({
      data: {
        providerAccountId: accountId,
        externalTradeId: "TX-LIVE",
        baseAsset: "ADA",
        quoteAsset: "USD",
        side: "buy",
        quantity: "5",
        price: "2",
        grossValue: "10",
        fee: "0",
        executedAt: live.executedAt,
        rawJson: "{\"channel\":\"executions\"}",
        receivedVia: "websocket",
      },
    });
    const p = newProvider();
    p.trades = [live];
    const r = expectOk(await service().sync(p, "reconnect"));
    expect(r.counts).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(await db.trade.count()).toBe(1);
  });
});

describe("#23 interrupted synchronization", () => {
  it("a provider failure mid-sync writes nothing and keeps the previous timestamp", async () => {
    const p = newProvider();
    p.trades = [tradeFor(buy("1", "1", { id: "T1", at: at("2026-09-01T00:00:00Z") }))];
    expectOk(await service().sync(p, "manual"));
    const previous = await store.getLastSuccessfulSyncAt(accountId);

    p.trades.push(tradeFor(buy("2", "1", { id: "T2", at: at("2026-09-24T12:30:00Z") })));
    p.failOn("getBalances", new ProviderError("network", "socket hang up"));
    clock = at("2026-09-24T13:00:00Z");
    const r = await service().sync(p, "manual");

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.isNetworkError).toBe(true);
      expect(r.retryable).toBe(true);
      expect(r.lastSuccessfulSyncAt).toEqual(previous);
    }
    expect(await store.getLastSuccessfulSyncAt(accountId)).toEqual(previous);
    expect(await db.trade.count()).toBe(1); // T2 was fetched but not persisted
    const failed = await db.syncRun.findFirstOrThrow({ where: { status: "failed" } });
    expect(failed.errorMessage).toContain("socket hang up");

    // Retry succeeds and picks up T2.
    p.clearFailures();
    clock = at("2026-09-24T13:05:00Z");
    const retry = expectOk(await service().sync(p, "manual"));
    expect(retry.counts.inserted).toBe(1);
    expect(await db.trade.count()).toBe(2);
  });

  it("a failure while committing rolls back the whole batch", async () => {
    const p = newProvider();
    p.trades = [tradeFor(buy("1", "1", { id: "T1" }))];
    // Commit against a run id that does not exist: the trades are inserted
    // first inside the transaction, then the run update fails.
    await expect(
      store.commitSync({
        runId: "missing-run",
        providerAccountId: accountId,
        syncTo: clock,
        finishedAt: clock,
        batch: { trades: p.trades, transfers: [], ledgerEntries: [], balances: [] },
      }),
    ).rejects.toThrow();
    expect(await db.trade.count()).toBe(0);
    expect(await store.getLastSuccessfulSyncAt(accountId)).toBeNull();
  });

  it("invalid provider data fails the sync instead of being stored", async () => {
    const p = newProvider();
    p.trades = [{ ...tradeFor(buy("1", "1", { id: "BAD" })), quantity: dec("0") }];
    const r = await service().sync(p, "manual");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorMessage).toContain("quantity must be positive");
    expect(await db.trade.count()).toBe(0);
    expect(await store.getLastSuccessfulSyncAt(accountId)).toBeNull();
  });

  it("secrets in error messages are redacted before being stored", async () => {
    const p = newProvider();
    p.failOn("testConnection", new Error("auth failed for API-Key: AbCdEf0123456789AbCdEf0123456789AbCdEf01"));
    await service().sync(p, "manual");
    const run = await db.syncRun.findFirstOrThrow();
    expect(run.errorMessage).not.toContain("AbCdEf0123456789");
  });

  it("concurrent sync requests share a single run", async () => {
    const p = newProvider();
    p.trades = [tradeFor(buy("1", "1", { id: "T1" }))];
    const svc = service();
    const [a, b] = await Promise.all([svc.sync(p, "manual"), svc.sync(p, "periodic")]);
    expect(a).toBe(b);
    expect(await db.syncRun.count()).toBe(1);
  });
});

describe("#24 startup recovery", () => {
  it("marks crashed runs interrupted and re-syncs from last success minus the overlap", async () => {
    const p = newProvider();
    p.trades = [tradeFor(buy("100", "10", { id: "T1", at: at("2026-09-24T11:00:00Z") }))];
    expectOk(await service().sync(p, "manual")); // last success = 12:00

    // A run that was in progress when the machine shut down.
    await store.startSyncRun({ providerAccountId: accountId, mode: "periodic", syncFrom: clock, syncTo: at("2026-09-24T12:30:00Z"), startedAt: at("2026-09-24T12:30:00Z") });

    // While the app was off: a late-arriving record timestamped just before the
    // last sync (inside the overlap), and a new trade.
    p.trades.push(tradeFor(sell("40", "12", { id: "T-LATE", at: at("2026-09-24T11:57:00Z") })));
    p.trades.push(tradeFor(buy("50", "11", { id: "T-NEW", at: at("2026-09-24T18:00:00Z") })));

    clock = at("2026-09-25T08:00:00Z"); // app restarts next morning
    const r = expectOk(await service().recoverOnStartup(p));

    expect(r.mode).toBe("recovery");
    expect(r.syncFrom).toEqual(new Date(at("2026-09-24T12:00:00Z").getTime() - minutes(5)));
    expect(r.counts).toEqual({ received: 2, inserted: 2, duplicates: 0 });
    expect(await store.getLastSuccessfulSyncAt(accountId)).toEqual(clock);
    expect(await db.syncRun.count({ where: { status: "interrupted" } })).toBe(1);

    // The recovered history feeds the lot engine like any other.
    const flows = deriveAssetFlows(await repo.loadTrades(accountId), await repo.loadTransfers(accountId), createAccountingConfig());
    const engine = runLotEngine({ acquisitions: flows.acquisitions, disposals: flows.disposals, matches: [] });
    const pos = calculatePositionMetrics(engine, "ADA", dec("12"));
    expect(pos.holdings.toFixed()).toBe("110");
    expect(pos.counts.unmatchedSales).toBe(1);
  });

  it("if recovery fails, previous data and timestamp are preserved", async () => {
    const p = newProvider();
    p.trades = [tradeFor(buy("1", "1", { id: "T1" }))];
    expectOk(await service().sync(p, "manual"));
    clock = at("2026-09-25T08:00:00Z");
    p.failOn("testConnection", new ProviderError("provider_unavailable", "Kraken maintenance"));
    const r = await service().recoverOnStartup(p);
    expect(r.ok).toBe(false);
    expect(await store.getLastSuccessfulSyncAt(accountId)).toEqual(at("2026-09-24T12:00:00Z"));
    expect(await db.trade.count()).toBe(1);
  });
});

describe("#25 long offline period", () => {
  it("catches up months of history across many pages, inserting only what is new", async () => {
    const p = newProvider();
    p.pageSize = 50;
    const start = at("2026-05-01T00:00:00Z").getTime();
    const hour = 3_600_000;
    const all: NormalizedTrade[] = [];
    for (let i = 0; i < 2000; i++) {
      all.push(tradeFor(buy("1.5", "0.25", { id: `T${i}`, at: new Date(start + i * hour) })));
    }
    // Before going offline, the app had synced up to trade #500.
    clock = new Date(start + 500 * hour);
    p.trades = all.slice(0, 501);
    expectOk(await service().sync(p, "manual"));
    expect(await db.trade.count()).toBe(501);

    // ~2.5 months later
    p.trades = all;
    p.pagesFetched = 0;
    clock = new Date(start + 2100 * hour);
    const r = expectOk(await service().recoverOnStartup(p));
    expect(p.pagesFetched).toBeGreaterThan(20);
    expect(r.counts.inserted).toBe(1499);
    expect(r.counts.duplicates).toBe(1); // trade #500 sits in the overlap window
    expect(await db.trade.count()).toBe(2000);
  });
});

describe("persistence precision (#32–#34)", () => {
  it("tiny, high-precision and huge values survive a database round trip exactly", async () => {
    const values = [
      tradeFor(buy("0.00000001", "65000.123456789012345678", { id: "tiny", base: "BTC" })),
      tradeFor(buy("123456789.123456789", "0.000012345678901234", { id: "precise", base: "SHIB", fee: "0.000000000000000001" })),
      tradeFor(buy("987654321987.654321", "0.00001234", { id: "huge", base: "PEPE" })),
    ];
    const p = newProvider();
    p.trades = values;
    expectOk(await service().sync(p, "manual"));
    const loaded = await repo.loadTrades(accountId);
    for (const original of values) {
      const back = loaded.find((t) => t.externalTradeId === original.externalTradeId)!;
      for (const k of ["quantity", "price", "grossValue", "fee"] as const) {
        expect(back[k].equals(original[k]), `${original.externalTradeId}.${k}`).toBe(true);
      }
      expect(back.executedAt).toEqual(original.executedAt);
    }
  });

  it("corrupt stored numbers fail loudly instead of becoming wrong values", async () => {
    const p = newProvider();
    p.trades = [tradeFor(buy("1", "1", { id: "T1" }))];
    expectOk(await service().sync(p, "manual"));
    await db.trade.updateMany({ data: { quantity: "1,5" } });
    await expect(repo.loadTrades(accountId)).rejects.toThrow(/Invalid decimal/);
  });
});
