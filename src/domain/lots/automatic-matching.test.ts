import { describe, expect, it } from "vitest";
import { buy, day, deposit, flowId, match, scenario, sell, withdrawal } from "@/test/builders";
import { createAccountingConfig } from "../accounting/config";
import { dec } from "../decimal";
import { valueOf } from "../metric";
import { calculatePositionMetrics } from "../pnl/position";
import { deriveAssetFlows } from "./flows";
import { isAutomaticMatch, runWithAutomaticMatching } from "./automatic-matching";
import type { LotEngineInput, LotMatchInstruction } from "./types";

/** Automatic lot matching (FIFO/LIFO/HIFO) for quantity the user has not assigned. */

const config = createAccountingConfig("USD");

function input(params: { trades?: ReturnType<typeof buy>[]; transfers?: ReturnType<typeof deposit>[]; matches?: LotMatchInstruction[] }): LotEngineInput {
  const flows = deriveAssetFlows(params.trades ?? [], params.transfers ?? [], config);
  return { acquisitions: flows.acquisitions, disposals: flows.disposals, matches: params.matches ?? [], dataQualityFlags: flows.flags };
}

const s = (d: { toFixed(): string } | null) => (d === null ? null : d.toFixed());

describe("FIFO (the MVP default) — unchanged behaviour", () => {
  it("#10 an unmatched sale is assigned oldest lot first, and realized P/L becomes known", () => {
    const a = buy("100", "10", { at: day(1) });
    const b = buy("100", "20", { at: day(2) });
    const x = sell("150", "30", { at: day(3) });
    const { result, automaticMatchIds } = runWithAutomaticMatching(input({ trades: [a, b, x] }), "fifo");
    expect(result.allocations.map((al) => [al.lotId, s(al.quantity), s(al.realizedPnl)])).toEqual([
      [flowId(a), "100", "2000"],
      [flowId(b), "50", "500"],
    ]);
    expect(automaticMatchIds.size).toBe(2);
    expect([...automaticMatchIds].every(isAutomaticMatch)).toBe(true);
    const m = calculatePositionMetrics(result, "ADA", dec("30"));
    expect(s(valueOf(m.realizedPnl))).toBe("2500");
    expect(s(valueOf(m.costBasis))).toBe("1000");
  });

  it("#11 a manual match takes precedence over FIFO", () => {
    const a = buy("100", "10", { at: day(1) });
    const b = buy("100", "20", { at: day(2) });
    const x = sell("100", "30", { at: day(3) });
    const manual = match(x, b, "100", "m1");
    const { result, automaticMatchIds } = runWithAutomaticMatching(input({ trades: [a, b, x], matches: [manual] }), "fifo");
    expect(automaticMatchIds.size).toBe(0);
    expect(result.allocations.map((al) => [al.matchId, al.lotId])).toEqual([["m1", flowId(b)]]);
    expect(s(result.lots.find((l) => l.id === flowId(a))!.remainingQuantity)).toBe("100");
  });

  it("#12 a partly manual sale: the manual part is respected, only the remainder is FIFO", () => {
    const a = buy("100", "10", { at: day(1) });
    const b = buy("100", "20", { at: day(2) });
    const x = sell("100", "30", { at: day(3) });
    const manual = match(x, b, "40", "m1");
    const { result } = runWithAutomaticMatching(input({ trades: [a, b, x], matches: [manual] }), "fifo");
    expect(result.allocations.map((al) => [al.matchId.startsWith("auto:") ? "fifo" : al.matchId, al.lotId, s(al.quantity)])).toEqual([
      ["m1", flowId(b), "40"],
      ["fifo", flowId(a), "60"],
    ]);
    expect(result.disposals[0]!.status).toBe("matched");
  });

  it("#13 the fallback does not change the stored decisions it was given", () => {
    const a = buy("100", "10", { at: day(1) });
    const x = sell("100", "30", { at: day(3) });
    const inp = input({ trades: [a, x] });
    runWithAutomaticMatching(inp, "fifo");
    expect(inp.matches).toEqual([]);
  });

  it("never takes quantity a later sale's manual match relies on", () => {
    const a = buy("100", "10", { at: day(1) });
    const b = buy("100", "20", { at: day(2) });
    const early = sell("50", "30", { at: day(3) });
    const later = sell("100", "30", { at: day(4) });
    const manual = match(later, a, "100", "m1");
    const { result } = runWithAutomaticMatching(input({ trades: [a, b, early, later], matches: [manual] }), "fifo");
    expect(result.issues.filter((i) => i.code === "invalid_lot_match")).toEqual([]);
    expect(result.allocations.find((al) => al.disposalId === flowId(early))!.lotId).toBe(flowId(b));
  });

  it("never uses a lot acquired after the sale; what cannot be covered stays unmatched", () => {
    const x = sell("50", "30", { at: day(1) });
    const later = buy("100", "10", { at: day(2) });
    const { result, automaticMatchIds } = runWithAutomaticMatching(input({ trades: [x, later] }), "fifo");
    expect(automaticMatchIds.size).toBe(0);
    expect(result.issues.map((i) => i.code)).toContain("unmatched_sale");
  });

  it("an outgoing transfer is covered too, carrying basis out without proceeds or P/L", () => {
    const a = buy("100", "10", { at: day(1) });
    const w = withdrawal("ADA", "30", { at: day(2) });
    const { result } = runWithAutomaticMatching(input({ trades: [a], transfers: [w] }), "fifo");
    const al = result.allocations[0]!;
    expect([al.kind, s(al.allocatedAcquisitionCost), al.grossSaleProceeds, al.realizedPnl]).toEqual(["transfer_out", "300", null, null]);
    const m = calculatePositionMetrics(result, "ADA", dec("12"));
    expect([s(valueOf(m.realizedPnl)), s(valueOf(m.costBasis)), s(valueOf(m.currentValue))]).toEqual(["0", "700", "840"]);
  });

  it("rejects stored ids that collide with the provisional prefix", () => {
    const a = buy("1", "1", { at: day(1) });
    const x = sell("1", "1", { at: day(2) });
    expect(() => runWithAutomaticMatching(input({ trades: [a, x], matches: [match(x, a, "1", "auto:evil")] }), "fifo")).toThrow(/automatic prefix/);
  });
});

describe("#27-28 closed positions", () => {
  it("a fully sold position (via FIFO) has zero holdings, zero value, and realized P/L only", () => {
    const a = buy("10", "10", { at: day(1), fee: "1" });
    const x = sell("10", "15", { at: day(2), fee: "1" });
    const { result } = runWithAutomaticMatching(input({ trades: [a, x] }), "fifo");
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
    const { result } = runWithAutomaticMatching(input({ trades: [a, x] }), "fifo");
    const m = calculatePositionMetrics(result, "ADA", null);
    expect(m.realizedPnl.status).toBe("incomplete");
  });

  it("with the reconciliation-accepted residual as tolerance, the position is closed and complete", () => {
    const { result } = runWithAutomaticMatching(input({ trades: [a, x] }), "fifo");
    const m = calculatePositionMetrics(result, "ADA", null, { residualTolerance: dec("0.00001") });
    expect(s(m.holdings)).toBe("0");
    expect(m.realizedPnl.status).toBe("known");
    expect(m.totalPnl.status).toBe("known");
    expect(m.issues.map((i) => i.code)).not.toContain("insufficient_history");
  });

  it("a larger shortfall is still missing history", () => {
    const { result } = runWithAutomaticMatching(input({ trades: [a, sell("11", "15", { at: day(3) })] }), "fifo");
    const m = calculatePositionMetrics(result, "ADA", null, { residualTolerance: dec("0.00001") });
    expect(m.realizedPnl.status).toBe("incomplete");
  });

  it("a tiny positive residual the provider no longer holds needs no price", () => {
    const b = buy("10.00001", "10", { at: day(1) });
    const y = sell("10", "15", { at: day(2) });
    const { result } = runWithAutomaticMatching(input({ trades: [b, y] }), "fifo");
    const m = calculatePositionMetrics(result, "ADA", null, { residualTolerance: dec("0.00001") });
    expect(s(m.holdings)).toBe("0");
    expect([m.currentValue.status, m.totalPnl.status]).toEqual(["known", "known"]);
  });

  it("an unknown-cost deposit is not affected by residual tolerance", () => {
    const { result } = runWithAutomaticMatching(input({ transfers: [deposit("ADA", "5", { at: day(1) })] }), "fifo");
    const m = calculatePositionMetrics(result, "ADA", dec("2"), { residualTolerance: dec("0.00001") });
    expect(s(valueOf(m.currentValue))).toBe("10");
    expect(m.costBasis.status).toBe("incomplete");
  });
});

// --- method selection ----------------------------------------------------------

type Method = "fifo" | "lifo" | "hifo";
const run = (inp: LotEngineInput, method: Method) => runWithAutomaticMatching(inp, method);
/** [lot id, quantity] of the automatic allocations, in allocation order. */
const picks = (r: ReturnType<typeof run>) =>
  r.result.allocations.filter((al) => r.automaticMatchIds.has(al.matchId)).map((al) => [al.lotId, s(al.quantity)]);

describe("LIFO and HIFO selection", () => {
  it("#2 LIFO takes the newest eligible lot", () => {
    const a = buy("100", "10", { at: day(1) });
    const b = buy("100", "20", { at: day(2) });
    const x = sell("50", "30", { at: day(3) });
    expect(picks(run(input({ trades: [a, b, x] }), "lifo"))).toEqual([[flowId(b), "50"]]);
  });

  it("#3 HIFO takes the highest-cost lot", () => {
    const a = buy("100", "20", { at: day(1) });
    const b = buy("100", "10", { at: day(2) });
    const c = buy("100", "15", { at: day(3) });
    const x = sell("50", "30", { at: day(4) });
    expect(picks(run(input({ trades: [a, b, c, x] }), "hifo"))).toEqual([[flowId(a), "50"]]);
  });

  it("#4-6 across several lots, each method consumes in its own order (partial last lot)", () => {
    const a = buy("100", "10", { at: day(1) });
    const b = buy("100", "30", { at: day(2) });
    const c = buy("100", "20", { at: day(3) });
    const x = sell("250", "40", { at: day(4) });
    const inp = input({ trades: [a, b, c, x] });
    expect(picks(run(inp, "fifo"))).toEqual([[flowId(a), "100"], [flowId(b), "100"], [flowId(c), "50"]]);
    expect(picks(run(inp, "lifo"))).toEqual([[flowId(c), "100"], [flowId(b), "100"], [flowId(a), "50"]]);
    expect(picks(run(inp, "hifo"))).toEqual([[flowId(b), "100"], [flowId(c), "100"], [flowId(a), "50"]]);
  });

  it("#7 HIFO compares effective unit cost including fees, not the execution price", () => {
    const a = buy("100", "10", { at: day(1), fee: "10" }); // 1010 / 100 = 10.10
    const b = buy("100", "10.05", { at: day(2) }); // 10.05
    const x = sell("100", "12", { at: day(3) });
    expect(picks(run(input({ trades: [a, b, x] }), "hifo"))).toEqual([[flowId(a), "100"]]);
  });

  it("#8 HIFO ties: equal unit cost, then earlier lot, then lower id", () => {
    const t = day(1);
    const early = buy("10", "5", { at: day(0) });
    const b = buy("10", "5", { at: t, id: "TIE-B" });
    const a = buy("10", "5", { at: t, id: "TIE-A" });
    const x = sell("25", "6", { at: day(2) });
    expect(picks(run(input({ trades: [early, b, a, x] }), "hifo"))).toEqual([[flowId(early), "10"], [flowId(a), "10"], [flowId(b), "5"]]);
  });

  it("#9-10 FIFO and LIFO ties at the same timestamp are broken by lot id", () => {
    const t = day(1);
    const b = buy("10", "5", { at: t, id: "TIE-B" });
    const a = buy("10", "6", { at: t, id: "TIE-A" });
    const x = sell("5", "7", { at: day(2) });
    const inp = input({ trades: [b, a, x] });
    expect(picks(run(inp, "fifo"))).toEqual([[flowId(a), "5"]]);
    expect(picks(run(inp, "lifo"))).toEqual([[flowId(a), "5"]]);
    // Deterministic: the same input always gives the same result.
    expect(picks(run(inp, "lifo"))).toEqual(picks(run(inp, "lifo")));
  });

  it("#28 a later-acquired higher-cost lot is not eligible for an earlier sale, even under HIFO", () => {
    const a = buy("100", "10", { at: day(1) });
    const x = sell("50", "30", { at: day(2) });
    const later = buy("100", "99", { at: day(3) });
    expect(picks(run(input({ trades: [a, x, later] }), "hifo"))).toEqual([[flowId(a), "50"]]);
    expect(picks(run(input({ trades: [a, x, later] }), "lifo"))).toEqual([[flowId(a), "50"]]);
  });
});

describe("#11-14 manual matches take precedence over every method", () => {
  const a = buy("100", "10", { at: day(1) });
  const b = buy("100", "30", { at: day(2) });
  const c = buy("100", "20", { at: day(3) });
  const x = sell("100", "40", { at: day(4) });

  it.each<[Method]>([["fifo"], ["lifo"], ["hifo"]])("#11-13 a fully manual sale is untouched by %s", (method) => {
    const r = run(input({ trades: [a, b, c, x], matches: [match(x, c, "100", "m1")] }), method);
    expect(r.automaticMatchIds.size).toBe(0);
    expect(r.result.allocations.map((al) => [al.matchId, al.lotId])).toEqual([["m1", flowId(c)]]);
  });

  it.each<[Method, "a" | "b" | "c"]>([
    ["fifo", "a"],
    ["lifo", "c"],
    ["hifo", "b"],
  ])("#14 partly manual: %s assigns only the remainder, never the manually reserved quantity", (method, expected) => {
    // 40 manually from c (which keeps 60): the method then picks from what is left.
    const r = run(input({ trades: [a, b, c, x], matches: [match(x, c, "40", "m1")] }), method);
    expect(r.result.allocations[0]).toMatchObject({ matchId: "m1", lotId: flowId(c) });
    expect(picks(r)).toEqual([[flowId({ a, b, c }[expected]), "60"]]);
    expect(r.result.issues.filter((i) => i.code === "invalid_lot_match")).toEqual([]);
  });
});

describe("#19-23 outgoing transfers use the selected method without creating P/L", () => {
  const a = buy("100", "10", { at: day(1) });
  const b = buy("100", "30", { at: day(2) });
  const c = buy("100", "20", { at: day(3) });

  it.each<[Method, number, string, string]>([
    ["fifo", 0, "1000", "5000"],
    ["lifo", 2, "2000", "4000"],
    ["hifo", 1, "3000", "3000"],
  ])("#19-21 a withdrawal under %s removes that lot's basis", (method, lotIndex, removed, left) => {
    const w = withdrawal("ADA", "100", { at: day(4) });
    const r = run(input({ trades: [a, b, c], transfers: [w] }), method);
    const al = r.result.allocations[0]!;
    expect([al.lotId, al.kind, s(al.allocatedAcquisitionCost)]).toEqual([flowId([a, b, c][lotIndex]!), "transfer_out", removed]);
    // #22 no proceeds, no realized trading P/L: the basis leaves with the transfer.
    expect([al.grossSaleProceeds, al.netSaleProceeds, al.realizedPnl]).toEqual([null, null, null]);
    const m = calculatePositionMetrics(r.result, "ADA", dec("25"));
    expect([s(valueOf(m.realizedPnl)), s(valueOf(m.costBasis))]).toEqual(["0", left]);
  });

  it("#23 a dust-sweep adjustment follows the selected method", () => {
    const dust = withdrawal("ADA", "0.00053", { at: day(4), kind: "adjustment" });
    const lifo = run(input({ trades: [a, b, c], transfers: [dust] }), "lifo");
    const hifo = run(input({ trades: [a, b, c], transfers: [dust] }), "hifo");
    expect(picks(lifo)).toEqual([[flowId(c), "0.00053"]]);
    expect(picks(hifo)).toEqual([[flowId(b), "0.00053"]]);
    expect(lifo.result.allocations[0]!.realizedPnl).toBeNull();
  });
});

describe("#24-27 unknown-cost lots", () => {
  const known = buy("100", "10", { at: day(1) });
  const reward = deposit("ADA", "50", { at: day(2), kind: "reward", id: "RWD" });
  const x = sell("40", "20", { at: day(3) });

  it("#24 FIFO orders by time and takes the known lot first here", () => {
    const r = run(input({ trades: [known, x], transfers: [reward] }), "fifo");
    expect(picks(r)).toEqual([[flowId(known), "40"]]);
    expect(s(valueOf(calculatePositionMetrics(r.result, "ADA", dec("20")).realizedPnl))).toBe("400");
  });

  it("#24 FIFO consumes an older unknown-cost lot rather than skipping it; figures become incomplete", () => {
    const oldReward = deposit("ADA", "50", { at: day(0), kind: "reward", id: "OLD" });
    const r = run(input({ trades: [known, x], transfers: [oldReward] }), "fifo");
    expect(picks(r)).toEqual([[flowId(oldReward), "40"]]);
    const m = calculatePositionMetrics(r.result, "ADA", dec("20"));
    expect(m.realizedPnl).toEqual({ status: "incomplete", reasons: ["unknown_cost_basis"] });
    expect(s(valueOf(m.currentValue))).toBe("2200");
  });

  it("#25 LIFO consumes the newer unknown-cost lot; the quantity is assigned but its cost is unknown", () => {
    const r = run(input({ trades: [known, x], transfers: [reward] }), "lifo");
    expect(picks(r)).toEqual([[flowId(reward), "40"]]);
    const m = calculatePositionMetrics(r.result, "ADA", dec("20"));
    expect(m.realizedPnl).toEqual({ status: "incomplete", reasons: ["unknown_cost_basis"] });
    expect(s(valueOf(m.currentValue))).toBe("2200");
  });

  it("#26 HIFO leaves a sale unassigned and flags it when an eligible lot's cost is unknown", () => {
    const r = run(input({ trades: [known, x], transfers: [reward] }), "hifo");
    expect(picks(r)).toEqual([]);
    expect([...r.undeterminedDisposalIds]).toEqual([flowId(x)]);
    const flag = r.result.issues.find((i) => i.code === "data_quality");
    expect(flag).toMatchObject({ reason: "ambiguous_automatic_match", detail: "HIFO cannot be determined because an eligible lot has unknown cost basis." });
    const m = calculatePositionMetrics(r.result, "ADA", dec("20"));
    expect(m.realizedPnl.status === "incomplete" && m.realizedPnl.reasons).toContain("ambiguous_automatic_match");
    expect(m.totalPnl.status).toBe("incomplete");
    // Quantity and current value do not depend on the ranking.
    expect(s(valueOf(m.currentValue))).toBe("2200");
  });

  describe("#27 HIFO is determined when the unknown-cost lot cannot affect the outcome", () => {
    it("the unknown-cost lot was acquired after the sale", () => {
      const later = deposit("ADA", "50", { at: day(4), kind: "reward" });
      const r = run(input({ trades: [known, x], transfers: [later] }), "hifo");
      expect(picks(r)).toEqual([[flowId(known), "40"]]);
      expect(s(valueOf(calculatePositionMetrics(r.result, "ADA", null).realizedPnl))).toBe("400");
    });

    it("the unknown-cost lot is fully reserved by a manual match", () => {
      const early = sell("50", "20", { at: day(2) });
      const oldReward = deposit("ADA", "50", { at: day(1), kind: "reward", id: "R1" });
      const unreserved = run(input({ trades: [known, early, x], transfers: [oldReward] }), "hifo");
      expect(unreserved.undeterminedDisposalIds.size).toBe(2);
      const reserved = run(
        input({ trades: [known, early, x], transfers: [oldReward], matches: [match(early, oldReward, "50", "m1")] }),
        "hifo",
      );
      expect(reserved.undeterminedDisposalIds.size).toBe(0);
      expect(picks(reserved)).toEqual([[flowId(known), "40"]]);
    });

    it("the disposal consumes every eligible lot entirely, so order is irrelevant", () => {
      const all = sell("150", "20", { at: day(3) });
      const r = run(input({ trades: [known, all], transfers: [reward] }), "hifo");
      expect(r.undeterminedDisposalIds.size).toBe(0);
      expect(picks(r).map(([, q]) => q).sort()).toEqual(["100", "50"]);
    });

    it("a manually valued lot ranks like any known-cost lot", () => {
      const inp = input({ trades: [known, x], transfers: [reward] });
      const valued = { ...inp, manualValuations: [{ targetId: flowId(reward), gross: dec("1500"), fee: dec("0") }] }; // 30 per unit
      const r = run(valued, "hifo");
      expect(picks(r)).toEqual([[flowId(reward), "40"]]);
      expect(s(valueOf(calculatePositionMetrics(r.result, "ADA", null).realizedPnl))).toBe("-400");
    });
  });
});
