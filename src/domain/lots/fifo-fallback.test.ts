import { describe, expect, it } from "vitest";
import { buy, day, deposit, flowId, match, scenario, sell, withdrawal } from "@/test/builders";
import { createAccountingConfig } from "../accounting/config";
import { dec } from "../decimal";
import { valueOf } from "../metric";
import { calculatePositionMetrics } from "../pnl/position";
import { deriveAssetFlows } from "./flows";
import { isProvisionalMatch, runWithFifoFallback } from "./fifo-fallback";
import type { LotEngineInput, LotMatchInstruction } from "./types";

/** MVP: provisional FIFO for quantity the user has not assigned. */

const config = createAccountingConfig("USD");

function input(params: { trades?: ReturnType<typeof buy>[]; transfers?: ReturnType<typeof deposit>[]; matches?: LotMatchInstruction[] }): LotEngineInput {
  const flows = deriveAssetFlows(params.trades ?? [], params.transfers ?? [], config);
  return { acquisitions: flows.acquisitions, disposals: flows.disposals, matches: params.matches ?? [], dataQualityFlags: flows.flags };
}

const s = (d: { toFixed(): string } | null) => (d === null ? null : d.toFixed());

describe("#10-14 provisional FIFO fallback", () => {
  it("#10 an unmatched sale is assigned oldest lot first, and realized P/L becomes known", () => {
    const a = buy("100", "10", { at: day(1) });
    const b = buy("100", "20", { at: day(2) });
    const x = sell("150", "30", { at: day(3) });
    const { result, provisionalMatchIds } = runWithFifoFallback(input({ trades: [a, b, x] }));
    expect(result.allocations.map((al) => [al.lotId, s(al.quantity), s(al.realizedPnl)])).toEqual([
      [flowId(a), "100", "2000"],
      [flowId(b), "50", "500"],
    ]);
    expect(provisionalMatchIds.size).toBe(2);
    expect([...provisionalMatchIds].every(isProvisionalMatch)).toBe(true);
    const m = calculatePositionMetrics(result, "ADA", dec("30"));
    expect(s(valueOf(m.realizedPnl))).toBe("2500");
    expect(s(valueOf(m.costBasis))).toBe("1000");
  });

  it("#11 a manual match takes precedence over FIFO", () => {
    const a = buy("100", "10", { at: day(1) });
    const b = buy("100", "20", { at: day(2) });
    const x = sell("100", "30", { at: day(3) });
    const manual = match(x, b, "100", "m1");
    const { result, provisionalMatchIds } = runWithFifoFallback(input({ trades: [a, b, x], matches: [manual] }));
    expect(provisionalMatchIds.size).toBe(0);
    expect(result.allocations.map((al) => [al.matchId, al.lotId])).toEqual([["m1", flowId(b)]]);
    expect(s(result.lots.find((l) => l.id === flowId(a))!.remainingQuantity)).toBe("100");
  });

  it("#12 a partly manual sale: the manual part is respected, only the remainder is FIFO", () => {
    const a = buy("100", "10", { at: day(1) });
    const b = buy("100", "20", { at: day(2) });
    const x = sell("100", "30", { at: day(3) });
    const manual = match(x, b, "40", "m1");
    const { result } = runWithFifoFallback(input({ trades: [a, b, x], matches: [manual] }));
    expect(result.allocations.map((al) => [al.matchId.startsWith("fifo:") ? "fifo" : al.matchId, al.lotId, s(al.quantity)])).toEqual([
      ["m1", flowId(b), "40"],
      ["fifo", flowId(a), "60"],
    ]);
    expect(result.disposals[0]!.status).toBe("matched");
  });

  it("#13 the fallback does not change the stored decisions it was given", () => {
    const a = buy("100", "10", { at: day(1) });
    const x = sell("100", "30", { at: day(3) });
    const inp = input({ trades: [a, x] });
    runWithFifoFallback(inp);
    expect(inp.matches).toEqual([]);
  });

  it("never takes quantity a later sale's manual match relies on", () => {
    const a = buy("100", "10", { at: day(1) });
    const b = buy("100", "20", { at: day(2) });
    const early = sell("50", "30", { at: day(3) });
    const later = sell("100", "30", { at: day(4) });
    const manual = match(later, a, "100", "m1");
    const { result } = runWithFifoFallback(input({ trades: [a, b, early, later], matches: [manual] }));
    expect(result.issues.filter((i) => i.code === "invalid_lot_match")).toEqual([]);
    expect(result.allocations.find((al) => al.disposalId === flowId(early))!.lotId).toBe(flowId(b));
  });

  it("never uses a lot acquired after the sale; what cannot be covered stays unmatched", () => {
    const x = sell("50", "30", { at: day(1) });
    const later = buy("100", "10", { at: day(2) });
    const { result, provisionalMatchIds } = runWithFifoFallback(input({ trades: [x, later] }));
    expect(provisionalMatchIds.size).toBe(0);
    expect(result.issues.map((i) => i.code)).toContain("unmatched_sale");
  });

  it("an outgoing transfer is covered too, carrying basis out without proceeds or P/L", () => {
    const a = buy("100", "10", { at: day(1) });
    const w = withdrawal("ADA", "30", { at: day(2) });
    const { result } = runWithFifoFallback(input({ trades: [a], transfers: [w] }));
    const al = result.allocations[0]!;
    expect([al.kind, s(al.allocatedAcquisitionCost), al.grossSaleProceeds, al.realizedPnl]).toEqual(["transfer_out", "300", null, null]);
    const m = calculatePositionMetrics(result, "ADA", dec("12"));
    expect([s(valueOf(m.realizedPnl)), s(valueOf(m.costBasis)), s(valueOf(m.currentValue))]).toEqual(["0", "700", "840"]);
  });

  it("rejects stored ids that collide with the provisional prefix", () => {
    const a = buy("1", "1", { at: day(1) });
    const x = sell("1", "1", { at: day(2) });
    expect(() => runWithFifoFallback(input({ trades: [a, x], matches: [match(x, a, "1", "fifo:evil")] }))).toThrow(/provisional/);
  });
});

describe("#27-28 closed positions", () => {
  it("a fully sold position (via FIFO) has zero holdings, zero value, and realized P/L only", () => {
    const a = buy("10", "10", { at: day(1), fee: "1" });
    const x = sell("10", "15", { at: day(2), fee: "1" });
    const { result } = runWithFifoFallback(input({ trades: [a, x] }));
    // No price needed for a closed position.
    const m = calculatePositionMetrics(result, "ADA", null);
    expect(s(m.holdings)).toBe("0");
    expect([s(valueOf(m.currentValue)), s(valueOf(m.costBasis)), s(valueOf(m.realizedPnl)), s(valueOf(m.totalPnl))]).toEqual(["0", "0", "48", "48"]);
    expect(m.averageCost.status).toBe("not_applicable");
  });

  it("an asset never held has zero holdings and no figures to report", () => {
    const { engine } = scenario({ trades: [buy("1", "1", { at: day(1), base: "BTC" })] });
    const m = calculatePositionMetrics(engine, "ETH", null);
    expect(s(m.holdings)).toBe("0");
    expect(s(valueOf(m.currentValue))).toBe("0");
  });
});

describe("#24 provider precision residuals do not block the portfolio", () => {
  // Sold slightly more than was ever acquired (by less than the provider's precision).
  const a = buy("10", "10", { at: day(1) });
  const x = sell("10.00001", "15", { at: day(2) });

  it("without a tolerance the shortfall makes figures incomplete", () => {
    const { result } = runWithFifoFallback(input({ trades: [a, x] }));
    const m = calculatePositionMetrics(result, "ADA", null);
    expect(m.realizedPnl.status).toBe("incomplete");
  });

  it("with the reconciliation-accepted residual as tolerance, the position is closed and complete", () => {
    const { result } = runWithFifoFallback(input({ trades: [a, x] }));
    const m = calculatePositionMetrics(result, "ADA", null, { residualTolerance: dec("0.00001") });
    expect(s(m.holdings)).toBe("0");
    expect(m.realizedPnl.status).toBe("known");
    expect(m.totalPnl.status).toBe("known");
    expect(m.issues.map((i) => i.code)).not.toContain("insufficient_history");
  });

  it("a larger shortfall is still missing history", () => {
    const { result } = runWithFifoFallback(input({ trades: [a, sell("11", "15", { at: day(3) })] }));
    const m = calculatePositionMetrics(result, "ADA", null, { residualTolerance: dec("0.00001") });
    expect(m.realizedPnl.status).toBe("incomplete");
  });

  it("a tiny positive residual the provider no longer holds needs no price", () => {
    const b = buy("10.00001", "10", { at: day(1) });
    const y = sell("10", "15", { at: day(2) });
    const { result } = runWithFifoFallback(input({ trades: [b, y] }));
    const m = calculatePositionMetrics(result, "ADA", null, { residualTolerance: dec("0.00001") });
    expect(s(m.holdings)).toBe("0");
    expect([m.currentValue.status, m.totalPnl.status]).toEqual(["known", "known"]);
  });

  it("an unknown-cost deposit is not affected by residual tolerance", () => {
    const { result } = runWithFifoFallback(input({ transfers: [deposit("ADA", "5", { at: day(1) })] }));
    const m = calculatePositionMetrics(result, "ADA", dec("2"), { residualTolerance: dec("0.00001") });
    expect(s(valueOf(m.currentValue))).toBe("10");
    expect(m.costBasis.status).toBe("incomplete");
  });
});
