import type { Decimal } from "../decimal";
import type { AssetCode, ProviderType, TransferKind } from "../transactions/types";

/**
 * Asset flows: the single, provider-independent input of the lot engine.
 *
 * Trades and transfers are translated into per-asset acquisitions (quantity in)
 * and disposals (quantity out). A crypto/crypto trade produces two flows — one
 * per leg — while fiat (cash) legs produce none.
 */

export type FlowSourceType = "trade" | "transfer";

/** Why a monetary value could not be determined in the reporting currency. */
export type UnknownValueReason =
  /** Deposit / reward / incoming transfer: the original acquisition price is not known. */
  | "no_acquisition_price"
  /** Priced in an asset other than the reporting currency; no conversion rate is known. */
  | "non_reporting_currency"
  /** Fee charged in a third asset whose value is unknown. */
  | "fee_in_other_asset";

/** A monetary amount split into gross value and fee, in the reporting currency. */
export type Valuation =
  | { readonly status: "known"; readonly gross: Decimal; readonly fee: Decimal }
  | { readonly status: "unknown"; readonly reason: UnknownValueReason };

export type AcquisitionOrigin = "buy" | "trade_proceeds" | TransferKind;
export type DisposalOrigin = "sell" | "trade_payment" | TransferKind;

export interface Acquisition {
  /** Stable key; also becomes the lot id. */
  readonly id: string;
  readonly provider: ProviderType;
  readonly providerAccountId: string;
  readonly sourceType: FlowSourceType;
  /** Key of the originating trade/transfer (see transactions/identity). */
  readonly sourceKey: string;
  readonly origin: AcquisitionOrigin;
  readonly asset: AssetCode;
  readonly quantity: Decimal;
  /** Execution price as traded, for display (may be in a non-reporting asset). */
  readonly unitPrice: Decimal | null;
  readonly priceAsset: AssetCode | null;
  /** Acquisition cost: gross = value of units received, fee = buy fee. */
  readonly cost: Valuation;
  readonly acquiredAt: Date;
  /** Fee paid with a provider fee credit (zero portfolio cost), kept for transparency. */
  readonly feeCredit?: FeeCreditUsage;
}

export interface FeeCreditUsage {
  readonly amount: Decimal;
  readonly asset: AssetCode;
}

/**
 * - sale: the asset was exchanged for something else → realizes P/L.
 * - transfer_out: the asset left the account without a sale (withdrawal) → no P/L,
 *   its cost basis leaves with it. Requires user review in V1.
 */
export type DisposalKind = "sale" | "transfer_out";

export interface Disposal {
  /** Stable key; lot matches refer to it. */
  readonly id: string;
  readonly provider: ProviderType;
  readonly providerAccountId: string;
  readonly sourceType: FlowSourceType;
  readonly sourceKey: string;
  readonly kind: DisposalKind;
  readonly origin: DisposalOrigin;
  readonly asset: AssetCode;
  /** Units leaving the account (including any fee charged in this asset). */
  readonly quantity: Decimal;
  readonly unitPrice: Decimal | null;
  readonly priceAsset: AssetCode | null;
  /** Sale proceeds: gross and sell fee (net = gross − fee). Null for transfer_out. */
  readonly proceeds: Valuation | null;
  readonly disposedAt: Date;
  /** Fee paid with a provider fee credit (zero portfolio cost), kept for transparency. */
  readonly feeCredit?: FeeCreditUsage;
}

/** A user decision: close `quantity` of `lotId` with `disposalId`. */
export interface LotMatchInstruction {
  /** Persisted id; also defines application order within one disposal. */
  readonly id: string;
  readonly disposalId: string;
  readonly lotId: string;
  readonly quantity: Decimal;
}

/** User-entered value replacing an unknown (or correcting a) valuation. */
export interface ManualValuation {
  /** Acquisition id (cost) or disposal id (proceeds). */
  readonly targetId: string;
  readonly gross: Decimal;
  readonly fee: Decimal;
}

export type CostBasisStatus = "known" | "manual" | "unknown";

export interface Lot {
  readonly id: string;
  readonly provider: ProviderType;
  readonly providerAccountId: string;
  readonly sourceType: FlowSourceType;
  readonly sourceKey: string;
  readonly origin: AcquisitionOrigin;
  readonly asset: AssetCode;
  readonly acquiredAt: Date;
  readonly unitPrice: Decimal | null;
  readonly priceAsset: AssetCode | null;
  readonly originalQuantity: Decimal;
  readonly remainingQuantity: Decimal;
  readonly costBasisStatus: CostBasisStatus;
  readonly unknownCostReason: UnknownValueReason | null;
  /** Total acquisition cost including buy fee; null when unknown. */
  readonly acquisitionCost: Decimal | null;
  readonly acquisitionFee: Decimal | null;
  /** Cost still attributed to remainingQuantity; null when unknown. */
  readonly remainingCost: Decimal | null;
  readonly remainingFee: Decimal | null;
}

/** One applied lot match with its allocated amounts (all reporting currency). */
export interface LotAllocation {
  readonly matchId: string;
  readonly disposalId: string;
  readonly lotId: string;
  readonly kind: DisposalKind;
  readonly asset: AssetCode;
  readonly providerAccountId: string;
  readonly quantity: Decimal;
  readonly lotAcquiredAt: Date;
  readonly disposedAt: Date;
  readonly lotUnitPrice: Decimal | null;
  readonly disposalUnitPrice: Decimal | null;
  /** Share of lot cost, including buy fee. Null if the lot's cost is unknown. */
  readonly allocatedAcquisitionCost: Decimal | null;
  readonly allocatedBuyFee: Decimal | null;
  /** Sale-only fields (null for transfer_out or when proceeds unknown). */
  readonly grossSaleProceeds: Decimal | null;
  readonly allocatedSellFee: Decimal | null;
  readonly netSaleProceeds: Decimal | null;
  /** netSaleProceeds − allocatedAcquisitionCost; null unless both known and kind is sale. */
  readonly realizedPnl: Decimal | null;
}

export type DisposalMatchStatus = "matched" | "partially_matched" | "unmatched";

export interface DisposalState {
  readonly disposal: Disposal;
  readonly matchedQuantity: Decimal;
  readonly unmatchedQuantity: Decimal;
  readonly status: DisposalMatchStatus;
  /** Proceeds after manual overrides; null for transfer_out. */
  readonly proceeds: Valuation | null;
  readonly proceedsSource: "provider" | "manual" | null;
}

export type InvalidMatchProblem =
  | "unknown_lot"
  | "unknown_disposal"
  | "asset_mismatch"
  | "account_mismatch"
  | "lot_acquired_after_disposal"
  | "non_positive_quantity"
  | "exceeds_disposal_remaining"
  | "exceeds_lot_remaining";

export type EngineIssue =
  | {
      readonly code: "invalid_lot_match";
      readonly matchId: string;
      readonly disposalId: string;
      readonly lotId: string;
      readonly asset: AssetCode | null;
      readonly problem: InvalidMatchProblem;
    }
  | {
      readonly code: "unmatched_sale" | "unresolved_transfer_out";
      readonly disposalId: string;
      readonly asset: AssetCode;
      readonly unmatchedQuantity: Decimal;
    }
  | {
      readonly code: "unknown_cost_basis";
      readonly lotId: string;
      readonly asset: AssetCode;
      readonly reason: UnknownValueReason;
    }
  | {
      readonly code: "unknown_proceeds";
      readonly disposalId: string;
      readonly asset: AssetCode;
      readonly reason: UnknownValueReason;
    }
  | {
      /** Running balance went negative: part of the history is missing. */
      readonly code: "insufficient_history";
      readonly asset: AssetCode;
      readonly providerAccountId: string;
      readonly shortfall: Decimal;
    }
  | { readonly code: "orphan_manual_valuation"; readonly targetId: string }
  | {
      /** A problem found outside the lot engine that makes this asset's history unreliable. */
      readonly code: "data_quality";
      readonly asset: AssetCode;
      readonly reason: DataQualityReason;
      readonly detail: string;
      readonly sourceKey: string | null;
    };

/**
 * Reasons a whole asset's figures cannot be trusted, detected outside the
 * lot engine (while deriving flows, importing provider data, or reconciling).
 */
export type DataQualityReason =
  | "unvalued_fee"
  | "unsupported_activity"
  | "insufficient_history"
  | "reconciliation_mismatch"
  /** The automatic lot matching method could not decide which lots a disposal used. */
  | "ambiguous_automatic_match";

export interface DataQualityFlag {
  readonly asset: AssetCode;
  readonly reason: DataQualityReason;
  /** Human-readable explanation, safe to display. */
  readonly detail: string;
  /** Record that caused it, when there is one. */
  readonly sourceKey: string | null;
}

export interface LotEngineInput {
  readonly acquisitions: readonly Acquisition[];
  readonly disposals: readonly Disposal[];
  readonly matches: readonly LotMatchInstruction[];
  readonly manualValuations?: readonly ManualValuation[];
  /** Asset-level problems from flows, imports or reconciliation; reported as issues. */
  readonly dataQualityFlags?: readonly DataQualityFlag[];
}

export interface LotEngineResult {
  readonly lots: readonly Lot[];
  readonly allocations: readonly LotAllocation[];
  readonly disposals: readonly DisposalState[];
  readonly issues: readonly EngineIssue[];
}
