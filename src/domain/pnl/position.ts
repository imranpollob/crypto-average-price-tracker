import { type Decimal, ONE_HUNDRED, sum, ZERO } from "../decimal";
import type { DisposalState, EngineIssue, Lot, LotEngineResult } from "../lots/types";
import {
  type IncompleteReason,
  incomplete,
  known,
  type Metric,
  notApplicable,
  reasonsOf,
} from "../metric";
import type { AssetCode } from "../transactions/types";

/**
 * Per-asset portfolio metrics, derived from lot-engine output and a current
 * price (already expressed in the reporting currency).
 *
 *   Open Cost Basis   = Σ remaining cost of open lots
 *   Average Cost      = Open Cost Basis / Open Quantity          (N/A when 0)
 *   Current Value     = Current Price × Holdings
 *   Unrealized P/L    = Current Value − Open Cost Basis
 *   Unrealized P/L %  = Unrealized P/L / Open Cost Basis × 100    (N/A when basis is 0)
 *   Realized P/L      = Σ (net sale proceeds − allocated acquisition cost)
 *   Total P/L         = Realized P/L + Unrealized P/L
 *
 * Nothing that depends on an undecided lot assignment or unknown value is ever
 * reported as known; such metrics are `incomplete` with the reasons listed.
 */
export interface PositionMetrics {
  readonly asset: AssetCode;
  /** Quantity held according to transaction history (independent of lot matching). */
  readonly holdings: Decimal;
  /** Σ remaining quantity of open lots (equals holdings once everything is matched). */
  readonly openLotQuantity: Decimal;
  readonly currentPrice: Metric;
  readonly currentValue: Metric;
  readonly costBasis: Metric;
  readonly averageCost: Metric;
  readonly realizedPnl: Metric;
  readonly unrealizedPnl: Metric;
  readonly unrealizedPnlPercent: Metric;
  readonly totalPnl: Metric;
  readonly issues: readonly EngineIssue[];
  readonly counts: {
    readonly unmatchedSales: number;
    readonly unresolvedTransfersOut: number;
    readonly unknownCostLots: number;
    readonly invalidMatches: number;
  };
  /** True when the user must act (match sales, review transfers, enter costs...). */
  readonly reviewRequired: boolean;
}

export function issueAsset(issue: EngineIssue): AssetCode | null {
  return "asset" in issue ? issue.asset : null;
}

export function calculatePositionMetrics(
  engine: LotEngineResult,
  asset: AssetCode,
  currentPrice: Decimal | null,
): PositionMetrics {
  const lots = engine.lots.filter((l) => l.asset === asset);
  const disposals = engine.disposals.filter((d) => d.disposal.asset === asset);
  const allocations = engine.allocations.filter((a) => a.asset === asset);
  const issues = engine.issues.filter((i) => issueAsset(i) === asset);
  const has = (code: EngineIssue["code"]) => issues.some((i) => i.code === code);
  const count = (code: EngineIssue["code"]) => issues.filter((i) => i.code === code).length;

  const holdings = sum(lots.map((l) => l.originalQuantity)).minus(
    sum(disposals.map((d) => d.disposal.quantity)),
  );
  const openLots = lots.filter((l) => l.remainingQuantity.greaterThan(0));
  const openLotQuantity = sum(openLots.map((l) => l.remainingQuantity));

  // Problems that make any lot-based figure unreliable.
  const qualityReasons = dataQualityReasons(issues);
  const structural: IncompleteReason[] = [...qualityReasons];
  if (has("invalid_lot_match")) structural.push("invalid_lot_match");
  if (has("insufficient_history")) structural.push("insufficient_history");
  // When the quantity itself is unreliable, so is anything valued from it.
  const holdingsReasons = structural.filter(
    (r): r is "insufficient_history" | "reconciliation_mismatch" =>
      r === "insufficient_history" || r === "reconciliation_mismatch",
  );
  const lotsById = new Map(lots.map((l) => [l.id, l]));

  // --- Open position -------------------------------------------------------
  const openReasons = [...structural];
  if (has("unmatched_sale")) openReasons.push("unmatched_sale");
  if (has("unresolved_transfer_out")) openReasons.push("unresolved_transfer_out");
  openReasons.push(...unknownCostReasons(openLots));

  let costBasis: Metric;
  let averageCost: Metric;
  if (openReasons.length > 0) {
    costBasis = incomplete(openReasons);
    averageCost = incomplete(openReasons);
  } else {
    if (!openLotQuantity.equals(holdings)) {
      // Cannot happen when every disposal is fully and validly matched.
      throw new Error(
        `Invariant violated for ${asset}: open lots ${openLotQuantity.toFixed()} ≠ holdings ${holdings.toFixed()}`,
      );
    }
    const basis = sum(openLots.map((l) => l.remainingCost!));
    costBasis = known(basis);
    averageCost = openLotQuantity.isZero() ? notApplicable : known(basis.dividedBy(openLotQuantity));
  }

  // --- Market value --------------------------------------------------------
  const priceMetric: Metric = currentPrice ? known(currentPrice) : incomplete(["missing_price"]);
  let currentValue: Metric;
  if (holdingsReasons.length > 0) currentValue = incomplete(holdingsReasons);
  else if (holdings.isZero()) currentValue = known(ZERO);
  else if (currentPrice) currentValue = known(currentPrice.times(holdings));
  else currentValue = incomplete(["missing_price"]);

  // --- Realized ------------------------------------------------------------
  const sales = disposals.filter((d) => d.disposal.kind === "sale");
  const saleAllocations = allocations.filter((a) => a.kind === "sale");
  const realizedReasons = [...structural];
  if (sales.some((d) => d.unmatchedQuantity.greaterThan(0))) realizedReasons.push("unmatched_sale");
  realizedReasons.push(...unknownProceedsReasons(sales));
  realizedReasons.push(
    ...unknownCostReasons(
      saleAllocations.filter((a) => a.allocatedAcquisitionCost === null).map((a) => lotsById.get(a.lotId)!),
    ),
  );
  const realizedPnl =
    realizedReasons.length > 0
      ? incomplete(realizedReasons)
      : known(sum(saleAllocations.map((a) => a.realizedPnl!)));

  // --- Unrealized ----------------------------------------------------------
  let unrealizedPnl: Metric;
  let unrealizedPnlPercent: Metric;
  if (costBasis.status === "known" && currentValue.status === "known") {
    const u = currentValue.value.minus(costBasis.value);
    unrealizedPnl = known(u);
    unrealizedPnlPercent = costBasis.value.isZero()
      ? notApplicable
      : known(u.dividedBy(costBasis.value).times(ONE_HUNDRED));
  } else {
    const reasons = [...reasonsOf(costBasis), ...reasonsOf(currentValue)];
    unrealizedPnl = incomplete(reasons);
    unrealizedPnlPercent = incomplete(reasons);
  }

  // --- Total ---------------------------------------------------------------
  const totalPnl =
    realizedPnl.status === "known" && unrealizedPnl.status === "known"
      ? known(realizedPnl.value.plus(unrealizedPnl.value))
      : economicTotalPnl(engine, asset, currentValue, structural);

  const counts = {
    unmatchedSales: count("unmatched_sale"),
    unresolvedTransfersOut: count("unresolved_transfer_out"),
    unknownCostLots: count("unknown_cost_basis"),
    invalidMatches: count("invalid_lot_match"),
  };

  return {
    asset,
    holdings,
    openLotQuantity,
    currentPrice: priceMetric,
    currentValue,
    costBasis,
    averageCost,
    realizedPnl,
    unrealizedPnl,
    unrealizedPnlPercent,
    totalPnl,
    issues,
    counts,
    reviewRequired: issues.some((i) => i.code !== "orphan_manual_valuation"),
  };
}

/**
 * Total P/L computed without reference to lot assignments:
 *
 *   Σ net sale proceeds + current value − Σ lot acquisition cost + Σ cost transferred out
 *
 * Realized + Unrealized always equals this (lot matching only moves P/L between
 * the two), so it stays known while sales are merely unmatched. It still needs
 * every cost and proceeds value, and every outgoing transfer resolved (the cost
 * leaving with a withdrawal depends on which lots the user says were withdrawn).
 */
export function economicTotalPnl(
  engine: LotEngineResult,
  asset: AssetCode,
  currentValue: Metric,
  structural: readonly IncompleteReason[] = [],
): Metric {
  const reasons: IncompleteReason[] = [...structural, ...reasonsOf(currentValue)];
  const disposals = engine.disposals.filter((d) => d.disposal.asset === asset);
  const lots = engine.lots.filter((l) => l.asset === asset);
  const allocations = engine.allocations.filter((a) => a.asset === asset);

  if (disposals.some((d) => d.disposal.kind === "transfer_out" && d.unmatchedQuantity.greaterThan(0))) {
    reasons.push("unresolved_transfer_out");
  }
  const sales = disposals.filter((d) => d.disposal.kind === "sale");
  reasons.push(...unknownProceedsReasons(sales));

  const soldFrom = new Set(allocations.filter((a) => a.kind === "sale").map((a) => a.lotId));
  let lotCost = ZERO;
  for (const lot of lots) {
    if (lot.acquisitionCost !== null) {
      lotCost = lotCost.plus(lot.acquisitionCost);
    } else if (lot.remainingQuantity.greaterThan(0) || soldFrom.has(lot.id)) {
      // Unknown cost only cancels out if the whole lot was transferred away.
      reasons.push(...unknownCostReasons([lot]));
    }
  }
  if (reasons.length > 0 || currentValue.status !== "known") return incomplete(reasons);

  const netProceeds = sum(
    sales.map((d) => {
      const p = d.proceeds as { gross: Decimal; fee: Decimal };
      return p.gross.minus(p.fee);
    }),
  );
  const transferredCost = sum(
    allocations
      .filter((a) => a.kind === "transfer_out" && a.allocatedAcquisitionCost !== null)
      .map((a) => a.allocatedAcquisitionCost!),
  );
  return known(netProceeds.plus(currentValue.value).minus(lotCost).plus(transferredCost));
}

/** Reasons from data-quality issues (flags from flows, imports and reconciliation). */
function dataQualityReasons(issues: readonly EngineIssue[]): IncompleteReason[] {
  return issues.flatMap((i) => (i.code === "data_quality" ? [i.reason] : []));
}

/** Lots with unknown cost; a fee in another asset is additionally named as an unvalued fee. */
function unknownCostReasons(lots: readonly Lot[]): IncompleteReason[] {
  const out: IncompleteReason[] = [];
  for (const l of lots) {
    if (l.remainingCost !== null && l.acquisitionCost !== null) continue;
    out.push("unknown_cost_basis");
    if (l.unknownCostReason === "fee_in_other_asset") out.push("unvalued_fee");
  }
  return out;
}

function unknownProceedsReasons(sales: readonly DisposalState[]): IncompleteReason[] {
  const out: IncompleteReason[] = [];
  for (const d of sales) {
    if (d.proceeds?.status === "known") continue;
    out.push("unknown_proceeds");
    if (d.proceeds?.status === "unknown" && d.proceeds.reason === "fee_in_other_asset") out.push("unvalued_fee");
  }
  return out;
}
