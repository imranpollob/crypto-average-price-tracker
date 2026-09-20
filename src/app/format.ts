import { dec } from "@/domain/decimal";

/**
 * Display formatting only. Values arrive as exact decimal strings and are
 * never rounded for storage or arithmetic; the exact value is kept in `title`.
 */

export function money(value: string | null, signed = false): string {
  if (value === null) return "—";
  const d = dec(value);
  const abs = d.abs();
  // Dust-sized amounts would all print as 0.00; show their significant digits instead.
  const text = abs.isZero() || abs.greaterThanOrEqualTo("0.01") ? abs.toFixed(2) : abs.toSignificantDigits(4).toFixed();
  const sign = d.isNegative() ? "−" : signed && !d.isZero() ? "+" : "";
  return `${sign}$${text}`;
}

export function price(value: string | null, asset: string | null): string {
  if (value === null) return "—";
  const d = dec(value);
  const text = d.greaterThanOrEqualTo(1) ? d.toDecimalPlaces(4).toFixed() : d.toSignificantDigits(6).toFixed();
  return asset && asset !== "USD" ? `${text} ${asset}` : `$${text}`;
}

export function date(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * "trade:<account>:<external id>:<leg>" → external id; "transfer:<account>:<id>" → id.
 * External ids may themselves contain ":" (e.g. "ledger:<spend>+<receive>").
 */
export function shortId(id: string): string {
  const parts = id.split(":");
  if (parts.length < 3) return id;
  if (parts[0] !== "trade") return parts.slice(2).join(":");
  const leg = parts[parts.length - 1];
  const ext = parts.slice(2, -1).join(":");
  return leg === "quote" ? `${ext} (quote)` : ext;
}

export const ORIGIN_LABEL: Record<string, string> = {
  buy: "Buy",
  trade_proceeds: "Received in trade",
  sell: "Sell",
  trade_payment: "Paid in trade",
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  transfer: "Transfer",
  reward: "Reward",
  adjustment: "Provider adjustment (e.g. dust sweep)",
};

export const REASON_LABEL: Record<string, string> = {
  unmatched_sale: "sales not assigned to lots",
  unresolved_transfer_out: "outgoing transfers not assigned to lots",
  unknown_cost_basis: "lots without known cost",
  unknown_proceeds: "sales without known proceeds",
  invalid_lot_match: "invalid lot match",
  insufficient_history: "missing history",
  unvalued_fee: "fee of unknown value",
  unsupported_activity: "unsupported activity",
  reconciliation_mismatch: "balance mismatch",
  ambiguous_automatic_match: "HIFO cannot be determined because an eligible lot has unknown cost basis",
  missing_price: "no current price",
};

export function percent(value: string | null): string {
  if (value === null) return "—";
  const d = dec(value);
  return `${d.isNegative() ? "−" : d.isZero() ? "" : "+"}${d.abs().toFixed(2)}%`;
}

export const METHOD_LABEL: Record<string, string> = { fifo: "FIFO", lifo: "LIFO", hifo: "HIFO" };
