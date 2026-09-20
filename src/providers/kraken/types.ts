/**
 * Raw Kraken REST response shapes (see docs/kraken-api-notes.md).
 *
 * Responses are parsed losslessly: every JSON number arrives as its exact
 * source text, so numeric fields (e.g. `time`, `count`) are typed as strings.
 * These types never leave src/providers/kraken/.
 */

export interface KrakenEnvelope<T> {
  readonly error: readonly string[];
  readonly result?: T;
}

export interface KrakenTradeRow {
  readonly ordertxid: string;
  readonly postxid?: string;
  readonly pair: string;
  /** Seconds since epoch with fractional part, e.g. "1688669448.4402". */
  readonly time: string;
  readonly type: string;
  readonly ordertype: string;
  readonly price: string;
  readonly cost: string;
  /** Total fee in quote currency. */
  readonly fee: string;
  readonly vol: string;
  readonly margin: string;
  readonly leverage?: string;
  readonly misc: string;
  readonly ledgers?: readonly string[];
  readonly trade_id?: string;
  readonly maker?: boolean;
  readonly aclass?: string;
  readonly posstatus?: string;
}

export interface KrakenTradesHistoryResult {
  readonly trades: Readonly<Record<string, KrakenTradeRow>>;
  readonly count: string;
}

export interface KrakenLedgerRow {
  readonly refid: string;
  readonly time: string;
  readonly type: string;
  readonly subtype: string;
  readonly aclass: string;
  readonly asset: string;
  /** Signed. */
  readonly amount: string;
  readonly fee: string;
  readonly balance: string;
}

export interface KrakenLedgersResult {
  readonly ledger: Readonly<Record<string, KrakenLedgerRow>>;
  readonly count: string;
}

/** Asset id → balance decimal string. */
export type KrakenBalanceResult = Readonly<Record<string, string>>;

export interface KrakenAssetInfo {
  readonly aclass: string;
  readonly altname: string;
  readonly decimals?: string;
  readonly display_decimals?: string;
  readonly status?: string;
}

export interface KrakenAssetPair {
  readonly altname: string;
  readonly wsname?: string;
  readonly base: string;
  readonly quote: string;
  /** e.g. "online", "cancel_only", "delisted". */
  readonly status?: string;
}

/** Ticker row; `c` = [last trade price, lot volume]. Only the last price is used. */
export interface KrakenTickerRow {
  readonly c?: readonly [string, string];
}

export type KrakenTickerResult = Readonly<Record<string, KrakenTickerRow>>;

export type KrakenAssetsResult = Readonly<Record<string, KrakenAssetInfo>>;
export type KrakenAssetPairsResult = Readonly<Record<string, KrakenAssetPair>>;

export type KrakenTier = "starter" | "intermediate" | "pro";

export interface KrakenCredentials {
  readonly apiKey: string;
  /** Base64-encoded private key. */
  readonly apiSecret: string;
}
