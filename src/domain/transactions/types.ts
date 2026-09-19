import type { Decimal } from "../decimal";

/**
 * Normalized internal records.
 *
 * Every data source (Kraken, Coinbase, on-chain wallets...) is converted into
 * these shapes by its own adapter. Nothing downstream of the adapters — lot
 * engine, P/L, persistence, UI — may look at provider response formats.
 *
 * Conventions:
 *  - Asset codes are canonical upper-case tickers ("BTC", "ETH", "USD"). Mapping
 *    provider-specific codes (e.g. Kraken's "XXBT") is the adapter's job.
 *  - Quantities and amounts are non-negative Decimals unless documented as signed.
 *  - `rawData` is the untouched provider payload, kept for audit and reprocessing.
 */

/** Stable identifier of a provider implementation: "kraken", "coinbase", "wallet-evm"... */
export type ProviderType = string;

/** Canonical asset code, e.g. "BTC", "ADA", "USD". */
export type AssetCode = string;

export interface NormalizedRecordBase {
  readonly provider: ProviderType;
  /** Internal id of the connected account the record belongs to. */
  readonly providerAccountId: string;
  /** Original provider payload, untouched. */
  readonly rawData: unknown;
}

export type TradeSide = "buy" | "sell";

/** One spot trade execution (a fill), from the account's point of view. */
export interface NormalizedTrade extends NormalizedRecordBase {
  readonly externalTradeId: string;
  readonly externalOrderId: string | null;
  readonly baseAsset: AssetCode;
  readonly quoteAsset: AssetCode;
  readonly side: TradeSide;
  /** Base-asset quantity executed. */
  readonly quantity: Decimal;
  /** Price per unit of base, in quote asset. */
  readonly price: Decimal;
  /** quantity × price, in quote asset, as reported by the provider. */
  readonly grossValue: Decimal;
  /** Fee amount, denominated in `feeAsset`. */
  readonly fee: Decimal;
  /** Asset the fee was charged in; null only when fee is zero. */
  readonly feeAsset: AssetCode | null;
  readonly executedAt: Date;
  /**
   * "exchange": an execution reported by the provider's trade history.
   * "ledger": derived by the adapter from deterministically linked ledger
   * records (e.g. instant buy/sell/convert). Default "exchange".
   */
  readonly origin?: TradeOrigin;
  /** Where the fee figure comes from (diagnostics; the domain does not depend on it). */
  readonly feeSource?: FeeSource;
}

export type TradeOrigin = "exchange" | "ledger";

/**
 * - ledger: as charged in the account ledger (actual balance change)
 * - fee_credit: paid with a provider fee credit
 * - trade_record: from the provider's trade record; ledger evidence unavailable
 * - ledger_uncharged: the trade record reports a fee, but the ledger shows none charged
 */
export type FeeSource = "ledger" | "fee_credit" | "trade_record" | "ledger_uncharged";

export type TransferDirection = "in" | "out";

/**
 * Kinds of non-trade balance movements.
 *  - deposit / withdrawal: funding in or out of the account
 *  - transfer: movement between the user's own accounts/sub-accounts
 *  - reward: staking/earn/airdrop style credits (no advanced staking accounting in V1)
 *  - adjustment: provider-side corrections
 */
export type TransferKind = "deposit" | "withdrawal" | "transfer" | "reward" | "adjustment";

/**
 * A movement of an asset into or out of the account that is not a trade.
 * Deposits are NOT buys; withdrawals are NOT sales.
 */
export interface NormalizedTransfer extends NormalizedRecordBase {
  readonly externalTransferId: string;
  readonly direction: TransferDirection;
  readonly kind: TransferKind;
  readonly asset: AssetCode;
  /** Gross amount moved (fee reported separately). */
  readonly quantity: Decimal;
  readonly fee: Decimal;
  readonly feeAsset: AssetCode | null;
  readonly occurredAt: Date;
  /** On-chain transaction hash when known — enables future wallet transfer matching. */
  readonly txHash: string | null;
}

export type NormalizedDeposit = NormalizedTransfer & { readonly direction: "in"; readonly kind: "deposit" };
export type NormalizedWithdrawal = NormalizedTransfer & { readonly direction: "out"; readonly kind: "withdrawal" };

export type LedgerEntryType =
  | "trade"
  | "deposit"
  | "withdrawal"
  | "transfer"
  | "reward"
  | "fee"
  | "adjustment"
  | "other";

/** One provider ledger line (a single-asset balance change). Kept for audit/reconciliation. */
export interface NormalizedLedgerEntry extends NormalizedRecordBase {
  readonly externalLedgerId: string;
  /** Provider reference linking related lines (e.g. both legs of a trade). */
  readonly externalReferenceId: string | null;
  /** Normalized category. "other" means the activity is not supported and needs review. */
  readonly entryType: LedgerEntryType;
  /** The provider's own labels, kept for display and debugging (e.g. "staking" / "spottostaking"). */
  readonly providerEntryType: string;
  readonly providerSubtype: string | null;
  readonly asset: AssetCode;
  /** Signed balance change, excluding fee. */
  readonly amount: Decimal;
  readonly fee: Decimal;
  /** Provider-reported balance after this entry, if available. */
  readonly balanceAfter: Decimal | null;
  readonly occurredAt: Date;
}

/** Provider-reported holdings of one asset at a point in time. */
export interface NormalizedBalance extends NormalizedRecordBase {
  readonly asset: AssetCode;
  readonly total: Decimal;
  readonly available: Decimal | null;
  readonly asOf: Date;
}

export interface AssetPair {
  readonly baseAsset: AssetCode;
  readonly quoteAsset: AssetCode;
}

/** Market data. Never accounting truth — only used for current valuation. */
export interface PriceQuote extends AssetPair {
  readonly source: ProviderType;
  readonly price: Decimal;
  readonly asOf: Date;
}
