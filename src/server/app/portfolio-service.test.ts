import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccountingConfig } from "@/domain/accounting/config";
import { dec } from "@/domain/decimal";
import type { AssetCode, NormalizedTrade, NormalizedTransfer } from "@/domain/transactions/types";
import type { CurrentPrices, MarketDataProvider } from "@/providers/types";
import type { Db } from "@/server/db/client";
import { tradeToRow, transferToRow } from "@/server/db/codec";
import { HistoryRepository } from "@/server/db/history-repository";
import { buy, day, deposit, flowId, sell, withdrawal } from "@/test/builders";
import { createTestDb } from "@/test/test-db";
import { LotService } from "./lot-service";
import { type PortfolioView, PortfolioService, type PositionView } from "./portfolio-service";
import { PriceService } from "./price-service";
import { SettingsService } from "./settings-service";

/** MVP portfolio figures against a real SQLite database. */

const config = createAccountingConfig("USD");

class StubSource implements MarketDataProvider {
  readonly source = "kraken";
  prices: Record<string, string> = {};
  async getCurrentPrices(assets: readonly AssetCode[], quote: AssetCode): Promise<CurrentPrices> {
    return {
      quotes: assets.filter((a) => this.prices[a]).map((a) => ({ source: "kraken", baseAsset: a, quoteAsset: quote, price: dec(this.prices[a]!), asOf: new Date() })),
      unavailable: assets.filter((a) => !this.prices[a]).map((a) => ({ asset: a, reason: "no_direct_market" as const })),
    };
  }
}

let db: Db;
let cleanup: () => Promise<void>;
let acct: string;
let src: StubSource;
let lots: LotService;
let prices: PriceService;
let svc: PortfolioService;
let settings: SettingsService;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  const repo = new HistoryRepository(db);
  await repo.ensureProvider("kraken", "exchange", "Kraken");
  acct = await repo.createAccount("kraken", "Kraken");
  src = new StubSource();
  lots = new LotService(db, config);
  prices = new PriceService(db, src, "USD");
  settings = new SettingsService(db);
  svc = new PortfolioService(db, config, lots, prices, settings);
});
afterEach(async () => {
  await cleanup();
});

async function seed(trades: NormalizedTrade[], transfers: NormalizedTransfer[] = []) {
  if (trades.length) await db.trade.createMany({ data: trades.map(tradeToRow) });
  if (transfers.length) await db.transfer.createMany({ data: transfers.map(transferToRow) });
}

/** Fetch prices for everything held, then compute. */
async function compute(p: Record<string, string>): Promise<PortfolioView> {
  src.prices = p;
  await prices.refresh(await svc.heldAssets(acct));
  return svc.compute(acct);
}

const pos = (v: PortfolioView, asset: string): PositionView => [...v.positions, ...v.closed].find((p) => p.asset === asset)!;
const val = (m: PositionView["currentValue"]) => (m.status === "known" ? m.value : m.status);
const kinds = (p: PositionView) => p.labels.map((l) => l.kind);

describe("#5-9 current value and P/L", () => {
  it("#5 current value = holdings × current price", async () => {
    await seed([buy("2000", "0.15", { account: acct })]);
    const p = pos(await compute({ ADA: "0.145" }), "ADA");
    expect([p.price, p.holdings, val(p.currentValue), val(p.averageCost), val(p.costBasis)]).toEqual(["0.145", "2000", "290", "0.15", "300"]);
  });

  it("#6 unrealized gain and #8 its percentage, with the buy fee in the cost basis", async () => {
    await seed([buy("100", "10", { account: acct, fee: "5" })]);
    const p = pos(await compute({ ADA: "12" }), "ADA");
    expect([val(p.costBasis), val(p.unrealizedPnl)]).toEqual(["1005", "195"]);
    // 195 / 1005 × 100
    expect(val(p.unrealizedPnlPercent)).toMatch(/^19\.402985074626865671/);
    expect(kinds(p)).toEqual(["complete"]);
  });

  it("#7 unrealized loss", async () => {
    await seed([buy("100", "10", { account: acct })]);
    const p = pos(await compute({ ADA: "8" }), "ADA");
    expect([val(p.unrealizedPnl), val(p.unrealizedPnlPercent)]).toEqual(["-200", "-20"]);
  });

  it("#9 total P/L = realized + unrealized (fees included)", async () => {
    await seed([buy("100", "10", { account: acct, fee: "1" }), sell("40", "15", { account: acct, fee: "2" })]);
    const p = pos(await compute({ ADA: "12" }), "ADA");
    // Lot cost 1001. FIFO: 40 of it (cost 400.4) sold for 598 net → +197.6; open 60 cost 600.6, value 720 → +119.4.
    expect([val(p.realizedPnl), val(p.unrealizedPnl), val(p.totalPnl)]).toEqual(["197.6", "119.4", "317"]);
  });
});

describe("#10-14, #30 FIFO fallback in the portfolio", () => {
  it("#14 figures from provisional FIFO are labelled; #13 nothing is persisted as a user decision", async () => {
    await seed([buy("100", "10", { account: acct }), sell("100", "13", { account: acct })]);
    const v = await compute({});
    const p = pos(v, "ADA");
    expect(val(p.realizedPnl)).toBe("300");
    expect(p.matching).toEqual({ manual: false, automatic: true, method: "fifo" });
    expect(p.labels).toEqual([{ kind: "automatic", method: "fifo", withManual: false }]);
    expect([v.method, v.automaticAssets]).toEqual(["fifo", 1]);
    expect(await db.lotMatch.count()).toBe(0);
  });

  it("#30 a saved manual match immediately replaces FIFO in the portfolio", async () => {
    const cheap = buy("100", "10", { account: acct, at: day(1) });
    const dear = buy("100", "20", { account: acct, at: day(2) });
    const x = sell("100", "25", { account: acct, at: day(3) });
    await seed([cheap, dear, x]);
    let p = pos(await compute({ ADA: "25" }), "ADA");
    expect([val(p.realizedPnl), val(p.costBasis), p.matching.automatic]).toEqual(["1500", "2000", true]);

    await lots.saveMatches(acct, flowId(x), [{ lotId: flowId(dear), quantity: "100" }]);
    p = pos(await svc.compute(acct), "ADA");
    expect([val(p.realizedPnl), val(p.costBasis), p.matching.automatic]).toEqual(["500", "1000", false]);
    expect(kinds(p)).toEqual(["complete"]);
    // Total P/L does not depend on which lot was chosen.
    expect(val(p.totalPnl)).toBe("2000");
  });

  it("#12 a partly manual sale: FIFO only covers the unassigned remainder", async () => {
    const a = buy("100", "10", { account: acct, at: day(1) });
    const b = buy("100", "20", { account: acct, at: day(2) });
    const x = sell("100", "25", { account: acct, at: day(3) });
    await seed([a, b, x]);
    await lots.saveMatches(acct, flowId(x), [{ lotId: flowId(b), quantity: "40" }]);
    const view = await svc.asset(acct, "ADA");
    expect(view!.automaticMatches.map((m) => [m.lotId, m.quantity])).toEqual([[flowId(a), "60"]]);
    expect(view!.position.realizedPnl).toEqual({ status: "known", value: "1100" });
    expect(await db.lotMatch.count()).toBe(1);
  });
});

describe("#15-18 incomplete cost basis and totals", () => {
  it("#15/#16 an unknown-cost deposit keeps P/L incomplete but still has current value", async () => {
    await seed([], [deposit("BTC", "1", { account: acct })]);
    const v = await compute({ BTC: "112500" });
    const p = pos(v, "BTC");
    expect(val(p.currentValue)).toBe("112500");
    for (const m of [p.costBasis, p.averageCost, p.unrealizedPnl, p.totalPnl]) expect(m).toEqual({ status: "incomplete", reasons: ["unknown_cost_basis"] });
    expect(p.labels).toEqual([{ kind: "cost_basis_incomplete", lotsNeedingValuation: 1 }]);
    expect(v.totals.currentValue).toEqual({ value: "112500", excluded: [] });
    expect(v.totals.totalPnl).toEqual({ value: "0", excluded: ["BTC"] });
  });

  it("#17 totals add complete assets", async () => {
    await seed([buy("100", "10", { account: acct }), buy("2", "1000", { account: acct, base: "ETH" })]);
    const v = await compute({ ADA: "11", ETH: "1500" });
    expect(v.totals.currentValue).toEqual({ value: "4100", excluded: [] });
    expect(v.totals.costBasis).toEqual({ value: "3000", excluded: [] });
    expect(v.totals.unrealizedPnl).toEqual({ value: "1100", excluded: [] });
    expect(v.totals.totalPnl).toEqual({ value: "1100", excluded: [] });
  });

  it("#18 P/L totals leave out incomplete assets and say so; value still counts them", async () => {
    await seed([buy("100", "10", { account: acct })], [deposit("BTC", "1", { account: acct })]);
    const v = await compute({ ADA: "11", BTC: "100000" });
    expect(v.totals.currentValue).toEqual({ value: "101100", excluded: [] });
    expect(v.totals.costBasis).toEqual({ value: "1000", excluded: ["BTC"] });
    expect(v.totals.totalPnl).toEqual({ value: "100", excluded: ["BTC"] });
  });

  it("valuing the deposit completes it", async () => {
    const d = deposit("BTC", "1", { account: acct });
    await seed([], [d]);
    await lots.setValuation(acct, { type: "acquisition", key: flowId(d) }, "90000", "0");
    const p = pos(await compute({ BTC: "100000" }), "BTC");
    expect([val(p.costBasis), val(p.unrealizedPnl), kinds(p)]).toEqual(["90000", "10000", ["complete"]]);
  });
});

describe("#24, #26-29 realistic account", () => {
  it("#26 multi-asset account: positions, closed positions, cash, missing markets, precision residuals", async () => {
    const trades = [
      buy("2000", "0.15", { account: acct, base: "ADA", at: day(1), fee: "0.3" }),
      buy("0.01", "60000", { account: acct, base: "BTC", at: day(2), fee: "1.56" }),
      buy("1000", "0.02", { account: acct, base: "DOGE", at: day(3) }),
      sell("1000", "0.03", { account: acct, base: "DOGE", at: day(4) }),
      // B3: Kraken sold slightly more than was bought (precision residual, accepted by reconciliation).
      buy("100", "0.5", { account: acct, base: "B3", at: day(5) }),
      sell("100.00001", "0.6", { account: acct, base: "B3", at: day(6) }),
      buy("10", "1", { account: acct, base: "BRICK", at: day(7) }),
    ];
    await seed(trades, [withdrawal("ADA", "500", { account: acct, at: day(8) })]);
    const run = await db.syncRun.create({
      data: { providerAccountId: acct, mode: "initial", status: "succeeded", startedAt: day(9), syncTo: day(9), finishedAt: day(9) },
    });
    await db.balanceSnapshot.create({ data: { providerAccountId: acct, syncRunId: run.id, asset: "USD", total: "5043.67", asOf: day(9), rawJson: "{}" } });
    await db.reconciliationResult.create({
      data: { syncRunId: run.id, providerAccountId: acct, asset: "B3", calculated: "-0.00001", reported: "0", difference: "0.00001", status: "reconciled_within_precision" },
    });

    const v = await compute({ ADA: "0.145", BTC: "112500" });
    expect(v.positions.map((p) => p.asset)).toEqual(["ADA", "BRICK", "BTC"]);
    expect(v.closed.map((p) => p.asset)).toEqual(["B3", "DOGE"]);
    expect(v.cash).toEqual([{ asset: "USD", total: "5043.67" }]);

    // ADA: 1500 left after the FIFO-estimated withdrawal of 500 (basis 75.075 leaves with it, not a loss).
    const ada = pos(v, "ADA");
    expect([ada.holdings, val(ada.currentValue), val(ada.costBasis), val(ada.realizedPnl), val(ada.unrealizedPnl)]).toEqual([
      "1500",
      "217.5",
      "225.225",
      "0",
      "-7.725",
    ]);
    expect(kinds(ada)).toEqual(["automatic"]);

    // #29 BRICK has no USD market: no value, no fabricated price.
    const brick = pos(v, "BRICK");
    expect([brick.price, brick.currentValue.status]).toEqual([null, "incomplete"]);
    expect(brick.labels[0]).toEqual({ kind: "price_unavailable", reason: "no_direct_market" });
    expect(v.totals.currentValue.excluded).toEqual(["BRICK"]);

    // #24 B3's residual is within Kraken precision: closed and complete, included in totals.
    const b3 = pos(v, "B3");
    // 100 matched units: 60 proceeds − 50 cost. The 0.00001 residual has no lot and no P/L.
    expect([b3.holdings, val(b3.realizedPnl), val(b3.totalPnl)]).toEqual(["0", "10", "10"]);
    expect(v.totals.realizedPnl.excluded).toEqual([]);

    // #27 DOGE: fully closed, realized only, no price needed.
    const doge = pos(v, "DOGE");
    expect([doge.holdings, val(doge.currentValue), val(doge.realizedPnl), doge.price]).toEqual(["0", "0", "10", null]);

    // #28 an asset with no history at all is simply absent.
    expect(pos(v, "ETH")).toBeUndefined();
    expect(await svc.asset(acct, "ETH")).toBeNull();
  });
});
