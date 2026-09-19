import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Reconciler, SyncService, type SyncResult } from "@/application/sync/sync-service";
import { createAccountingConfig } from "@/domain/accounting/config";
import { dec } from "@/domain/decimal";
import { runLotEngine } from "@/domain/lots/engine";
import { deriveAssetFlows } from "@/domain/lots/flows";
import type { LotMatchInstruction } from "@/domain/lots/types";
import { calculatePositionMetrics, type PositionMetrics } from "@/domain/pnl/position";
import { tradeKey } from "@/domain/transactions/identity";
import type { Db } from "@/server/db/client";
import { HistoryRepository } from "@/server/db/history-repository";
import { PrismaSyncStore } from "@/server/db/prisma-sync-store";
import { buy, match, scenario, sell } from "@/test/builders";
import { createTestDb } from "@/test/test-db";
import { FakeKraken } from "./testing/fake-kraken";
import { krakenHarness, ks } from "./testing/harness";

/**
 * Kraken → SyncService → SQLite, end to end, against the fake Kraken API.
 * Numbers in test names refer to the Phase 2 test list.
 */

let db: Db;
let cleanup: () => Promise<void>;
let repo: HistoryRepository;
let store: PrismaSyncStore;
let accountId: string;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  repo = new HistoryRepository(db);
  store = new PrismaSyncStore(db);
  await repo.ensureProvider("kraken", "exchange", "Kraken");
  accountId = await repo.createAccount("kraken", "Kraken");
});

afterEach(async () => {
  await cleanup();
});

function setup(fake = new FakeKraken(), syncStore: PrismaSyncStore = store) {
  const h = krakenHarness({ fake, accountId, startIso: "2026-09-24T12:00:00Z" });
  const service = new SyncService({ store: syncStore, now: () => new Date(h.clock.now()) });
  return { ...h, service, sync: () => service.sync(h.provider, "manual") };
}

function expectOk(r: SyncResult): Extract<SyncResult, { ok: true }> {
  if (!r.ok) throw new Error(`sync failed: [${r.errorCategory}] ${r.errorMessage}`);
  return r;
}

/** A small but realistic account history. */
function seeded(): FakeKraken {
  return new FakeKraken()
    .addLedgerRow({ type: "deposit", asset: "ZUSD", amount: "5000.0000", time: ks("2026-08-01T00:00:00Z") }, "LUSDDEP")
    .addTrade({ txid: "TA0001", pair: "ADAUSD", type: "buy", vol: "1000", price: "0.16", fee: "0.416", time: ks("2026-08-02T00:00:00Z", "1111") })
    .addTrade({ txid: "TA0002", pair: "ADAUSD", type: "buy", vol: "1000", price: "0.14", fee: "0.364", time: ks("2026-08-03T00:00:00Z", "2222") })
    .addTrade({ txid: "TB0001", pair: "XXBTZUSD", type: "buy", vol: "0.01", price: "60000", fee: "1.56", time: ks("2026-08-04T00:00:00Z") })
    .addTrade({ txid: "TA0003", pair: "ADAUSD", type: "sell", vol: "500", price: "0.15", fee: "0.195", time: ks("2026-08-05T00:00:00Z") })
    .addLedgerRow({ type: "deposit", asset: "XXBT", amount: "0.5", fee: "0.0001", time: ks("2026-08-06T00:00:00Z") }, "LBTCDEP")
    .addLedgerRow({ type: "withdrawal", asset: "ADA", amount: "-100", fee: "1", time: ks("2026-08-07T00:00:00Z") }, "LADAWD");
}

async function dumpImported() {
  const [trades, ledger, transfers] = await Promise.all([
    db.trade.findMany({ orderBy: { externalTradeId: "asc" } }),
    db.ledgerEntry.findMany({ orderBy: { externalLedgerId: "asc" } }),
    db.transfer.findMany({ orderBy: { externalTransferId: "asc" } }),
  ]);
  return { trades, ledger, transfers };
}

describe("initial sync", () => {
  it("imports trades, ledger, transfers and balances, and records everything on the run", async () => {
    const { sync } = setup(seeded());
    const r = expectOk(await sync());
    expect(r.mode).toBe("initial");
    expect(r.counts).toMatchObject({
      trades: { received: 4, inserted: 4 },
      ledgerEntries: { received: 11, inserted: 11 },
      // USD deposit, BTC deposit, ADA withdrawal (the USD one is cash: stored, but no lot)
      transfers: { received: 3, inserted: 3 },
    });
    expect(await store.getLastSuccessfulSyncAt(accountId)).toEqual(new Date("2026-09-24T12:00:00Z"));
    const run = await db.syncRun.findFirstOrThrow();
    expect(run).toMatchObject({
      status: "succeeded",
      tradesReceived: 4,
      tradesInserted: 4,
      ledgerReceived: 11,
      ledgerInserted: 11,
      transfersReceived: 3,
      transfersInserted: 3,
      errorCategory: null,
    });
    expect(run.balancesRetrieved).toBeGreaterThan(0);
  });
});

describe("#19/#20 idempotency", () => {
  it("importing the same Kraken data three times yields exactly the same stored records", async () => {
    const { sync, clock } = setup(seeded());
    expectOk(await sync());
    const first = await dumpImported();
    for (let i = 0; i < 2; i++) {
      clock.advance(60_000);
      const r = expectOk(await sync());
      expect(r.counts.inserted).toBe(0);
    }
    const third = await dumpImported();
    expect(third).toEqual(first);
    expect(third.trades).toHaveLength(4);
    expect(third.ledger).toHaveLength(11);
  });

  it("a full re-download (no overlap cut) also inserts nothing twice", async () => {
    const fake = seeded();
    const { sync } = setup(fake);
    expectOk(await sync());
    await db.providerAccount.update({ where: { id: accountId }, data: { lastSuccessfulSyncAt: null } });
    const again = expectOk(await sync());
    expect(again.counts).toMatchObject({ inserted: 0, trades: { received: 4, inserted: 0 }, ledgerEntries: { received: 11, inserted: 0 } });
  });
});

describe("#21/#22 incremental sync with a five-minute overlap", () => {
  it("fetches from last success − 5 minutes and imports only what is new", async () => {
    const fake = seeded();
    const { sync, clock } = setup(fake);
    expectOk(await sync()); // last success 12:00:00

    // Arrives later but is timestamped 2 minutes BEFORE the last sync: only the overlap catches it.
    fake.addTrade({ txid: "TLATE1", pair: "ADAUSD", type: "buy", vol: "10", price: "0.2", time: ks("2026-09-24T11:58:00Z") });
    fake.addTrade({ txid: "TNEW01", pair: "ADAUSD", type: "buy", vol: "20", price: "0.2", time: ks("2026-09-24T12:30:00Z") });
    clock.set("2026-09-24T13:00:00Z");
    fake.requests.length = 0;

    const r = expectOk(await sync());
    expect(r.mode).toBe("manual");
    expect(r.syncFrom).toEqual(new Date("2026-09-24T11:55:00Z"));
    expect(r.counts.trades).toEqual({ received: 2, inserted: 2 });
    // The history download, not the one-minute connection check (without_count).
    const th = fake.requests.find((q) => q.method === "TradesHistory" && !q.params["without_count"])!.params;
    expect(th["start"]).toBe(String(Date.parse("2026-09-24T11:55:00Z") / 1000 - 1));
    expect(th["end"]).toBe(String(Date.parse("2026-09-24T13:00:00Z") / 1000));
    expect(await store.getLastSuccessfulSyncAt(accountId)).toEqual(new Date("2026-09-24T13:00:00Z"));
    expect(await db.trade.count()).toBe(6);
  });
});

describe("#24/#26 API failure during pagination", () => {
  it("fails the sync, writes nothing, and keeps the previous timestamp", async () => {
    const fake = seeded();
    const { sync, clock } = setup(fake);
    expectOk(await sync());
    const before = await dumpImported();

    for (let i = 0; i < 120; i++) {
      fake.addTrade({ txid: `TP${i}`, pair: "ADAUSD", type: "buy", vol: "1", price: "0.2", time: `${Date.parse("2026-09-24T12:10:00Z") / 1000 + i}.0000` });
    }
    fake.fail("TradesHistory", "network", 99, 100); // second page always fails
    clock.set("2026-09-24T14:00:00Z");
    const r = await sync();

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorCategory).toBe("network");
      expect(r.lastSuccessfulSyncAt).toEqual(new Date("2026-09-24T12:00:00Z"));
    }
    expect(await store.getLastSuccessfulSyncAt(accountId)).toEqual(new Date("2026-09-24T12:00:00Z"));
    expect(await dumpImported()).toEqual(before);
    const failed = await db.syncRun.findFirstOrThrow({ where: { status: "failed" } });
    expect(failed.errorCategory).toBe("network");
    expect(failed.errorMessage).toMatch(/Network error while calling Kraken TradesHistory/);
  });

  it("invalid credentials fail the sync with a clear category", async () => {
    const fake = seeded().fail("GetApiKeyInfo", { error: "EAPI:Invalid key" });
    const r = await setup(fake).sync();
    expect(r).toMatchObject({ ok: false, errorCategory: "invalid_credentials" });
  });
});

describe("#25 database failure during commit", () => {
  it("rolls back every inserted record and keeps the previous timestamp", async () => {
    class FailingStore extends PrismaSyncStore {
      override commitSync(commit: Parameters<PrismaSyncStore["commitSync"]>[0]) {
        const exploding: Reconciler = () => {
          throw new Error("disk I/O error");
        };
        return super.commitSync({ ...commit, reconcile: exploding });
      }
    }
    const { sync } = setup(seeded(), new FailingStore(db));
    const r = await sync();
    expect(r).toMatchObject({ ok: false, errorCategory: "database" });
    expect(await db.trade.count()).toBe(0);
    expect(await db.ledgerEntry.count()).toBe(0);
    expect(await db.transfer.count()).toBe(0);
    expect(await db.balanceSnapshot.count()).toBe(0);
    expect(await store.getLastSuccessfulSyncAt(accountId)).toBeNull();
    expect((await db.syncRun.findFirstOrThrow()).errorMessage).toContain("disk I/O error");
  });
});

describe("#27/#28 balance reconciliation", () => {
  it("#27 matches Kraken balances when history is complete, and stores the result", async () => {
    const r = expectOk(await setup(seeded()).sync());
    const byAsset = Object.fromEntries(r.reconciliation.map((row) => [row.asset, row]));
    // ADA: 1000 + 1000 − 500 − (100 + 1) = 1399 ; BTC: 0.01 + (0.5 − 0.0001) = 0.5099
    expect(byAsset["ADA"]).toMatchObject({ status: "reconciled" });
    expect(byAsset["ADA"]!.calculated.toFixed()).toBe("1399");
    expect(byAsset["BTC"]!.reported.toFixed()).toBe("0.5099");
    expect(r.reconciliation.every((row) => row.status === "reconciled")).toBe(true);
    const stored = await db.reconciliationResult.findMany();
    expect(stored.map((s) => s.status)).toEqual(["reconciled", "reconciled"]);
  });

  it("#28 reports a mismatch with the signed difference and never edits history", async () => {
    const fake = seeded();
    fake.balanceOverride = { ...fake.ledgerBalances(), ADA: "2399.0000000000" };
    const r = expectOk(await setup(fake).sync());
    const ada = r.reconciliation.find((row) => row.asset === "ADA")!;
    expect(ada.status).toBe("mismatch");
    expect(ada.difference.toFixed()).toBe("1000");
    const stored = await db.reconciliationResult.findFirstOrThrow({ where: { asset: "ADA" } });
    expect(stored).toMatchObject({ status: "mismatch", calculated: "1399", reported: "2399", difference: "1000" });
    expect(await db.trade.count()).toBe(4);
  });

  it("staking buckets reconcile against the canonical asset", async () => {
    const fake = seeded()
      .addLedgerRow({ type: "transfer", subtype: "spottostaking", asset: "ADA", amount: "-300", time: ks("2026-08-08T00:00:00Z") })
      .addLedgerRow({ type: "transfer", subtype: "stakingfromspot", asset: "ADA.S", amount: "300", time: ks("2026-08-08T00:00:00Z") })
      .addLedgerRow({ type: "staking", asset: "ADA.S", amount: "1.5", time: ks("2026-08-15T00:00:00Z") });
    const r = expectOk(await setup(fake).sync());
    const ada = r.reconciliation.find((row) => row.asset === "ADA")!;
    expect(ada).toMatchObject({ status: "reconciled" });
    expect(ada.calculated.toFixed()).toBe("1400.5");
  });
});

describe("#30 raw provider data is preserved", () => {
  it("keeps the original Kraken rows, including exact timestamps", async () => {
    expectOk(await setup(seeded()).sync());
    const trade = await db.trade.findFirstOrThrow({ where: { externalTradeId: "TA0001" } });
    const raw = JSON.parse(trade.rawJson);
    expect(raw.txid).toBe("TA0001");
    expect(raw.trade).toMatchObject({ ordertxid: "OTA0001", pair: "ADAUSD", time: ks("2026-08-02T00:00:00Z", "1111"), vol: "1000", fee: "0.416" });
    expect(trade.feeSource).toBe("ledger");
    expect(trade.origin).toBe("exchange");
    const ledger = await db.ledgerEntry.findFirstOrThrow({ where: { externalLedgerId: "LADAWD" } });
    expect(JSON.parse(ledger.rawJson).ledger).toMatchObject({ type: "withdrawal", asset: "ADA", amount: "-100", fee: "1" });
    expect(ledger).toMatchObject({ providerEntryType: "withdrawal", entryType: "withdrawal", amount: "-100" });
    const balance = await db.balanceSnapshot.findFirstOrThrow({ where: { asset: "BTC" } });
    expect(JSON.parse(balance.rawJson).components).toHaveProperty("XXBT");
  });
});

describe("#31 provider-specific symbols never leak", () => {
  it("only canonical asset codes are stored and reach the domain", async () => {
    const fake = seeded()
      .addTrade({ txid: "TETH01", pair: "XETHXXBT", type: "buy", vol: "0.1", price: "0.05", time: ks("2026-08-09T00:00:00Z") })
      .addLedgerRow({ type: "staking", asset: "ETH2.S", amount: "0.001", time: ks("2026-08-10T00:00:00Z") });
    expectOk(await setup(fake).sync());
    const assets = new Set<string>([
      ...(await db.trade.findMany()).flatMap((t) => [t.baseAsset, t.quoteAsset, t.feeAsset ?? ""]),
      ...(await db.transfer.findMany()).map((t) => t.asset),
      ...(await db.ledgerEntry.findMany()).map((e) => e.asset),
      ...(await db.balanceSnapshot.findMany()).map((b) => b.asset),
    ]);
    assets.delete("");
    expect([...assets].sort()).toEqual(["ADA", "BTC", "ETH", "USD"]);
    const flows = deriveAssetFlows(await repo.loadTrades(), await repo.loadTransfers(), createAccountingConfig());
    const engineAssets = new Set([...flows.acquisitions, ...flows.disposals].map((f) => f.asset));
    expect([...engineAssets].sort()).toEqual(["ADA", "BTC", "ETH"]);
  });
});

describe("#32 Kraken-sourced history gives the same result as equivalent Phase 1 data", () => {
  it("identical metrics for: buy 100 @ $20, buy 100 @ $10, sell 100 @ $13 closing the $10 lot", async () => {
    const fake = new FakeKraken()
      .addLedgerRow({ type: "deposit", asset: "ZUSD", amount: "5000", time: ks("2026-07-31T00:00:00Z") })
      .addTrade({ txid: "TK20", pair: "ADAUSD", type: "buy", vol: "100", price: "20", fee: "5.2", time: ks("2026-08-01T00:00:00Z") })
      .addTrade({ txid: "TK10", pair: "ADAUSD", type: "buy", vol: "100", price: "10", fee: "2.6", time: ks("2026-08-02T00:00:00Z") })
      .addTrade({ txid: "TK13", pair: "ADAUSD", type: "sell", vol: "100", price: "13", fee: "3.38", time: ks("2026-08-03T00:00:00Z") });
    expectOk(await setup(fake).sync());

    const trades = await repo.loadTrades(accountId);
    const flows = deriveAssetFlows(trades, await repo.loadTransfers(accountId), createAccountingConfig());
    const byId = (id: string) => trades.find((t) => t.externalTradeId === id)!;
    const krakenMatch: LotMatchInstruction = {
      id: "m1",
      disposalId: `${tradeKey(byId("TK13"))}:base`,
      lotId: `${tradeKey(byId("TK10"))}:base`,
      quantity: dec("100"),
    };
    const fromKraken = calculatePositionMetrics(
      runLotEngine({ acquisitions: flows.acquisitions, disposals: flows.disposals, matches: [krakenMatch], dataQualityFlags: flows.flags }),
      "ADA",
      dec("13"),
    );

    const b20 = buy("100", "20", { fee: "5.2" });
    const b10 = buy("100", "10", { fee: "2.6" });
    const x = sell("100", "13", { fee: "3.38" });
    const fromPhase1 = scenario({ trades: [b20, b10, x], matches: [match(x, b10, "100")] }).position("ADA", "13");

    const view = (p: PositionMetrics) =>
      Object.fromEntries(
        (["holdings", "currentValue", "costBasis", "averageCost", "realizedPnl", "unrealizedPnl", "unrealizedPnlPercent", "totalPnl"] as const).map((k) => {
          const v = p[k];
          return [k, "status" in v ? (v.status === "known" ? v.value.toFixed() : v.status) : v.toFixed()];
        }),
      );
    expect(view(fromKraken)).toEqual(view(fromPhase1));
    expect(view(fromKraken)).toMatchObject({ realizedPnl: "294.02", costBasis: "2005.2", totalPnl: "-411.18" });
  });
});
