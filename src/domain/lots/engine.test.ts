import { describe, expect, it } from "vitest";
import { dec, ZERO } from "@/domain/decimal";
import { candidateLotsFor, validateMatchProposal } from "@/domain/lots/matching";
import { runLotEngine } from "@/domain/lots/engine";
import { deriveAssetFlows } from "@/domain/lots/flows";
import { createAccountingConfig } from "@/domain/accounting/config";
import type { EngineIssue, InvalidMatchProblem } from "@/domain/lots/types";
import { buy, day, deposit, flowId, match, scenario, sell, valuation, withdrawal } from "@/test/builders";
import { expectDecimal } from "@/test/expect-metric";

const problemsOf = (issues: readonly EngineIssue[]): InvalidMatchProblem[] =>
  issues.flatMap((i) => (i.code === "invalid_lot_match" ? [i.problem] : []));

describe("lot engine: lot creation", () => {
  it("records all lot fields for a buy", () => {
    const b = buy("1000", "0.16", { fee: "0.4", at: day(3) });
    const lot = scenario({ trades: [b] }).engine.lots[0]!;
    expect(lot.id).toBe(flowId(b));
    expect(lot.asset).toBe("ADA");
    expect(lot.provider).toBe("test");
    expect(lot.sourceKey).toBe(`trade:acct-1:${b.externalTradeId}`);
    expectDecimal(lot.originalQuantity, "1000");
    expectDecimal(lot.remainingQuantity, "1000");
    expectDecimal(lot.unitPrice, "0.16");
    expectDecimal(lot.acquisitionCost, "160.4");
    expectDecimal(lot.acquisitionFee, "0.4");
    expect(lot.acquiredAt).toEqual(day(3));
    expect(lot.costBasisStatus).toBe("known");
  });

  it("is deterministic: same input, same output", () => {
    const b = buy("3", "7");
    const x = sell("1", "9");
    const a = scenario({ trades: [b, x], matches: [match(x, b, "1", "m1")] });
    const c = scenario({ trades: [b, x], matches: [match(x, b, "1", "m1")] });
    expect(JSON.stringify(a.engine)).toBe(JSON.stringify(c.engine));
  });
});

describe("lot engine: match validation (invalid matches are rejected, never partially applied)", () => {
  it("unknown lot / unknown disposal", () => {
    const b = buy("10", "1");
    const x = sell("5", "2");
    const s = scenario({
      trades: [b, x],
      matches: [
        { id: "a", disposalId: flowId(x), lotId: "nope", quantity: dec("1") },
        { id: "b", disposalId: "nope", lotId: flowId(b), quantity: dec("1") },
      ],
    });
    expect(problemsOf(s.engine.issues).sort()).toEqual(["unknown_disposal", "unknown_lot"]);
    expect(s.engine.allocations).toHaveLength(0);
  });

  it("asset mismatch", () => {
    const b = buy("10", "1", { base: "BTC" });
    const x = sell("5", "2");
    expect(problemsOf(scenario({ trades: [b, x], matches: [match(x, b, "5")] }).engine.issues)).toEqual(["asset_mismatch"]);
  });

  it("account mismatch", () => {
    const b = buy("10", "1", { account: "acct-2" });
    const x = sell("5", "2");
    expect(problemsOf(scenario({ trades: [b, x], matches: [match(x, b, "5")] }).engine.issues)).toEqual(["account_mismatch"]);
  });

  it("a sale cannot close a lot bought after it", () => {
    const x = sell("5", "2", { at: day(1) });
    const b = buy("10", "1", { at: day(2) });
    const s = scenario({ trades: [x, b], matches: [match(x, b, "5")] });
    expect(problemsOf(s.engine.issues)).toEqual(["lot_acquired_after_disposal"]);
  });

  it("non-positive quantity", () => {
    const b = buy("10", "1");
    const x = sell("5", "2");
    expect(problemsOf(scenario({ trades: [b, x], matches: [match(x, b, "0")] }).engine.issues)).toEqual([
      "non_positive_quantity",
    ]);
  });

  it("more than the sale quantity", () => {
    const b = buy("10", "1");
    const x = sell("5", "2");
    expect(problemsOf(scenario({ trades: [b, x], matches: [match(x, b, "6")] }).engine.issues)).toEqual([
      "exceeds_disposal_remaining",
    ]);
  });

  it("more than the lot has left, checked chronologically", () => {
    const b = buy("10", "1");
    const x1 = sell("8", "2");
    const x2 = sell("5", "2");
    const s = scenario({ trades: [b, x1, x2], matches: [match(x2, b, "5"), match(x1, b, "8")] });
    // x1 is earlier, so it is applied first and x2's match no longer fits.
    expect(s.engine.issues.find((i) => i.code === "invalid_lot_match")).toMatchObject({
      disposalId: flowId(x2),
      problem: "exceeds_lot_remaining",
    });
    expectDecimal(s.engine.lots[0]!.remainingQuantity, "2");
  });

  it("invalid matches make lot-based metrics incomplete", () => {
    const b = buy("10", "1");
    const x = sell("5", "2");
    const p = scenario({ trades: [b, x], matches: [match(x, b, "6")] }).position("ADA", "2");
    expect(p.costBasis).toMatchObject({ status: "incomplete" });
    expect(p.realizedPnl).toMatchObject({ status: "incomplete" });
    expect(p.counts.invalidMatches).toBe(1);
  });
});

describe("lot engine: exact conservation", () => {
  it("thirds of a lot: allocations + remainder sum exactly to the original cost", () => {
    const b = buy("3", "33.33", { fee: "0.01" }); // cost 100
    const x1 = sell("1", "40");
    const x2 = sell("1", "40");
    const x3 = sell("1", "40");
    const s = scenario({
      trades: [b, x1, x2, x3],
      matches: [match(x1, b, "1"), match(x2, b, "1"), match(x3, b, "1")],
    });
    const allocated = s.engine.allocations.reduce((a, m) => a.plus(m.allocatedAcquisitionCost!), ZERO);
    expectDecimal(allocated, "100");
    expectDecimal(s.engine.lots[0]!.remainingCost, "0");
    // 1/3 of 100 does not terminate: the first two allocations are quantized,
    // the last one takes the exact remainder.
    expect(s.engine.allocations[0]!.allocatedAcquisitionCost!.toFixed()).toBe(
      "33.333333333333333333333333333333333333",
    );
  });
});

describe("lot engine: history gaps", () => {
  it("flags selling more than was ever acquired", () => {
    const b = buy("10", "1");
    const x = sell("15", "2");
    const s = scenario({ trades: [b, x] });
    expect(s.engine.issues).toContainEqual(
      expect.objectContaining({ code: "insufficient_history", asset: "ADA" }),
    );
    const shortfall = s.engine.issues.find((i) => i.code === "insufficient_history") as { shortfall: { toFixed(): string } };
    expect(shortfall.shortfall.toFixed()).toBe("5");
    const p = s.position("ADA", "2");
    expect(p.currentValue).toMatchObject({ status: "incomplete", reasons: ["insufficient_history"] });
  });

  it("flags a sale before any buy even if later buys cover it", () => {
    const x = sell("5", "2", { at: day(1) });
    const b = buy("10", "1", { at: day(2) });
    expect(scenario({ trades: [x, b] }).engine.issues.map((i) => i.code)).toContain("insufficient_history");
  });
});

describe("lot engine: manual valuations", () => {
  it("reports valuations pointing at nothing without failing", () => {
    const s = scenario({
      trades: [buy("1", "1")],
      valuations: [{ targetId: "ghost", gross: dec("1"), fee: ZERO }],
    });
    expect(s.engine.issues).toContainEqual({ code: "orphan_manual_valuation", targetId: "ghost" });
    expect(s.position().reviewRequired).toBe(false);
  });

  it("can supply unknown proceeds for a sale", () => {
    const b = buy("1", "100", { base: "ETH" });
    const x = sell("1", "0.05", { base: "ETH", quote: "BTC" }); // proceeds in BTC: unknown in USD
    const unvalued = scenario({ trades: [b, x], matches: [match(x, b, "1")] });
    expect(unvalued.position("ETH").realizedPnl).toMatchObject({ status: "incomplete", reasons: ["unknown_proceeds"] });
    const valued = scenario({ trades: [b, x], matches: [match(x, b, "1")], valuations: [valuation(x, "150", "1")] });
    expect(valued.engine.disposals.find((d) => d.disposal.id === flowId(x))!.proceedsSource).toBe("manual");
    expect(valued.position("ETH").realizedPnl).toMatchObject({ status: "known" });
    expectDecimal(valued.engine.allocations[0]!.realizedPnl, "49");
  });

  it("rejects negative manual values", () => {
    expect(() =>
      scenario({ transfers: [deposit("BTC", "1", { id: "d1" })], valuations: [{ targetId: "transfer:acct-1:d1", gross: dec("-1"), fee: ZERO }] }),
    ).toThrow(/negative/);
  });
});

describe("lot engine: input integrity", () => {
  it("throws on duplicate acquisition ids (duplicates must be removed at import)", () => {
    const b = buy("1", "1", { id: "same" });
    const flows = deriveAssetFlows([b, b], [], createAccountingConfig());
    expect(() => runLotEngine({ acquisitions: flows.acquisitions, disposals: [], matches: [] })).toThrow(/Duplicate/);
  });
});

describe("matching helpers", () => {
  it("lists only eligible lots with unclaimed quantity", () => {
    const a = buy("100", "20", { at: day(1) });
    const b = buy("100", "10", { at: day(2) });
    const other = buy("100", "10", { at: day(2), base: "BTC" });
    const x1 = sell("30", "13", { at: day(3) });
    const later = buy("100", "5", { at: day(4) });
    const x2 = sell("50", "13", { at: day(5) });
    const s = scenario({ trades: [a, b, other, x1, later, x2], matches: [match(x2, a, "40")] });
    const c = candidateLotsFor(s.engine, flowId(x1));
    expect(c.map((l) => l.lot.id)).toEqual([flowId(a), flowId(b)]);
    expect(c.map((l) => l.available.toFixed())).toEqual(["60", "100"]);
  });

  it("validates a proposal without mutating state", () => {
    const b = buy("10", "1");
    const x = sell("10", "2");
    const s = scenario({ trades: [b, x] });
    const flows = deriveAssetFlows([b, x], [], createAccountingConfig());
    const input = { acquisitions: flows.acquisitions, disposals: flows.disposals, matches: [] };
    expect(validateMatchProposal(input, [match(x, b, "11", "p1")]).valid).toBe(false);
    const ok = validateMatchProposal(input, [match(x, b, "10", "p2")]);
    expect(ok.valid).toBe(true);
    expect(ok.preview.disposals[0]!.status).toBe("matched");
    expect(s.engine.disposals[0]!.status).toBe("unmatched");
  });

  it("withdrawals are matched against lots the same way", () => {
    const b = buy("2", "10", { base: "BTC" });
    const w = withdrawal("BTC", "1");
    const s = scenario({ trades: [b], transfers: [w] });
    expect(candidateLotsFor(s.engine, flowId(w)).map((c) => c.lot.id)).toEqual([flowId(b)]);
  });
});
