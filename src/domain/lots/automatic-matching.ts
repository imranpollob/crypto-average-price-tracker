import { type Decimal, min, sum } from "../decimal";
import { runLotEngine } from "./engine";
import type { DataQualityFlag, Lot, LotEngineInput, LotEngineResult, LotMatchInstruction } from "./types";

/**
 * Automatic lot matching for quantity the user has not assigned to lots.
 *
 * A calculation fallback, not a user decision: its matches exist only in the
 * returned result, are never persisted, and never override a manual match.
 * Every figure that depends on it is labelled with the method used.
 *
 * Covered: sales and outgoing transfers. A transfer-out only moves cost basis
 * out of the open position; it never creates proceeds or P/L.
 *
 * Manual matches are applied first. Then, disposal by disposal in the engine's
 * chronological order, the unassigned quantity is taken from eligible lots —
 * same account and asset, acquired no later than the disposal, with quantity
 * no manual match claims (a lot's remaining quantity after ALL manual matches,
 * earlier or later), so no manual match can be invalidated — in the order of
 * the selected method:
 *
 *   fifo  oldest acquisition first                        (acquiredAt ↑, id ↑)
 *   lifo  newest acquisition first                        (acquiredAt ↓, id ↑)
 *   hifo  highest effective unit cost first               (remaining cost / remaining quantity ↓,
 *         (cost includes acquisition fees)                  acquiredAt ↑, id ↑)
 *
 * FIFO and LIFO order by time, so an unknown-cost lot takes its place like any
 * other; consuming it leaves the dependent figures incomplete (unknown cost).
 * HIFO cannot rank a lot whose cost is unknown — it is not treated as zero,
 * infinite, highest or lowest. A disposal is left unassigned and flagged when
 * the outcome could depend on that ranking: whenever an unknown-cost lot is
 * eligible, unless the disposal consumes every eligible lot entirely (then
 * the order is irrelevant) or there is only one eligible lot.
 */

export type AutomaticMatchingMethod = "fifo" | "lifo" | "hifo";

export const AUTOMATIC_MATCHING_METHODS: readonly AutomaticMatchingMethod[] = ["fifo", "lifo", "hifo"];

export function isAutomaticMatchingMethod(value: unknown): value is AutomaticMatchingMethod {
  return typeof value === "string" && (AUTOMATIC_MATCHING_METHODS as readonly string[]).includes(value);
}

export const AUTOMATIC_MATCH_PREFIX = "auto:";

export interface AutomaticMatchingResult {
  readonly method: AutomaticMatchingMethod;
  readonly result: LotEngineResult;
  /** Ids of automatic matches in `result.allocations` (they start with AUTOMATIC_MATCH_PREFIX). */
  readonly automaticMatchIds: ReadonlySet<string>;
  /** Disposals HIFO could not assign because an eligible lot's cost is unknown. */
  readonly undeterminedDisposalIds: ReadonlySet<string>;
}

export function isAutomaticMatch(matchId: string): boolean {
  return matchId.startsWith(AUTOMATIC_MATCH_PREFIX);
}

const byId = (a: Lot, b: Lot) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byTime = (a: Lot, b: Lot) => a.acquiredAt.getTime() - b.acquiredAt.getTime();

export function runWithAutomaticMatching(input: LotEngineInput, method: AutomaticMatchingMethod): AutomaticMatchingResult {
  for (const m of input.matches) {
    if (isAutomaticMatch(m.id)) throw new Error(`Stored match id uses the automatic prefix: ${m.id}`);
  }
  const manual = runLotEngine(input);

  const unclaimed = new Map<string, Decimal>(manual.lots.map((l) => [l.id, l.remainingQuantity]));
  // Automatic allocation is proportional, so a lot's unit cost does not change as it is consumed.
  const unitCost = new Map<string, Decimal | null>(
    manual.lots.map((l) => [
      l.id,
      l.remainingCost !== null && l.remainingQuantity.greaterThan(0) ? l.remainingCost.dividedBy(l.remainingQuantity) : null,
    ]),
  );
  const lotsByPosition = new Map<string, Lot[]>();
  for (const lot of manual.lots) {
    const k = `${lot.providerAccountId}\u0000${lot.asset}`;
    const list = lotsByPosition.get(k) ?? [];
    list.push(lot);
    lotsByPosition.set(k, list);
  }

  const order = (lots: Lot[]): Lot[] => {
    switch (method) {
      case "fifo":
        return lots.sort((a, b) => byTime(a, b) || byId(a, b));
      case "lifo":
        return lots.sort((a, b) => byTime(b, a) || byId(a, b));
      case "hifo":
        return lots.sort((a, b) => unitCost.get(b.id)!.comparedTo(unitCost.get(a.id)!) || byTime(a, b) || byId(a, b));
    }
  };

  const automatic: LotMatchInstruction[] = [];
  const undetermined = new Set<string>();
  const flags: DataQualityFlag[] = [];
  // manual.disposals is in chronological application order.
  for (const state of manual.disposals) {
    let need = state.unmatchedQuantity;
    if (!need.greaterThan(0)) continue;
    const d = state.disposal;
    const eligible = (lotsByPosition.get(`${d.providerAccountId}\u0000${d.asset}`) ?? []).filter(
      (lot) => lot.acquiredAt.getTime() <= d.disposedAt.getTime() && unclaimed.get(lot.id)!.greaterThan(0),
    );
    if (eligible.length === 0) continue;

    if (method === "hifo" && eligible.length > 1 && eligible.some((lot) => unitCost.get(lot.id) === null)) {
      if (need.lessThan(sum(eligible.map((lot) => unclaimed.get(lot.id)!)))) {
        undetermined.add(d.id);
        flags.push({
          asset: d.asset,
          reason: "ambiguous_automatic_match",
          detail: "HIFO cannot be determined because an eligible lot has unknown cost basis.",
          sourceKey: d.sourceKey,
        });
        continue;
      }
    }
    // HIFO with an unknown-cost lot only gets here when every eligible lot is
    // consumed entirely (or there is just one), so any fixed order gives the same result.
    const ranked =
      method === "hifo" && eligible.some((lot) => unitCost.get(lot.id) === null) ? eligible.sort((a, b) => byTime(a, b) || byId(a, b)) : order(eligible);

    let n = 0;
    for (const lot of ranked) {
      const available = unclaimed.get(lot.id)!;
      const take = min(available, need);
      automatic.push({ id: `${AUTOMATIC_MATCH_PREFIX}${d.id}:${n++}`, disposalId: d.id, lotId: lot.id, quantity: take });
      unclaimed.set(lot.id, available.minus(take));
      need = need.minus(take);
      if (need.isZero()) break;
    }
  }

  if (automatic.length === 0 && flags.length === 0) {
    return { method, result: manual, automaticMatchIds: new Set(), undeterminedDisposalIds: undetermined };
  }
  return {
    method,
    result: runLotEngine({
      ...input,
      matches: [...input.matches, ...automatic],
      dataQualityFlags: [...(input.dataQualityFlags ?? []), ...flags],
    }),
    automaticMatchIds: new Set(automatic.map((m) => m.id)),
    undeterminedDisposalIds: undetermined,
  };
}
