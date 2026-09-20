import { type Decimal, min } from "../decimal";
import { runLotEngine } from "./engine";
import type { Lot, LotEngineInput, LotEngineResult, LotMatchInstruction } from "./types";

/**
 * Provisional FIFO for quantity the user has not assigned to lots.
 *
 * This is a calculation fallback, not a user decision: its matches exist only
 * in the returned result, are never persisted, and never override a manual
 * match. It lets the portfolio show complete figures while hundreds of
 * historical sales are still unreviewed — every figure that depends on it is
 * labelled as estimated. FIFO is not assumed to be the user's strategy.
 *
 * Covered: sales and outgoing transfers (a transfer-out only moves cost basis
 * out of the open position; it never creates proceeds or P/L).
 *
 * Manual matches are applied first. The fallback then walks disposals in the
 * engine's chronological order and takes the oldest lots first, using only
 * quantity no manual match claims (a lot's remaining quantity after ALL manual
 * matches, earlier or later). That guarantees no manual match is invalidated.
 */

export const PROVISIONAL_MATCH_PREFIX = "fifo:";

export interface FifoFallbackResult {
  readonly result: LotEngineResult;
  /** Ids of provisional matches in `result.allocations` (they start with PROVISIONAL_MATCH_PREFIX). */
  readonly provisionalMatchIds: ReadonlySet<string>;
}

export function isProvisionalMatch(matchId: string): boolean {
  return matchId.startsWith(PROVISIONAL_MATCH_PREFIX);
}

export function runWithFifoFallback(input: LotEngineInput): FifoFallbackResult {
  for (const m of input.matches) {
    if (isProvisionalMatch(m.id)) throw new Error(`Stored match id uses the provisional prefix: ${m.id}`);
  }
  const manual = runLotEngine(input);

  const unclaimed = new Map<string, Decimal>(manual.lots.map((l) => [l.id, l.remainingQuantity]));
  // manual.lots is sorted by (acquiredAt, id): the FIFO order.
  const lotsByPosition = new Map<string, Lot[]>();
  for (const lot of manual.lots) {
    const k = `${lot.providerAccountId}\u0000${lot.asset}`;
    const list = lotsByPosition.get(k) ?? [];
    list.push(lot);
    lotsByPosition.set(k, list);
  }

  const provisional: LotMatchInstruction[] = [];
  // manual.disposals is in chronological application order.
  for (const state of manual.disposals) {
    let need = state.unmatchedQuantity;
    if (!need.greaterThan(0)) continue;
    const d = state.disposal;
    let n = 0;
    for (const lot of lotsByPosition.get(`${d.providerAccountId}\u0000${d.asset}`) ?? []) {
      if (lot.acquiredAt.getTime() > d.disposedAt.getTime()) break;
      const available = unclaimed.get(lot.id)!;
      if (!available.greaterThan(0)) continue;
      const take = min(available, need);
      provisional.push({ id: `${PROVISIONAL_MATCH_PREFIX}${d.id}:${n++}`, disposalId: d.id, lotId: lot.id, quantity: take });
      unclaimed.set(lot.id, available.minus(take));
      need = need.minus(take);
      if (need.isZero()) break;
    }
  }

  if (provisional.length === 0) return { result: manual, provisionalMatchIds: new Set() };
  return {
    result: runLotEngine({ ...input, matches: [...input.matches, ...provisional] }),
    provisionalMatchIds: new Set(provisional.map((p) => p.id)),
  };
}
