import type {
  NormalizedBalance,
  NormalizedLedgerEntry,
  NormalizedTrade,
  NormalizedTransfer,
} from "./types";

/**
 * Structural validation of normalized records before they are persisted.
 * Adapters should already produce valid records; this is the last line of
 * defence against malformed provider responses corrupting local history.
 */

export interface RecordProblem {
  readonly record: string;
  readonly problem: string;
}

function isValidDate(d: Date): boolean {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

export function validateTrade(t: NormalizedTrade, accountId: string): string[] {
  const p: string[] = [];
  if (t.providerAccountId !== accountId) p.push("belongs to another account");
  if (!t.externalTradeId) p.push("missing external trade id");
  if (!t.baseAsset || !t.quoteAsset) p.push("missing asset");
  if (t.baseAsset === t.quoteAsset) p.push("base and quote asset are identical");
  if (t.side !== "buy" && t.side !== "sell") p.push("invalid side");
  if (!t.quantity.greaterThan(0)) p.push("quantity must be positive");
  if (!t.price.greaterThan(0)) p.push("price must be positive");
  if (t.grossValue.isNegative()) p.push("gross value must not be negative");
  if (t.fee.isNegative()) p.push("fee must not be negative");
  if (!t.fee.isZero() && !t.feeAsset) p.push("fee asset missing for non-zero fee");
  if (!isValidDate(t.executedAt)) p.push("invalid execution time");
  return p;
}

export function validateTransfer(t: NormalizedTransfer, accountId: string): string[] {
  const p: string[] = [];
  if (t.providerAccountId !== accountId) p.push("belongs to another account");
  if (!t.externalTransferId) p.push("missing external transfer id");
  if (!t.asset) p.push("missing asset");
  if (t.direction !== "in" && t.direction !== "out") p.push("invalid direction");
  if (t.quantity.isNegative()) p.push("quantity must not be negative");
  if (t.fee.isNegative()) p.push("fee must not be negative");
  if (!t.fee.isZero() && !t.feeAsset) p.push("fee asset missing for non-zero fee");
  if (!isValidDate(t.occurredAt)) p.push("invalid time");
  return p;
}

export function validateLedgerEntry(e: NormalizedLedgerEntry, accountId: string): string[] {
  const p: string[] = [];
  if (e.providerAccountId !== accountId) p.push("belongs to another account");
  if (!e.externalLedgerId) p.push("missing external ledger id");
  if (!e.asset) p.push("missing asset");
  if (e.fee.isNegative()) p.push("fee must not be negative");
  if (!isValidDate(e.occurredAt)) p.push("invalid time");
  return p;
}

export function validateBalance(b: NormalizedBalance, accountId: string): string[] {
  const p: string[] = [];
  if (b.providerAccountId !== accountId) p.push("belongs to another account");
  if (!b.asset) p.push("missing asset");
  if (b.total.isNegative()) p.push("total must not be negative");
  if (!isValidDate(b.asOf)) p.push("invalid time");
  return p;
}

export function validateBatch(
  batch: {
    readonly trades: readonly NormalizedTrade[];
    readonly transfers: readonly NormalizedTransfer[];
    readonly ledgerEntries: readonly NormalizedLedgerEntry[];
    readonly balances: readonly NormalizedBalance[];
  },
  accountId: string,
): RecordProblem[] {
  const out: RecordProblem[] = [];
  const collect = (record: string, problems: string[]) => {
    for (const problem of problems) out.push({ record, problem });
  };
  for (const t of batch.trades) collect(`trade ${t.externalTradeId}`, validateTrade(t, accountId));
  for (const t of batch.transfers) collect(`transfer ${t.externalTransferId}`, validateTransfer(t, accountId));
  for (const e of batch.ledgerEntries) collect(`ledger ${e.externalLedgerId}`, validateLedgerEntry(e, accountId));
  for (const b of batch.balances) collect(`balance ${b.asset}`, validateBalance(b, accountId));
  return out;
}
