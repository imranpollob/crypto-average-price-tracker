import { type AccountingConfig, isCash, isTracked } from "@/domain/accounting/config";
import { type Decimal, dec, sum } from "@/domain/decimal";
import { runWithFifoFallback } from "@/domain/lots/fifo-fallback";
import { deriveAssetFlows } from "@/domain/lots/flows";
import type { LotEngineResult } from "@/domain/lots/types";
import type { IncompleteReason } from "@/domain/metric";
import { calculatePositionMetrics, issueAsset } from "@/domain/pnl/position";
import { holdingsFromFlows } from "@/domain/reconciliation/reconcile";
import type { AssetCode } from "@/domain/transactions/types";
import type { PriceUnavailableReason } from "@/providers/types";
import type { Db } from "../db/client";
import { s2d } from "../db/codec";
import { HistoryRepository } from "../db/history-repository";
import { type AllocationView, allocationViews, type LotService, type LotView, lotView, type MetricView, metricView } from "./lot-service";
import type { CachedPrice, PriceService } from "./price-service";

/**
 * Portfolio figures per asset and in total, from stored history + manual lot
 * decisions + a provisional FIFO fallback for anything not yet assigned, and
 * the latest cached prices. Nothing here is persisted.
 *
 * Totals only add figures that are known: an asset whose P/L is incomplete is
 * excluded from the P/L totals and listed, never silently counted.
 */

export type PositionLabel =
  | { readonly kind: "complete" }
  | { readonly kind: "fifo_estimated" }
  | { readonly kind: "cost_basis_incomplete"; readonly lotsNeedingValuation: number }
  | { readonly kind: "price_unavailable"; readonly reason: PriceUnavailableReason | "not_fetched" }
  | { readonly kind: "review_required"; readonly reasons: readonly IncompleteReason[] };

export interface PositionView {
  readonly asset: AssetCode;
  readonly holdings: string;
  readonly price: string | null;
  readonly priceAsOf: string | null;
  readonly priceStale: boolean;
  readonly currentValue: MetricView;
  readonly costBasis: MetricView;
  readonly averageCost: MetricView;
  readonly realizedPnl: MetricView;
  readonly unrealizedPnl: MetricView;
  readonly unrealizedPnlPercent: MetricView;
  readonly totalPnl: MetricView;
  /** Some sale/transfer quantity of this asset is assigned by provisional FIFO. */
  readonly fifoEstimated: boolean;
  /** Most important first. */
  readonly labels: readonly PositionLabel[];
}

export interface Total {
  readonly value: string;
  /** Assets left out because their figure is incomplete. */
  readonly excluded: readonly AssetCode[];
}

export interface PortfolioView {
  readonly positions: readonly PositionView[];
  /** Assets with no remaining holdings (realized P/L only). */
  readonly closed: readonly PositionView[];
  readonly cash: readonly { readonly asset: AssetCode; readonly total: string }[];
  readonly totals: {
    readonly currentValue: Total;
    readonly costBasis: Total;
    readonly realizedPnl: Total;
    readonly unrealizedPnl: Total;
    readonly totalPnl: Total;
  };
  readonly fifoEstimatedAssets: number;
}

export interface AssetPortfolioView {
  readonly position: PositionView;
  /** Lots as they stand with provisional FIFO applied. */
  readonly openLots: readonly LotView[];
  /** Provisional FIFO assignments (not user decisions). */
  readonly provisionalMatches: readonly AllocationView[];
}

const VALUATION_REASONS: ReadonlySet<IncompleteReason> = new Set(["unknown_cost_basis", "unknown_proceeds", "unvalued_fee"]);

export class PortfolioService {
  private readonly history: HistoryRepository;

  constructor(
    private readonly db: Db,
    private readonly config: AccountingConfig,
    private readonly lots: LotService,
    private readonly prices: PriceService,
  ) {
    this.history = new HistoryRepository(db);
  }

  /** Tracked assets currently held (by history or by the latest provider balance): the ones that need a price. */
  async heldAssets(providerAccountId: string): Promise<AssetCode[]> {
    const [trades, transfers, balances] = await Promise.all([
      this.history.loadTrades(providerAccountId),
      this.history.loadTransfers(providerAccountId),
      this.history.loadLatestBalances(providerAccountId),
    ]);
    const flows = deriveAssetFlows(trades, transfers, this.config);
    const held = new Set<AssetCode>();
    for (const h of holdingsFromFlows(flows.acquisitions, flows.disposals)) if (h.quantity.greaterThan(0)) held.add(h.asset);
    for (const b of balances) if (b.total.greaterThan(0) && isTracked(this.config, b.asset)) held.add(b.asset);
    return [...held].sort();
  }

  async compute(providerAccountId: string): Promise<PortfolioView> {
    const { result, provisional, tolerances, prices } = await this.state(providerAccountId);
    const views = assetsOf(result).map((asset) => this.positionView(result, provisional, asset, prices.get(asset) ?? null, tolerances.get(asset)));
    const positions = views.filter((p) => dec(p.holdings).greaterThan(0));
    const closed = views.filter((p) => !dec(p.holdings).greaterThan(0));
    const balances = await this.history.loadLatestBalances(providerAccountId);
    return {
      positions,
      closed,
      cash: balances
        .filter((b) => isCash(this.config, b.asset) && !b.total.isZero())
        .map((b) => ({ asset: b.asset, total: b.total.toFixed() })),
      totals: {
        currentValue: total(positions, (p) => p.currentValue),
        costBasis: total(positions, (p) => p.costBasis),
        realizedPnl: total(views, (p) => p.realizedPnl),
        unrealizedPnl: total(positions, (p) => p.unrealizedPnl),
        totalPnl: total(views, (p) => p.totalPnl),
      },
      fifoEstimatedAssets: views.filter((p) => p.fifoEstimated).length,
    };
  }

  async asset(providerAccountId: string, asset: AssetCode): Promise<AssetPortfolioView | null> {
    const { result, provisional, tolerances, prices } = await this.state(providerAccountId);
    if (!assetsOf(result).includes(asset)) return null;
    const alloc = allocationViews(result);
    return {
      position: this.positionView(result, provisional, asset, prices.get(asset) ?? null, tolerances.get(asset)),
      openLots: result.lots.filter((l) => l.asset === asset && l.remainingQuantity.greaterThan(0)).map(lotView),
      provisionalMatches: result.allocations.filter((a) => a.asset === asset && provisional.has(a.matchId)).map(alloc),
    };
  }

  private async state(providerAccountId: string) {
    const [input, tolerances, prices] = await Promise.all([
      this.lots.loadInput(providerAccountId),
      this.residualTolerances(providerAccountId),
      this.prices.cached(),
    ]);
    const { result, provisionalMatchIds } = runWithFifoFallback(input);
    return { result, provisional: provisionalMatchIds, tolerances, prices };
  }

  /**
   * Per-asset difference already accepted by the latest reconciliation as
   * within the provider's reporting precision. A history shortfall up to that
   * size is a precision residual, not missing history.
   */
  private async residualTolerances(providerAccountId: string): Promise<Map<AssetCode, Decimal>> {
    const run = await this.db.syncRun.findFirst({
      where: { providerAccountId, status: "succeeded" },
      orderBy: { startedAt: "desc" },
      include: { reconciliations: { where: { status: "reconciled_within_precision" } } },
    });
    return new Map((run?.reconciliations ?? []).map((r) => [r.asset, s2d(r.difference).abs()]));
  }

  private positionView(
    result: LotEngineResult,
    provisional: ReadonlySet<string>,
    asset: AssetCode,
    price: CachedPrice | null,
    residualTolerance: Decimal | undefined,
  ): PositionView {
    const m = calculatePositionMetrics(result, asset, price?.price ?? null, { residualTolerance });
    const held = m.holdings.greaterThan(0);
    const fifoEstimated = result.allocations.some((a) => a.asset === asset && provisional.has(a.matchId));
    const reasons = new Set<IncompleteReason>(
      [m.costBasis, m.realizedPnl, m.unrealizedPnl, m.totalPnl, m.currentValue].flatMap((x) => (x.status === "incomplete" ? x.reasons : [])),
    );
    const labels: PositionLabel[] = [];
    const review = [...reasons].filter((r) => !VALUATION_REASONS.has(r) && r !== "missing_price");
    if (review.length > 0) labels.push({ kind: "review_required", reasons: review });
    if ([...reasons].some((r) => VALUATION_REASONS.has(r))) {
      const lotsNeedingValuation = result.issues.filter((i) => i.code === "unknown_cost_basis" && issueAsset(i) === asset).length;
      labels.push({ kind: "cost_basis_incomplete", lotsNeedingValuation });
    }
    if (held && !price) labels.push({ kind: "price_unavailable", reason: this.prices.unavailableReason(asset) ?? "not_fetched" });
    if (fifoEstimated) labels.push({ kind: "fifo_estimated" });
    if (labels.length === 0) labels.push({ kind: "complete" });

    return {
      asset,
      holdings: m.holdings.toFixed(),
      price: price ? price.price.toFixed() : null,
      priceAsOf: price ? price.asOf.toISOString() : null,
      priceStale: price ? this.prices.isStale(price.asOf) : false,
      currentValue: metricView(m.currentValue),
      costBasis: metricView(m.costBasis),
      averageCost: metricView(m.averageCost),
      realizedPnl: metricView(m.realizedPnl),
      unrealizedPnl: metricView(m.unrealizedPnl),
      unrealizedPnlPercent: metricView(m.unrealizedPnlPercent),
      totalPnl: metricView(m.totalPnl),
      fifoEstimated,
      labels,
    };
  }
}

function assetsOf(result: LotEngineResult): AssetCode[] {
  return [...new Set([...result.lots.map((l) => l.asset), ...result.disposals.map((d) => d.disposal.asset)])].sort();
}

function total(positions: readonly PositionView[], pick: (p: PositionView) => MetricView): Total {
  const known: Decimal[] = [];
  const excluded: AssetCode[] = [];
  for (const p of positions) {
    const m = pick(p);
    if (m.status === "known") known.push(dec(m.value));
    else if (m.status === "incomplete") excluded.push(p.asset);
  }
  return { value: sum(known).toFixed(), excluded };
}
