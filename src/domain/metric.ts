import type { Decimal } from "./decimal";

/**
 * Why a value cannot be stated as accurate. The UI turns these into
 * "Pending" / "Unavailable" labels and explanations; the engine never
 * substitutes a guessed number.
 */
export type IncompleteReason =
  /** A sale (or part of one) has not been assigned to lots yet. */
  | "unmatched_sale"
  /** A withdrawal / outgoing transfer has not been reviewed / assigned to lots. */
  | "unresolved_transfer_out"
  /** A lot involved has no known acquisition cost (deposit, reward, foreign currency...). */
  | "unknown_cost_basis"
  /** Sale proceeds could not be valued in the reporting currency. */
  | "unknown_proceeds"
  /** A stored lot match is inconsistent with the transaction history. */
  | "invalid_lot_match"
  /** More was disposed than was ever acquired: history is missing. */
  | "insufficient_history"
  /** No current market price is available. */
  | "missing_price";

export type Metric =
  | { readonly status: "known"; readonly value: Decimal }
  /** Mathematically undefined, e.g. average cost of zero holdings. */
  | { readonly status: "not_applicable" }
  | { readonly status: "incomplete"; readonly reasons: readonly IncompleteReason[] };

export const known = (value: Decimal): Metric => ({ status: "known", value });
export const notApplicable: Metric = { status: "not_applicable" };
export const incomplete = (reasons: Iterable<IncompleteReason>): Metric => ({
  status: "incomplete",
  reasons: [...new Set(reasons)].sort(),
});

export function isKnown(m: Metric): m is { status: "known"; value: Decimal } {
  return m.status === "known";
}

/** Value of a known metric, or throw — for tests and code paths that already checked. */
export function valueOf(m: Metric): Decimal {
  if (m.status !== "known") {
    throw new Error(`Metric is not known (status: ${m.status})`);
  }
  return m.value;
}

export function reasonsOf(m: Metric): readonly IncompleteReason[] {
  return m.status === "incomplete" ? m.reasons : [];
}
