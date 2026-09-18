import type {
  NormalizedLedgerEntry,
  NormalizedTrade,
  NormalizedTransfer,
} from "./types";

/**
 * Stable identities for normalized records. Idempotent imports rely on these:
 * the same provider record always maps to the same key, whether it arrived via
 * REST history, a startup recovery overlap, or a live WebSocket event.
 */

export function tradeKey(t: Pick<NormalizedTrade, "providerAccountId" | "externalTradeId">): string {
  return `trade:${t.providerAccountId}:${t.externalTradeId}`;
}

export function transferKey(
  t: Pick<NormalizedTransfer, "providerAccountId" | "externalTransferId">,
): string {
  return `transfer:${t.providerAccountId}:${t.externalTransferId}`;
}

export function ledgerKey(
  e: Pick<NormalizedLedgerEntry, "providerAccountId" | "externalLedgerId">,
): string {
  return `ledger:${e.providerAccountId}:${e.externalLedgerId}`;
}

export interface DedupeResult<T> {
  readonly unique: T[];
  readonly duplicates: T[];
}

/** Keep the first occurrence of each key; report the rest. Order-preserving. */
export function dedupeBy<T>(records: Iterable<T>, keyOf: (r: T) => string): DedupeResult<T> {
  const seen = new Set<string>();
  const unique: T[] = [];
  const duplicates: T[] = [];
  for (const r of records) {
    const k = keyOf(r);
    if (seen.has(k)) {
      duplicates.push(r);
    } else {
      seen.add(k);
      unique.push(r);
    }
  }
  return { unique, duplicates };
}

/** Records whose key is not in `existingKeys` (after in-batch dedupe). */
export function newRecords<T>(
  records: Iterable<T>,
  existingKeys: ReadonlySet<string>,
  keyOf: (r: T) => string,
): T[] {
  return dedupeBy(records, keyOf).unique.filter((r) => !existingKeys.has(keyOf(r)));
}
