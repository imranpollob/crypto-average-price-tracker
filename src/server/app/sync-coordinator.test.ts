import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncService } from "@/application/sync/sync-service";
import { createAccountingConfig } from "@/domain/accounting/config";
import { KrakenMarketData } from "@/providers/kraken/market-data";
import { FakeKraken } from "@/providers/kraken/testing/fake-kraken";
import { krakenHarness, ks } from "@/providers/kraken/testing/harness";
import type { Db } from "@/server/db/client";
import { HistoryRepository } from "@/server/db/history-repository";
import { PrismaSyncStore } from "@/server/db/prisma-sync-store";
import { createTestDb } from "@/test/test-db";
import { LotService } from "./lot-service";
import { PortfolioService } from "./portfolio-service";
import { PriceService } from "./price-service";
import { SyncCoordinator } from "./sync-coordinator";

/** MVP: startup recovery, Sync now, offline behaviour, no concurrent syncs. */

const config = createAccountingConfig("USD", undefined, ["KFEE"]);

let db: Db;
let cleanup: () => Promise<void>;
let acct: string;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  const repo = new HistoryRepository(db);
  await repo.ensureProvider("kraken", "exchange", "Kraken");
  acct = await repo.createAccount("kraken", "Kraken");
});
afterEach(async () => {
  await cleanup();
});

function seeded(): FakeKraken {
  const fake = new FakeKraken()
    .addLedgerRow({ type: "deposit", asset: "ZUSD", amount: "1000.0000", time: ks("2026-08-01T00:00:00Z") }, "LUSDDEP")
    .addTrade({ txid: "TA0001", pair: "ADAUSD", type: "buy", vol: "1000", price: "0.16", time: ks("2026-08-02T00:00:00Z") })
    .addTrade({ txid: "TA0002", pair: "ADAUSD", type: "sell", vol: "400", price: "0.20", time: ks("2026-08-03T00:00:00Z") });
  fake.tickers = { ADAUSD: "0.145" };
  return fake;
}

/** A fresh "app process": new coordinator, prices and lot services over the same database and Kraken. */
function app(fake: FakeKraken, startIso = "2026-09-24T12:00:00Z") {
  const h = krakenHarness({ fake, accountId: acct, startIso });
  const now = () => new Date(h.clock.now());
  const syncService = new SyncService({ store: new PrismaSyncStore(db), now, config });
  const lots = new LotService(db, config, now);
  const prices = new PriceService(db, new KrakenMarketData(h.client, now), "USD", now);
  const portfolio = new PortfolioService(db, config, lots, prices);
  const coordinator = new SyncCoordinator({
    syncService,
    lots,
    prices,
    heldAssets: (id) => portfolio.heldAssets(id),
    accounts: { accountId: async () => acct, provider: async () => h.provider },
    now,
  });
  return { ...h, syncService, lots, prices, portfolio, coordinator };
}

const lastSync = async () => (await db.providerAccount.findUniqueOrThrow({ where: { id: acct } })).lastSuccessfulSyncAt;

describe("#19 startup recovery", () => {
  it("imports what is missing since the last sync, then rebuilds lots and fetches prices", async () => {
    const fake = seeded();
    expect((await app(fake, "2026-09-20T12:00:00Z").coordinator.syncNow()).ok).toBe(true);
    // Activity while the app was not running, and a run left "running" by a crash.
    fake.addTrade({ txid: "TA0003", pair: "ADAUSD", type: "buy", vol: "100", price: "0.15", time: ks("2026-09-22T00:00:00Z") });
    await db.syncRun.create({ data: { providerAccountId: acct, mode: "manual", status: "running", startedAt: new Date("2026-09-20T13:00:00Z"), syncTo: new Date("2026-09-20T13:00:00Z") } });

    const restarted = app(fake);
    expect(restarted.coordinator.startupPending()).toBe(true);
    const outcome = await restarted.coordinator.startup();
    expect(outcome.ok).toBe(true);
    expect(outcome.sync).toMatchObject({ ok: true, mode: "recovery" });
    // Window: from last success minus the 5-minute overlap.
    expect(outcome.sync!.ok && outcome.sync!.syncFrom?.toISOString()).toBe("2026-09-20T11:55:00.000Z");
    expect(await db.trade.count()).toBe(3);
    expect((await lastSync())?.toISOString()).toBe("2026-09-24T12:00:00.000Z");
    expect(await db.syncRun.count({ where: { status: "interrupted" } })).toBe(1);
    expect(await db.lot.count()).toBe(2);
    expect(outcome.prices).toMatchObject({ ok: true, updated: 1 });

    const ada = (await restarted.portfolio.compute(acct)).positions.find((p) => p.asset === "ADA")!;
    expect([ada.holdings, ada.price]).toEqual(["700", "0.145"]);
    // Runs once per process.
    await restarted.coordinator.startup();
    expect(await db.syncRun.count({ where: { mode: "recovery" } })).toBe(1);
  });
});

describe("#20 sync failure keeps the last stored portfolio usable", () => {
  it("reports the failure, changes nothing stored, and still serves the portfolio from stored data and cached prices", async () => {
    const fake = seeded();
    await app(fake, "2026-09-20T12:00:00Z").coordinator.syncNow();
    const before = await lastSync();

    fake.fail("GetApiKeyInfo", "network", 100);
    fake.fail("Ticker", "network", 100);
    const offline = app(fake);
    const outcome = await offline.coordinator.startup();
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/Kraken sync failed/);
    expect(outcome.sync).toMatchObject({ ok: false, isNetworkError: true });
    expect(outcome.prices?.ok).toBe(false);
    expect(await lastSync()).toEqual(before);
    expect(await db.trade.count()).toBe(2);

    const v = await offline.portfolio.compute(acct);
    const ada = v.positions.find((p) => p.asset === "ADA")!;
    expect([ada.holdings, ada.price, ada.priceAsOf]).toEqual(["600", "0.145", "2026-09-20T12:00:00.000Z"]);
    expect(ada.currentValue).toEqual({ status: "known", value: "87" });
  });
});

describe("#21-22 Sync now", () => {
  it("#21 runs an incremental sync, rebuilds lots and refreshes prices", async () => {
    const fake = seeded();
    const a = app(fake, "2026-09-20T12:00:00Z");
    await a.coordinator.syncNow();
    fake.addTrade({ txid: "TA0003", pair: "ADAUSD", type: "sell", vol: "100", price: "0.30", time: ks("2026-09-20T12:30:00Z") });
    fake.tickers = { ADAUSD: "0.31" };
    a.clock.advance(60 * 60_000);
    const outcome = await a.coordinator.syncNow();
    expect(outcome.sync).toMatchObject({ ok: true, mode: "manual", counts: { trades: { inserted: 1 } } });
    const ada = (await a.portfolio.compute(acct)).positions.find((p) => p.asset === "ADA")!;
    expect([ada.holdings, ada.price]).toEqual(["500", "0.31"]);
  });

  it("#22 concurrent requests share one run (no second sync)", async () => {
    const fake = seeded();
    const a = app(fake);
    const [x, y, z] = await Promise.all([a.coordinator.startup(), a.coordinator.syncNow(), a.coordinator.syncNow()]);
    expect(x).toBe(y);
    expect(y).toBe(z);
    expect(await db.syncRun.count()).toBe(1);
    expect(a.coordinator.isRunning()).toBe(false);
  });
});
