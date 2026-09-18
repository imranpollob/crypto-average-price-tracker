import { type Decimal, sum } from "../decimal";
import { runLotEngine } from "./engine";
import type { EngineIssue, Lot, LotEngineInput, LotEngineResult, LotMatchInstruction } from "./types";

export interface CandidateLot {
  readonly lot: Lot;
  /** Quantity that can still be assigned without conflicting with any other match. */
  readonly available: Decimal;
}

/**
 * Lots a disposal may be matched against: same asset and account, acquired no
 * later than the disposal, with quantity not already claimed by any other match.
 * Using the final remaining quantity (after all existing matches, earlier or
 * later) guarantees a new assignment can never invalidate an existing one.
 */
export function candidateLotsFor(result: LotEngineResult, disposalId: string): CandidateLot[] {
  const state = result.disposals.find((d) => d.disposal.id === disposalId);
  if (!state) return [];
  const d = state.disposal;
  return result.lots
    .filter(
      (lot) =>
        lot.asset === d.asset &&
        lot.providerAccountId === d.providerAccountId &&
        lot.acquiredAt.getTime() <= d.disposedAt.getTime() &&
        lot.remainingQuantity.greaterThan(0),
    )
    .map((lot) => ({ lot, available: lot.remainingQuantity }));
}

export interface ProposalValidation {
  readonly valid: boolean;
  /** Problems caused by the proposed matches (pre-existing issues are excluded). */
  readonly problems: readonly EngineIssue[];
  /** Engine result as it would be if the proposal were saved. */
  readonly preview: LotEngineResult;
}

/**
 * Check a set of new match instructions against the current state by running
 * the engine with them added. Nothing is persisted; callers save only when valid.
 */
export function validateMatchProposal(
  input: LotEngineInput,
  proposal: readonly LotMatchInstruction[],
): ProposalValidation {
  const existingIds = new Set(input.matches.map((m) => m.id));
  for (const p of proposal) {
    if (existingIds.has(p.id)) throw new Error(`Proposed match id already exists: ${p.id}`);
  }
  const proposedIds = new Set(proposal.map((p) => p.id));
  const preview = runLotEngine({ ...input, matches: [...input.matches, ...proposal] });
  const problems = preview.issues.filter(
    (i) => i.code === "invalid_lot_match" && proposedIds.has(i.matchId),
  );
  return { valid: problems.length === 0, problems, preview };
}

/** Total quantity matched so far for a disposal. */
export function matchedQuantity(result: LotEngineResult, disposalId: string): Decimal {
  return sum(result.allocations.filter((a) => a.disposalId === disposalId).map((a) => a.quantity));
}
