import { type Decimal, ONE_HUNDRED, ZERO } from "../decimal";
import type { LotEngineResult } from "../lots/types";
import { calculatePositionMetrics, type PositionMetrics } from "../pnl/position";
import type { Metric } from "../metric";
import type { AssetCode } from "../transactions/types";

/**
 * A portfolio-wide sum. Only known per-asset values are combined; any asset
 * whose value is incomplete is listed in `excludedAssets` and the total is
 * flagged `complete: false` so the UI can say so.
 */
export interface PortfolioTotal {
  readonly value: Decimal;
  readonly complete: boolean;
  readonly excludedAssets: readonly AssetCode[];
}

export interface PortfolioSummary {
  readonly reportingCurrency: AssetCode;
  readonly positions: readonly PositionMetrics[];
  readonly totalCurrentValue: PortfolioTotal;
  readonly totalCostBasis: PortfolioTotal;
  readonly totalRealizedPnl: PortfolioTotal;
  readonly totalUnrealizedPnl: PortfolioTotal;
  readonly totalPnl: PortfolioTotal;
  /** Only when unrealized and cost basis totals are both complete and basis > 0. */
  readonly totalUnrealizedPnlPercent: Decimal | null;
  readonly reviewRequired: boolean;
}

export function combine(
  positions: readonly PositionMetrics[],
  pick: (p: PositionMetrics) => Metric,
): PortfolioTotal {
  let value = ZERO;
  const excluded: AssetCode[] = [];
  for (const p of positions) {
    const m = pick(p);
    if (m.status === "known") value = value.plus(m.value);
    else if (m.status === "incomplete") excluded.push(p.asset);
  }
  return { value, complete: excluded.length === 0, excludedAssets: excluded };
}

/** Every non-cash asset that appears anywhere in the lot engine output. */
export function assetsIn(engine: LotEngineResult): AssetCode[] {
  const set = new Set<AssetCode>();
  for (const l of engine.lots) set.add(l.asset);
  for (const d of engine.disposals) set.add(d.disposal.asset);
  return [...set].sort();
}

export function calculatePortfolio(params: {
  readonly engine: LotEngineResult;
  /** Current price per asset, in the reporting currency. */
  readonly prices: ReadonlyMap<AssetCode, Decimal>;
  readonly reportingCurrency: AssetCode;
}): PortfolioSummary {
  const positions = assetsIn(params.engine).map((asset) =>
    calculatePositionMetrics(params.engine, asset, params.prices.get(asset) ?? null),
  );
  const totalCostBasis = combine(positions, (p) => p.costBasis);
  const totalUnrealizedPnl = combine(positions, (p) => p.unrealizedPnl);
  const pct =
    totalCostBasis.complete && totalUnrealizedPnl.complete && totalCostBasis.value.greaterThan(0)
      ? totalUnrealizedPnl.value.dividedBy(totalCostBasis.value).times(ONE_HUNDRED)
      : null;

  return {
    reportingCurrency: params.reportingCurrency,
    positions,
    totalCurrentValue: combine(positions, (p) => p.currentValue),
    totalCostBasis,
    totalRealizedPnl: combine(positions, (p) => p.realizedPnl),
    totalUnrealizedPnl,
    totalPnl: combine(positions, (p) => p.totalPnl),
    totalUnrealizedPnlPercent: pct,
    reviewRequired: positions.some((p) => p.reviewRequired),
  };
}
