import { DEFAULT_CASH_ASSETS } from "@/domain/accounting/config";
import type {
  AssetCode,
  NormalizedLedgerEntry,
  NormalizedTrade,
  NormalizedTransfer,
} from "@/domain/transactions/types";
import type { KrakenClient } from "./client";
import { KRAKEN_FEE_CREDIT_ASSETS, KrakenAssetMapper } from "./mapper";
import {
  krakenTime,
  linkInstantTrades,
  normalizeLedger,
  normalizeTrades,
  type SkippedTrade,
  type UnlinkedInstant,
} from "./normalizer";
import { fetchAssetPairs, fetchAssets, fetchLedgers, fetchTradesHistory, type HistoryWindow } from "./rest";
import type { KrakenLedgerRow } from "./types";

/**
 * One Kraken history download for a fixed window: trades and ledger are
 * fetched together because trade fees and instant buy/sell/convert
 * transactions are derived from ledger lines. The window end is fixed by the
 * caller, so pagination never chases a moving "now".
 */
export interface KrakenHistory {
  readonly trades: NormalizedTrade[];
  readonly ledgerEntries: NormalizedLedgerEntry[];
  readonly transfers: NormalizedTransfer[];
  readonly skippedTrades: SkippedTrade[];
  readonly unlinkedInstant: UnlinkedInstant[];
}

/** Fiat codes (canonical) used only to orient instant sells; matches the domain's default cash list. */
export const KRAKEN_FIAT_ASSETS: ReadonlySet<AssetCode> = new Set(DEFAULT_CASH_ASSETS);

/** At most this many targeted lookups for spend/receive counterparts per sync. */
const MAX_COUNTERPART_LOOKUPS = 25;
/** Seconds searched on each side of a lone spend/receive line for its counterpart (by refid). */
const COUNTERPART_WINDOW_SECONDS = 60;

export async function loadAssetMapper(client: KrakenClient): Promise<KrakenAssetMapper> {
  const [assets, pairs] = await Promise.all([fetchAssets(client), fetchAssetPairs(client)]);
  return new KrakenAssetMapper(assets, pairs);
}

/**
 * A spend/receive pair can straddle the window boundary. For each lone line,
 * fetch the ledger around its timestamp and add lines with the SAME refid —
 * the link is still made only by Kraken's refid, never by time or amount.
 */
async function completeInstantGroups(client: KrakenClient, rows: Map<string, KrakenLedgerRow>): Promise<void> {
  const byRefid = new Map<string, Set<string>>();
  for (const row of rows.values()) {
    if ((row?.type === "spend" || row?.type === "receive") && typeof row.refid === "string" && row.refid) {
      byRefid.set(row.refid, (byRefid.get(row.refid) ?? new Set()).add(row.type));
    }
  }
  const lone = [...byRefid].filter(([, types]) => types.size === 1).map(([refid]) => refid).slice(0, MAX_COUNTERPART_LOOKUPS);
  for (const refid of lone) {
    const line = [...rows.values()].find((r) => r.refid === refid)!;
    const t = krakenTime(line.time).getTime();
    const around = await fetchLedgers(client, {
      since: new Date(t - COUNTERPART_WINDOW_SECONDS * 1000),
      until: new Date(t + COUNTERPART_WINDOW_SECONDS * 1000),
    });
    for (const [id, row] of around) if (row.refid === refid && !rows.has(id)) rows.set(id, row);
  }
}

export async function fetchKrakenHistory(params: {
  readonly client: KrakenClient;
  readonly mapper: KrakenAssetMapper;
  readonly providerAccountId: string;
  readonly window: HistoryWindow;
}): Promise<KrakenHistory> {
  const tradeRows = await fetchTradesHistory(params.client, params.window);
  const ledgerRows = await fetchLedgers(params.client, params.window);
  await completeInstantGroups(params.client, ledgerRows);

  const ctx = {
    mapper: params.mapper,
    providerAccountId: params.providerAccountId,
    feeCreditAssets: new Set(KRAKEN_FEE_CREDIT_ASSETS),
  };

  const ledgerByRefid = new Map<string, Array<readonly [string, KrakenLedgerRow]>>();
  for (const [id, row] of ledgerRows) {
    // Every line referencing a trade id is evidence about that trade (incl. fee-credit lines).
    if (typeof row?.refid !== "string" || !tradeRows.has(row.refid)) continue;
    const list = ledgerByRefid.get(row.refid) ?? [];
    list.push([id, row]);
    ledgerByRefid.set(row.refid, list);
  }

  const exchange = normalizeTrades({ ...ctx, rows: tradeRows, ledgerByRefid });
  const instant = linkInstantTrades({ ...ctx, rows: ledgerRows, fiatAssets: KRAKEN_FIAT_ASSETS });
  const { entries, transfers } = normalizeLedger({ ...ctx, rows: ledgerRows, linkedLedgerIds: instant.linkedLedgerIds });
  return {
    trades: [...exchange.trades, ...instant.trades],
    ledgerEntries: entries,
    transfers,
    skippedTrades: exchange.skipped,
    unlinkedInstant: instant.unlinked,
  };
}
