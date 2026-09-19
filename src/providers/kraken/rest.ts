import { ProviderError } from "../types";
import type { KrakenClient } from "./client";
import { toKrakenSeconds } from "./normalizer";
import type {
  KrakenAssetPairsResult,
  KrakenAssetsResult,
  KrakenBalanceResult,
  KrakenLedgerRow,
  KrakenLedgersResult,
  KrakenTradeRow,
  KrakenTradesHistoryResult,
} from "./types";

/**
 * Read-only Kraken endpoints and complete pagination.
 * Call-counter costs: TradesHistory / Ledgers = 2, others = 1.
 */

export const TRADES_PAGE_LIMIT = 100;
/** Safety cap: 20,000 pages ≈ 1–2 million records. */
const MAX_PAGES = 20_000;
/** Full restarts allowed when rows appear at the head during pagination. */
const MAX_PASSES = 3;

export interface HistoryWindow {
  readonly since: Date | null;
  readonly until: Date;
}

/** Kraken `start` is exclusive and `end` inclusive (both whole seconds). */
export function windowParams(w: HistoryWindow): { start?: number; end: number } {
  const end = toKrakenSeconds(w.until);
  return w.since ? { start: toKrakenSeconds(w.since) - 1, end } : { end };
}

export interface Page<Row> {
  readonly rows: ReadonlyArray<readonly [string, Row]>;
  readonly count: number;
}

function parseCount(value: unknown, method: string): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new ProviderError("invalid_response", `Kraken ${method} returned an invalid count`, false);
  }
  return Number(value);
}

function rowsOf<Row>(value: unknown, method: string): Array<[string, Row]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("invalid_response", `Kraken ${method} returned an invalid result`, false);
  }
  return Object.entries(value as Record<string, Row>);
}

/**
 * Offset pagination until every row reported by `count` has been seen.
 *
 * Rows are keyed by Kraken id, so overlaps caused by offsets shifting are
 * harmless. If a page comes back empty before `count` is reached, new rows
 * appeared at the head (newest first) during pagination: restart from offset 0
 * (bounded) to pick them up. Still incomplete → error, never partial data.
 */
export async function paginate<Row>(
  method: string,
  fetchPage: (ofs: number) => Promise<Page<Row>>,
): Promise<Map<string, Row>> {
  const seen = new Map<string, Row>();
  let pages = 0;
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    let ofs = 0;
    let count = Number.POSITIVE_INFINITY;
    while (seen.size < count) {
      if (++pages > MAX_PAGES) {
        throw new ProviderError("invalid_response", `Kraken ${method} pagination exceeded ${MAX_PAGES} pages`, false);
      }
      const page = await fetchPage(ofs);
      count = page.count;
      if (page.rows.length === 0) break;
      for (const [id, row] of page.rows) if (!seen.has(id)) seen.set(id, row);
      ofs += page.rows.length;
    }
    if (seen.size >= count) return seen;
  }
  throw new ProviderError(
    "invalid_response",
    `Kraken ${method} history is incomplete: received ${seen.size} records but more were reported`,
    false,
  );
}

export async function fetchTradesHistory(client: KrakenClient, w: HistoryWindow): Promise<Map<string, KrakenTradeRow>> {
  const range = windowParams(w);
  return paginate<KrakenTradeRow>("TradesHistory", async (ofs) => {
    const r = await client.privatePost<KrakenTradesHistoryResult>(
      "TradesHistory",
      {
        type: "all",
        // Keep every individual execution (Kraken consolidates taker fills by default).
        consolidate_taker: false,
        limit: TRADES_PAGE_LIMIT,
        ofs,
        ...range,
      },
    );
    return { rows: rowsOf<KrakenTradeRow>(r.trades, "TradesHistory"), count: parseCount(r.count, "TradesHistory") };
  });
}

export async function fetchLedgers(client: KrakenClient, w: HistoryWindow): Promise<Map<string, KrakenLedgerRow>> {
  const range = windowParams(w);
  return paginate<KrakenLedgerRow>("Ledgers", async (ofs) => {
    const r = await client.privatePost<KrakenLedgersResult>("Ledgers", { type: "all", ofs, ...range });
    return { rows: rowsOf<KrakenLedgerRow>(r.ledger, "Ledgers"), count: parseCount(r.count, "Ledgers") };
  });
}

export function fetchBalance(client: KrakenClient): Promise<KrakenBalanceResult> {
  return client.privatePost<KrakenBalanceResult>("Balance");
}

export function fetchAssets(client: KrakenClient): Promise<KrakenAssetsResult> {
  return client.publicGet<KrakenAssetsResult>("Assets");
}

export function fetchAssetPairs(client: KrakenClient): Promise<KrakenAssetPairsResult> {
  return client.publicGet<KrakenAssetPairsResult>("AssetPairs");
}
