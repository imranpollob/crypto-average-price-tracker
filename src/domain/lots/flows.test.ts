import { describe, expect, it } from "vitest";
import { createAccountingConfig } from "@/domain/accounting/config";
import { deriveAssetFlows } from "@/domain/lots/flows";
import { buy, deposit, flowId, match, scenario, sell, transfer, valuation, withdrawal } from "@/test/builders";
import { expectDecimal, expectIncomplete, expectKnown } from "@/test/expect-metric";

const usd = createAccountingConfig("USD");
const flows = (...args: Parameters<typeof deriveAssetFlows>) => deriveAssetFlows(...args);

describe("asset flows: fees", () => {
  it("buy, fee in quote: cost = gross + fee", () => {
    const [a] = flows([buy("100", "10", { fee: "5" })], [], usd).acquisitions;
    expect(a!.cost).toMatchObject({ status: "known" });
    if (a!.cost.status === "known") {
      expectDecimal(a!.cost.gross, "1000");
      expectDecimal(a!.cost.fee, "5");
    }
    expectDecimal(a!.quantity, "100");
  });

  it("buy, fee in base: fewer units received, total cost = gross", () => {
    const [a] = flows([buy("100", "10", { fee: "0.5", feeAsset: "ADA" })], [], usd).acquisitions;
    expectDecimal(a!.quantity, "99.5");
    if (a!.cost.status === "known") {
      expectDecimal(a!.cost.gross, "995");
      expectDecimal(a!.cost.fee, "5");
    } else throw new Error("expected known cost");
  });

  it("sell, fee in base: extra units leave, net proceeds = gross", () => {
    const [d] = flows([sell("100", "12", { fee: "0.5", feeAsset: "ADA" })], [], usd).disposals;
    expectDecimal(d!.quantity, "100.5");
    if (d!.proceeds?.status === "known") {
      expectDecimal(d!.proceeds.gross, "1206");
      expectDecimal(d!.proceeds.fee, "6");
    } else throw new Error("expected known proceeds");
  });

  it("fee in a third asset makes the value unknown instead of ignoring it", () => {
    const [a] = flows([buy("100", "10", { fee: "1", feeAsset: "KFEE" })], [], usd).acquisitions;
    expect(a!.cost).toEqual({ status: "unknown", reason: "fee_in_other_asset" });
  });

  it("fee-in-base round trip keeps the invariant", () => {
    const b = buy("100", "10", { fee: "1", feeAsset: "ADA" }); // 99 ADA for 1000
    const x = sell("98", "12", { fee: "1", feeAsset: "ADA" }); // 99 ADA leave
    const p = scenario({ trades: [b, x], matches: [match(x, b, "99")] }).position("ADA", "12");
    expectDecimal(p.holdings, "0");
    expectKnown(p.realizedPnl, "176"); // net 1176 − cost 1000
    expectKnown(p.totalPnl, "176");
  });
});

describe("#31 multiple quote currencies", () => {
  it("a lot bought in a non-reporting fiat has unknown cost until valued", () => {
    const u = buy("100", "0.5");
    const e = buy("100", "0.45", { quote: "EUR" });
    const s = scenario({ trades: [u, e] });
    const eurLot = s.engine.lots.find((l) => l.id === flowId(e))!;
    expect(eurLot.costBasisStatus).toBe("unknown");
    expect(eurLot.unknownCostReason).toBe("non_reporting_currency");
    expect(eurLot.priceAsset).toBe("EUR");
    const p = s.position("ADA", "0.6");
    expectDecimal(p.holdings, "200");
    expectKnown(p.currentValue, "120");
    expectIncomplete(p.costBasis, "unknown_cost_basis");

    const valued = scenario({ trades: [u, e], valuations: [valuation(e, "49", "0")] }).position("ADA", "0.6");
    expectKnown(valued.costBasis, "99");
    expectKnown(valued.averageCost, "0.495");
  });

  it("a EUR-reporting portfolio values EUR trades and not USD ones", () => {
    const eur = createAccountingConfig("EUR");
    const [a] = flows([buy("1", "100", { quote: "EUR" })], [], eur).acquisitions;
    const [b] = flows([buy("1", "100", { quote: "USD" })], [], eur).acquisitions;
    expect(a!.cost.status).toBe("known");
    expect(b!.cost.status).toBe("unknown");
  });

  it("a crypto-quoted trade moves both assets: buying ETH with BTC disposes of BTC", () => {
    const btc = buy("1", "30000", { base: "BTC" });
    const eth = buy("10", "0.05", { base: "ETH", quote: "BTC", fee: "0.001", feeAsset: "BTC" });
    const f = flows([btc, eth], [], usd);
    const ethLot = f.acquisitions.find((a) => a.asset === "ETH")!;
    expectDecimal(ethLot.quantity, "10");
    expect(ethLot.cost).toEqual({ status: "unknown", reason: "non_reporting_currency" });
    const btcOut = f.disposals.find((d) => d.asset === "BTC")!;
    expect(btcOut.kind).toBe("sale");
    expect(btcOut.origin).toBe("trade_payment");
    expectDecimal(btcOut.quantity, "0.501"); // 0.5 paid + 0.001 fee

    const s = scenario({ trades: [btc, eth] });
    expectDecimal(s.position("BTC").holdings, "0.499");
    expectDecimal(s.position("ETH").holdings, "10");
    expectIncomplete(s.position("BTC", "30000").realizedPnl, "unmatched_sale", "unknown_proceeds");
  });

  it("selling ETH for BTC acquires BTC", () => {
    const f = flows([sell("2", "0.05", { base: "ETH", quote: "BTC" })], [], usd);
    const btcIn = f.acquisitions.find((a) => a.asset === "BTC")!;
    expect(btcIn.origin).toBe("trade_proceeds");
    expectDecimal(btcIn.quantity, "0.1");
  });

  it("a fiat-only trade creates no lots", () => {
    const f = flows([buy("100", "1.08", { base: "EUR", quote: "USD" })], [], usd);
    expect(f.acquisitions).toHaveLength(0);
    expect(f.disposals).toHaveLength(0);
    expect(f.warnings[0]!.code).toBe("cash_only_trade");
  });

  it("stablecoins are lot-tracked assets, not cash", () => {
    const f = flows([buy("100", "1.0001", { base: "USDC" })], [], usd);
    expect(f.acquisitions[0]!.asset).toBe("USDC");
  });
});

describe("transfers", () => {
  it("deposits create unknown-cost acquisitions; cash deposits are ignored", () => {
    const f = flows([], [deposit("BTC", "1"), deposit("USD", "1000")], usd);
    expect(f.acquisitions).toHaveLength(1);
    expect(f.acquisitions[0]!.cost).toEqual({ status: "unknown", reason: "no_acquisition_price" });
  });

  it("withdrawals are transfer_out disposals with no proceeds", () => {
    const [d] = flows([], [withdrawal("BTC", "1", { fee: "0.0002" })], usd).disposals;
    expect(d!.kind).toBe("transfer_out");
    expect(d!.proceeds).toBeNull();
    expectDecimal(d!.quantity, "1.0002");
  });

  it("rewards are incoming with unknown cost (no staking accounting in V1)", () => {
    const [a] = flows([], [transfer("in", "DOT", "0.5", { kind: "reward" })], usd).acquisitions;
    expect(a!.origin).toBe("reward");
    expect(a!.cost.status).toBe("unknown");
  });
});
