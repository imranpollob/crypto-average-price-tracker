import { describe, expect, it } from "vitest";
import { createAccountingConfig } from "@/domain/accounting/config";
import { dec } from "@/domain/decimal";
import { deriveAssetFlows } from "@/domain/lots/flows";
import type { DataQualityFlag } from "@/domain/lots/types";
import { calculatePortfolio } from "@/domain/portfolio/portfolio";
import { holdingsFromFlows, reconcileBalances, reconciliationFlags } from "@/domain/reconciliation/reconcile";
import type { NormalizedTrade } from "@/domain/transactions/types";
import { ACCOUNT, buy, deposit, PROVIDER, scenario, sell, withdrawal } from "@/test/builders";
import { expectIncomplete, expectKnown } from "@/test/expect-metric";

/**
 * Clarification of spec §13/§15: Total P/L may stay known while sales are
 * unmatched ONLY if every acquisition cost, disposal proceeds and fee is known
 * and the relevant history is complete. Each case below starts from a history
 * whose total is known (−$400 / +$15 baselines) and breaks exactly one input.
 */

const history = () => {
  const l1 = buy("1000", "0.16");
  const l2 = buy("1000", "0.14");
  const l3 = buy("1000", "0.12");
  const x = sell("1000", "0.145"); // never matched in these tests
  return [l1, l2, l3, x];
};

const flag = (asset: string, reason: DataQualityFlag["reason"]): DataQualityFlag => ({
  asset,
  reason,
  detail: "test",
  sourceKey: null,
});

describe("Total P/L with unmatched sales requires complete inputs", () => {
  it("baseline: unmatched sale, everything else known → total known", () => {
    const p = scenario({ trades: history() }).position("ADA", "0.145");
    expectIncomplete(p.realizedPnl, "unmatched_sale");
    expectKnown(p.totalPnl, "15");
  });

  it("unknown acquisition cost (deposit) → incomplete", () => {
    const p = scenario({ trades: history(), transfers: [deposit("ADA", "500")] }).position("ADA", "0.145");
    expectIncomplete(p.totalPnl, "unknown_cost_basis");
  });

  it("unknown acquisition cost (non-reporting currency) → incomplete", () => {
    const p = scenario({ trades: [...history(), buy("10", "0.13", { quote: "EUR" })] }).position("ADA", "0.145");
    expectIncomplete(p.totalPnl, "unknown_cost_basis");
  });

  it("buy fee in a third asset → incomplete, named as an unvalued fee", () => {
    const [l1, l2, , x] = history();
    const feeBuy = buy("1000", "0.12", { fee: "0.01", feeAsset: "KFEE" });
    const p = scenario({ trades: [l1!, l2!, feeBuy, x!] }).position("ADA", "0.145");
    expectIncomplete(p.totalPnl, "unknown_cost_basis", "unvalued_fee");
  });

  it("sell fee in a third asset → incomplete, named as an unvalued fee", () => {
    const [l1, l2, l3] = history();
    const feeSell = sell("1000", "0.145", { fee: "0.01", feeAsset: "KFEE" });
    const p = scenario({ trades: [l1!, l2!, l3!, feeSell] }).position("ADA", "0.145");
    expectIncomplete(p.totalPnl, "unknown_proceeds", "unvalued_fee");
    expectIncomplete(p.realizedPnl, "unknown_proceeds", "unvalued_fee");
  });

  it("unknown proceeds (crypto-quoted sale) → incomplete", () => {
    const p = scenario({ trades: [...history(), sell("10", "0.000002", { quote: "BTC" })] }).position("ADA", "0.145");
    expectIncomplete(p.totalPnl, "unknown_proceeds");
  });

  it("missing history (sold more than ever acquired) → incomplete", () => {
    const p = scenario({ trades: [...history(), sell("2500", "0.15")] }).position("ADA", "0.145");
    expectIncomplete(p.totalPnl, "insufficient_history");
    expectIncomplete(p.currentValue, "insufficient_history");
  });

  it("missing history reported by a data source → incomplete", () => {
    const p = scenario({ trades: history(), flags: [flag("ADA", "insufficient_history")] }).position("ADA", "0.145");
    expectIncomplete(p.totalPnl, "insufficient_history");
  });

  it("unsupported activity affecting the asset → incomplete", () => {
    const p = scenario({ trades: history(), flags: [flag("ADA", "unsupported_activity")] }).position("ADA", "0.145");
    expectIncomplete(p.totalPnl, "unsupported_activity");
    expectIncomplete(p.realizedPnl, "unsupported_activity");
    expectIncomplete(p.costBasis, "unsupported_activity");
    expect(p.reviewRequired).toBe(true);
  });

  it("unresolved reconciliation mismatch → incomplete, and holdings are not trusted for value", () => {
    const trades = history();
    const config = createAccountingConfig("USD");
    const flows = deriveAssetFlows(trades, [], config);
    const report = reconcileBalances({
      calculated: holdingsFromFlows(flows.acquisitions, flows.disposals),
      reported: [
        { provider: PROVIDER, providerAccountId: ACCOUNT, asset: "ADA", total: dec("2400"), available: null, asOf: new Date(), rawData: {} },
      ],
      config,
    });
    expect(report.reconciled).toBe(false);
    const p = scenario({ trades, flags: reconciliationFlags(report) }).position("ADA", "0.145");
    expectIncomplete(p.totalPnl, "reconciliation_mismatch");
    expectIncomplete(p.currentValue, "reconciliation_mismatch");
    expect(p.issues.find((i) => i.code === "data_quality")).toMatchObject({
      reason: "reconciliation_mismatch",
      detail: "Calculated 2000 vs. provider 2400 (difference 400)",
    });
  });

  it("unresolved withdrawal together with an unmatched sale → incomplete", () => {
    const p = scenario({ trades: history(), transfers: [withdrawal("ADA", "100")] }).position("ADA", "0.145");
    expectIncomplete(p.totalPnl, "unresolved_transfer_out");
  });

  it("missing price → incomplete", () => {
    expectIncomplete(scenario({ trades: history() }).position("ADA", null).totalPnl, "missing_price");
  });

  it("flags on another asset do not affect this one", () => {
    const p = scenario({ trades: history(), flags: [flag("BTC", "reconciliation_mismatch")] }).position("ADA", "0.145");
    expectKnown(p.totalPnl, "15");
  });

  it("the same flags also block a fully matched position (not only unmatched ones)", () => {
    const [a, b] = [buy("100", "10"), sell("100", "12")];
    const matched = scenario({
      trades: [a, b],
      matches: [{ id: "m", disposalId: `trade:${ACCOUNT}:${b.externalTradeId}:base`, lotId: `trade:${ACCOUNT}:${a.externalTradeId}:base`, quantity: dec("100") }],
      flags: [flag("ADA", "unsupported_activity")],
    }).position("ADA", "12");
    expectIncomplete(matched.realizedPnl, "unsupported_activity");
    expectIncomplete(matched.totalPnl, "unsupported_activity");
  });
});

describe("fees in an uninvolved asset are never silently ignored", () => {
  it("a trade fee in a third tracked asset flags that asset", () => {
    const f = deriveAssetFlows([buy("10", "1", { fee: "0.5", feeAsset: "KFEE" })], [], createAccountingConfig());
    expect(f.flags).toEqual([expect.objectContaining({ asset: "KFEE", reason: "unvalued_fee" })]);
  });

  it("a withdrawal fee paid in another coin flags the fee coin's figures", () => {
    const btc = buy("1", "30000", { base: "BTC" });
    const ethWithdrawal = { ...withdrawal("ETH", "1"), fee: dec("0.0001"), feeAsset: "BTC" };
    const eth = buy("1", "2000", { base: "ETH" });
    const s = scenario({ trades: [btc, eth], transfers: [ethWithdrawal] });
    const p = s.position("BTC", "40000");
    expectIncomplete(p.totalPnl, "unvalued_fee");
    expectIncomplete(p.costBasis, "unvalued_fee");
  });

  it("a fee in a cash asset is not a data-quality problem", () => {
    const f = deriveAssetFlows([buy("10", "1", { quote: "EUR", fee: "0.5", feeAsset: "USD" })], [], createAccountingConfig());
    expect(f.flags).toEqual([]);
  });

  it("a fee larger than the traded quantity flags the asset", () => {
    const f = deriveAssetFlows([buy("1", "1", { fee: "2", feeAsset: "ADA" })], [], createAccountingConfig());
    expect(f.flags).toEqual([expect.objectContaining({ asset: "ADA", reason: "unsupported_activity" })]);
  });
});

describe("portfolio totals exclude assets with data-quality problems", () => {
  it("lists the flagged asset as excluded from total P/L", () => {
    const trades: NormalizedTrade[] = [...history(), buy("1", "30000", { base: "BTC" })];
    const s = scenario({ trades, flags: [flag("BTC", "unsupported_activity")] });
    const pf = calculatePortfolio({
      engine: s.engine,
      prices: new Map([["ADA", dec("0.145")], ["BTC", dec("40000")]]),
      reportingCurrency: "USD",
    });
    expect(pf.totalPnl).toMatchObject({ complete: false, excludedAssets: ["BTC"] });
    expect(pf.totalPnl.value.toFixed()).toBe("15");
  });
});
