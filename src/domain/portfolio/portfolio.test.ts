import { describe, expect, it } from "vitest";
import { dec } from "@/domain/decimal";
import { pricesInReportingCurrency } from "@/domain/market/prices";
import { calculatePortfolio } from "@/domain/portfolio/portfolio";
import type { PriceQuote } from "@/domain/transactions/types";
import { buy, deposit, match, scenario, sell } from "@/test/builders";
import { expectDecimal } from "@/test/expect-metric";

const prices = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([k, v]) => [k, dec(v)]));

describe("#30 multiple assets", () => {
  const ada1 = buy("1000", "0.16");
  const ada2 = buy("1000", "0.14");
  const ada3 = buy("1000", "0.12");
  const adaSell = sell("1000", "0.145");
  const btc = buy("0.5", "40000", { base: "BTC", fee: "10" });

  it("computes each asset independently and totals them", () => {
    const s = scenario({ trades: [ada1, ada2, ada3, adaSell, btc], matches: [match(adaSell, ada3, "1000")] });
    const pf = calculatePortfolio({ engine: s.engine, prices: prices({ ADA: "0.145", BTC: "50000" }), reportingCurrency: "USD" });
    expect(pf.positions.map((p) => p.asset)).toEqual(["ADA", "BTC"]);
    // ADA: value 290, basis 300, realized 25, unrealized −10
    // BTC: value 25000, basis 20010, unrealized 4990
    expectDecimal(pf.totalCurrentValue.value, "25290");
    expectDecimal(pf.totalCostBasis.value, "20310");
    expectDecimal(pf.totalRealizedPnl.value, "25");
    expectDecimal(pf.totalUnrealizedPnl.value, "4980");
    expectDecimal(pf.totalPnl.value, "5005");
    for (const t of [pf.totalCurrentValue, pf.totalCostBasis, pf.totalRealizedPnl, pf.totalUnrealizedPnl, pf.totalPnl]) {
      expect(t.complete).toBe(true);
    }
    expect(pf.totalUnrealizedPnlPercent!.toFixed(6)).toBe("24.519941");
    expect(pf.reviewRequired).toBe(false);
  });

  it("only combines valid values and flags incomplete totals", () => {
    const s = scenario({ trades: [ada1, btc], transfers: [deposit("ETH", "2")] });
    const pf = calculatePortfolio({ engine: s.engine, prices: prices({ ADA: "0.2", BTC: "50000" }), reportingCurrency: "USD" });
    // ETH: no price and unknown cost basis
    expect(pf.totalCurrentValue).toMatchObject({ complete: false, excludedAssets: ["ETH"] });
    expectDecimal(pf.totalCurrentValue.value, "25200");
    expect(pf.totalCostBasis).toMatchObject({ complete: false, excludedAssets: ["ETH"] });
    expect(pf.totalPnl.complete).toBe(false);
    expect(pf.totalUnrealizedPnlPercent).toBeNull();
    expect(pf.reviewRequired).toBe(true);
  });
});

describe("price selection", () => {
  const q = (base: string, quote: string, price: string, at: string): PriceQuote => ({
    source: "test",
    baseAsset: base,
    quoteAsset: quote,
    price: dec(price),
    asOf: new Date(at),
  });

  it("uses the latest direct quote in the reporting currency and never cross-converts", () => {
    const m = pricesInReportingCurrency(
      [
        q("ADA", "USD", "0.14", "2026-09-24T10:00:00Z"),
        q("ADA", "USD", "0.15", "2026-09-24T10:01:00Z"),
        q("DOT", "EUR", "4", "2026-09-24T10:01:00Z"),
        q("XYZ", "USD", "0", "2026-09-24T10:01:00Z"),
      ],
      "USD",
    );
    expect(m.get("ADA")!.toFixed()).toBe("0.15");
    expect(m.has("DOT")).toBe(false);
    expect(m.has("XYZ")).toBe(false);
  });
});
