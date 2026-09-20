import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { labelText } from "@/app/position-labels";
import { createAccountingConfig } from "@/domain/accounting/config";
import { dec } from "@/domain/decimal";
import type { AssetCode, NormalizedTrade, NormalizedTransfer } from "@/domain/transactions/types";
import type { CurrentPrices, MarketDataProvider } from "@/providers/types";
import type { Db } from "@/server/db/client";
import { tradeToRow, transferToRow } from "@/server/db/codec";
import { HistoryRepository } from "@/server/db/history-repository";
import { buy, day, deposit, flowId, sell } from "@/test/builders";
import { createTestDb } from "@/test/test-db";
import { LotService } from "./lot-service";
import { PortfolioService, type PositionView } from "./portfolio-service";
import { PriceService } from "./price-service";
import { AUTOMATIC_LOT_MATCHING_METHOD_KEY, SettingsService } from "./settings-service";

/** Automatic lot matching method: setting, precedence, recalculation, labels — against SQLite. */

const config = createAccountingConfig("USD");

class StubSource implements MarketDataProvider {
  readonly source = "kraken";
  calls = 0;
  async getCurrentPrices(assets: readonly AssetCode[], quote: AssetCode): Promise<CurrentPrices> {
    this.calls++;
    return { quotes: assets.map((a) => ({ source: "kraken", baseAsset: a, quoteAsset: quote, price: dec("40"), asOf: new Date() })), unavailable: [] };
  }
}

let db: Db;
let cleanup: () => Promise<void>;
let acct: string;
let lots: LotService;
let settings: SettingsService;
let svc: PortfolioService;
let src: StubSource;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  const repo = new HistoryRepository(db);
  await repo.ensureProvider("kraken", "exchange", "Kraken");
  acct = await repo.createAccount("kraken", "Kraken");
  lots = new LotService(db, config);
  settings = new SettingsService(db);
  src = new StubSource();
  svc = new PortfolioService(db, config, lots, new PriceService(db, src, "USD"), settings);
  // A cached price (no market-data request is ever needed by these tests).
  await db.priceCache.create({ data: { source: "kraken", baseAsset: "ADA", quoteAsset: "USD", price: "40", asOf: new Date() } });
});
afterEach(async () => {
  await cleanup();
});

async function seed(trades: NormalizedTrade[], transfers: NormalizedTransfer[] = []) {
  if (trades.length) await db.trade.createMany({ data: trades.map(tradeToRow) });
  if (transfers.length) await db.transfer.createMany({ data: transfers.map(transferToRow) });
}

const ada = async (): Promise<PositionView> => {
  const v = await svc.compute(acct);
  return [...v.positions, ...v.closed].find((p) => p.asset === "ADA")!;
};
const val = (m: PositionView["realizedPnl"]) => (m.status === "known" ? m.value : m.status);

// Cheap lot first, expensive lot second, then a sale of one lot's worth (built per test for its account).
let cheap: NormalizedTrade;
let dear: NormalizedTrade;
let x: NormalizedTrade;
beforeEach(() => {
  cheap = buy("100", "10", { at: day(1), account: acct });
  dear = buy("100", "30", { at: day(2), account: acct });
  x = sell("100", "40", { at: day(3), account: acct });
});

describe("#29-30 the setting", () => {
  it("#30 an existing installation (no stored setting) uses FIFO", async () => {
    expect(await db.appSetting.count()).toBe(0);
    expect(await settings.automaticLotMatchingMethod()).toBe("fifo");
  });

  it("#29 persists across restarts (a new service over the same database)", async () => {
    await settings.setAutomaticLotMatchingMethod("hifo");
    expect(await new SettingsService(db).automaticLotMatchingMethod()).toBe("hifo");
    expect(await db.appSetting.findUniqueOrThrow({ where: { key: AUTOMATIC_LOT_MATCHING_METHOD_KEY } })).toMatchObject({ value: "hifo" });
  });

  it("rejects unknown values, and ignores a corrupted stored value (default FIFO)", async () => {
    await expect(settings.setAutomaticLotMatchingMethod("avco" as never)).rejects.toThrow(/Unknown/);
    await db.appSetting.create({ data: { key: AUTOMATIC_LOT_MATCHING_METHOD_KEY, value: "avco" } });
    expect(await settings.automaticLotMatchingMethod()).toBe("fifo");
  });
});

describe("#15-18 changing the method", () => {
  it("#16 recalculates the portfolio immediately; #15 automatic matches are never stored; #17 no sync of any kind", async () => {
    await seed([cheap, dear, x]);
    const syncRunsBefore = await db.syncRun.count();
    const account = await db.providerAccount.findUniqueOrThrow({ where: { id: acct } });

    const fifo = await ada();
    expect([val(fifo.realizedPnl), val(fifo.costBasis)]).toEqual(["3000", "3000"]);

    await settings.setAutomaticLotMatchingMethod("lifo");
    const lifo = await ada();
    expect([val(lifo.realizedPnl), val(lifo.costBasis)]).toEqual(["1000", "1000"]);

    await settings.setAutomaticLotMatchingMethod("hifo");
    const hifo = await ada();
    expect([val(hifo.realizedPnl), val(hifo.costBasis)]).toEqual(["1000", "1000"]);

    // Total P/L is the same whichever lots are chosen: only the realized/unrealized split moves.
    expect([fifo, lifo, hifo].map((p) => val(p.totalPnl))).toEqual(["4000", "4000", "4000"]);
    expect(await db.lotMatch.count()).toBe(0);
    expect(await db.syncRun.count()).toBe(syncRunsBefore);
    expect(await db.providerAccount.findUniqueOrThrow({ where: { id: acct } })).toEqual(account);
    expect(src.calls).toBe(0);
  });

  it("#18 saved manual matches survive method changes untouched, and keep precedence", async () => {
    const y = sell("50", "40", { at: day(4), account: acct });
    await seed([cheap, dear, x, y]);
    await lots.saveMatches(acct, flowId(x), [{ lotId: flowId(cheap), quantity: "100" }]);
    const stored = await db.lotMatch.findMany();

    for (const method of ["hifo", "lifo", "fifo", "hifo"] as const) {
      await settings.setAutomaticLotMatchingMethod(method);
      const view = await svc.asset(acct, "ADA");
      // x stays on the cheap lot; only y's quantity is automatic (it can only come from the dear lot).
      expect(view!.automaticMatches.map((m) => [m.disposalId, m.lotId, m.quantity])).toEqual([[flowId(y), flowId(dear), "50"]]);
      expect(await db.lotMatch.findMany()).toEqual(stored);
    }
  });
});

describe("#31-34 labels shown on the dashboard", () => {
  it.each([
    ["fifo", "Automatic: FIFO"],
    ["lifo", "Automatic: LIFO"],
    ["hifo", "Automatic: HIFO"],
  ] as const)("#31-33 %s", async (method, text) => {
    await seed([cheap, dear, x]);
    await settings.setAutomaticLotMatchingMethod(method);
    const p = await ada();
    expect(p.labels).toEqual([{ kind: "automatic", method, withManual: false }]);
    expect(p.labels.map(labelText)).toEqual([text]);
    expect((await svc.compute(acct)).method).toBe(method);
  });

  it("#34 manual + automatic on one asset", async () => {
    await seed([cheap, dear, x]);
    await lots.saveMatches(acct, flowId(x), [{ lotId: flowId(cheap), quantity: "40" }]);
    await settings.setAutomaticLotMatchingMethod("hifo");
    const p = await ada();
    expect(p.matching).toEqual({ manual: true, automatic: true, method: "hifo" });
    expect(p.labels.map(labelText)).toEqual(["Manual + HIFO"]);
  });

  it("only manual matches: no automatic label", async () => {
    await seed([cheap, dear, x]);
    await lots.saveMatches(acct, flowId(x), [{ lotId: flowId(dear), quantity: "100" }]);
    await settings.setAutomaticLotMatchingMethod("lifo");
    const p = await ada();
    expect(p.matching).toEqual({ manual: true, automatic: false, method: "lifo" });
    expect(p.labels.map(labelText)).toEqual(["Complete"]);
  });

  it("#26 HIFO that cannot be determined is explicit, and leaves the P/L totals out", async () => {
    await seed([cheap, x], [deposit("ADA", "50", { account: acct, at: day(2), kind: "reward" })]);
    await settings.setAutomaticLotMatchingMethod("hifo");
    const v = await svc.compute(acct);
    const p = v.positions.find((q) => q.asset === "ADA")!;
    expect(p.labels.map(labelText)[0]).toBe("HIFO cannot be determined — an eligible lot has unknown cost basis");
    expect(p.realizedPnl.status).toBe("incomplete");
    expect(v.totals.realizedPnl.excluded).toEqual(["ADA"]);
    // FIFO can decide (it takes the older, known-cost lot here).
    await settings.setAutomaticLotMatchingMethod("fifo");
    expect(val((await ada()).realizedPnl)).toBe("3000");
  });
});
