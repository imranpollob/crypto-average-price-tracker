import { randomBytes } from "node:crypto";
import type { AccountingConfig } from "@/domain/accounting/config";
import { type Decimal, dec, InvalidDecimalError, sum, ZERO } from "@/domain/decimal";
import { runLotEngine } from "@/domain/lots/engine";
import { deriveAssetFlows } from "@/domain/lots/flows";
import { candidateLotsFor, validateMatchProposal } from "@/domain/lots/matching";
import type {
  Disposal,
  DisposalState,
  EngineIssue,
  InvalidMatchProblem,
  Lot,
  LotAllocation,
  LotEngineInput,
  LotEngineResult,
  LotMatchInstruction,
  Valuation,
} from "@/domain/lots/types";
import type { Metric } from "@/domain/metric";
import { calculatePositionMetrics } from "@/domain/pnl/position";
import type { Db } from "../db/client";
import { d2s } from "../db/codec";
import { HistoryRepository } from "../db/history-repository";
import { LotRepository, type ValuationTargetType } from "../db/lot-repository";

/**
 * The lot workflow: rebuild lots from stored history + stored decisions, and
 * record / change / remove manual lot matches and valuations.
 *
 * Lots are derived state. Every operation recomputes the whole account with
 * the lot engine from (trades, transfers, lot_matches, manual_valuations) and
 * rewrites the projection, so the result never depends on how it was reached:
 * editing a match is "drop the old decision, add the new one, recompute", never
 * an in-place reverse mutation.
 */

// --- Errors -------------------------------------------------------------------

export type MatchInputProblem =
  | InvalidMatchProblem
  | "invalid_decimal"
  | "no_allocation"
  | "unknown_match"
  | "would_invalidate_existing_match";

export interface MatchProblem {
  readonly lotId: string | null;
  readonly problem: MatchInputProblem;
}

const PROBLEM_TEXT: Record<MatchInputProblem, string> = {
  unknown_lot: "The lot does not exist.",
  unknown_disposal: "The sale/transfer does not exist in this account.",
  asset_mismatch: "The lot holds a different asset.",
  account_mismatch: "The lot belongs to a different account.",
  lot_acquired_after_disposal: "The lot was acquired after this sale/transfer.",
  non_positive_quantity: "Quantity must be greater than zero.",
  exceeds_disposal_remaining: "More than the unmatched quantity of this sale/transfer.",
  exceeds_lot_remaining: "More than the lot has remaining.",
  invalid_decimal: "Not a valid decimal number.",
  no_allocation: "Enter a quantity for at least one lot.",
  unknown_match: "The lot match does not exist.",
  would_invalidate_existing_match: "This would take quantity already assigned to another sale/transfer.",
};

export function describeProblem(p: MatchInputProblem): string {
  return PROBLEM_TEXT[p];
}

/** A proposed lot assignment was rejected; nothing was saved. */
export class LotMatchError extends Error {
  constructor(readonly problems: readonly MatchProblem[]) {
    super(problems.map((p) => (p.lotId ? `${p.lotId}: ` : "") + describeProblem(p.problem)).join(" "));
    this.name = "LotMatchError";
  }
}

export class ValuationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValuationInputError";
  }
}

// --- Serializable views -------------------------------------------------------

export type MetricView =
  | { readonly status: "known"; readonly value: string }
  | { readonly status: "not_applicable" }
  | { readonly status: "incomplete"; readonly reasons: readonly string[] };

const str = (d: Decimal | null): string | null => (d === null ? null : d.toFixed());

export function metricView(m: Metric): MetricView {
  if (m.status === "known") return { status: "known", value: m.value.toFixed() };
  if (m.status === "not_applicable") return { status: "not_applicable" };
  return { status: "incomplete", reasons: m.reasons };
}

export interface AllocationView {
  readonly matchId: string;
  readonly disposalId: string;
  readonly lotId: string;
  readonly kind: "sale" | "transfer_out";
  readonly quantity: string;
  readonly lotAcquiredAt: string;
  readonly disposedAt: string;
  readonly lotOrigin: string | null;
  readonly disposalOrigin: string | null;
  readonly lotUnitPrice: string | null;
  readonly lotPriceAsset: string | null;
  readonly disposalUnitPrice: string | null;
  readonly disposalPriceAsset: string | null;
  readonly allocatedAcquisitionCost: string | null;
  readonly allocatedBuyFee: string | null;
  readonly grossSaleProceeds: string | null;
  readonly allocatedSellFee: string | null;
  readonly netSaleProceeds: string | null;
  readonly realizedPnl: string | null;
}

/** Builds allocation views, enriched with the lot's and disposal's origin and price asset. */
export function allocationViews(result: LotEngineResult): (a: LotAllocation) => AllocationView {
  const lots = new Map(result.lots.map((l) => [l.id, l]));
  const disposals = new Map(result.disposals.map((d) => [d.disposal.id, d.disposal]));
  return (a) => {
    const lot = lots.get(a.lotId);
    const disposal = disposals.get(a.disposalId);
    return {
      matchId: a.matchId,
      disposalId: a.disposalId,
      lotId: a.lotId,
      kind: a.kind,
      quantity: a.quantity.toFixed(),
      lotAcquiredAt: a.lotAcquiredAt.toISOString(),
      disposedAt: a.disposedAt.toISOString(),
      lotOrigin: lot?.origin ?? null,
      disposalOrigin: disposal?.origin ?? null,
      lotUnitPrice: str(a.lotUnitPrice),
      lotPriceAsset: lot?.priceAsset ?? null,
      disposalUnitPrice: str(a.disposalUnitPrice),
      disposalPriceAsset: disposal?.priceAsset ?? null,
      allocatedAcquisitionCost: str(a.allocatedAcquisitionCost),
      allocatedBuyFee: str(a.allocatedBuyFee),
      grossSaleProceeds: str(a.grossSaleProceeds),
      allocatedSellFee: str(a.allocatedSellFee),
      netSaleProceeds: str(a.netSaleProceeds),
      realizedPnl: str(a.realizedPnl),
    };
  };
}

export interface LotView {
  readonly id: string;
  readonly asset: string;
  readonly origin: string;
  readonly acquiredAt: string;
  readonly originalQuantity: string;
  readonly remainingQuantity: string;
  readonly unitPrice: string | null;
  readonly priceAsset: string | null;
  readonly acquisitionCost: string | null;
  readonly acquisitionFee: string | null;
  readonly remainingCost: string | null;
  readonly costBasisStatus: "known" | "manual" | "unknown";
  readonly unknownCostReason: string | null;
}

export function lotView(l: Lot): LotView {
  return {
    id: l.id,
    asset: l.asset,
    origin: l.origin,
    acquiredAt: l.acquiredAt.toISOString(),
    originalQuantity: l.originalQuantity.toFixed(),
    remainingQuantity: l.remainingQuantity.toFixed(),
    unitPrice: str(l.unitPrice),
    priceAsset: l.priceAsset,
    acquisitionCost: str(l.acquisitionCost),
    acquisitionFee: str(l.acquisitionFee),
    remainingCost: str(l.remainingCost),
    costBasisStatus: l.costBasisStatus,
    unknownCostReason: l.unknownCostReason,
  };
}

export type ProceedsView =
  | { readonly status: "known"; readonly gross: string; readonly fee: string; readonly source: "provider" | "manual" }
  | { readonly status: "unknown"; readonly reason: string }
  | null;

function proceedsView(p: Valuation | null, source: DisposalState["proceedsSource"]): ProceedsView {
  if (!p) return null;
  if (p.status === "unknown") return { status: "unknown", reason: p.reason };
  return { status: "known", gross: p.gross.toFixed(), fee: p.fee.toFixed(), source: source ?? "provider" };
}

export interface CandidateLotView {
  readonly lotId: string;
  readonly acquiredAt: string;
  readonly origin: string;
  /** Quantity not claimed by any existing match. */
  readonly available: string;
  readonly unitPrice: string | null;
  readonly priceAsset: string | null;
  readonly remainingCost: string | null;
  readonly costBasisStatus: "known" | "manual" | "unknown";
}

export interface DisposalView {
  readonly id: string;
  readonly kind: "sale" | "transfer_out";
  readonly origin: string;
  readonly disposedAt: string;
  readonly quantity: string;
  readonly matchedQuantity: string;
  readonly unmatchedQuantity: string;
  readonly status: DisposalState["status"];
  readonly unitPrice: string | null;
  readonly priceAsset: string | null;
  readonly proceeds: ProceedsView;
  readonly candidates: readonly CandidateLotView[];
  readonly matches: readonly AllocationView[];
}

export interface AssetSummary {
  readonly asset: string;
  readonly holdings: string;
  readonly openLots: number;
  readonly costBasis: MetricView;
  readonly averageCost: MetricView;
  readonly realizedPnl: MetricView;
  readonly unresolvedSales: number;
  readonly unresolvedTransfers: number;
  readonly reviewRequired: boolean;
}

export interface AssetDetail {
  readonly summary: AssetSummary;
  readonly unresolved: readonly DisposalView[];
  readonly openLots: readonly LotView[];
  readonly closedLots: readonly LotView[];
  readonly saleMatches: readonly AllocationView[];
  readonly transferMatches: readonly AllocationView[];
  /** Sales whose proceeds are unknown or manually set (matched or not). */
  readonly valuationDisposals: readonly DisposalView[];
  readonly issues: readonly string[];
}

export interface MatchPreview {
  readonly kind: "sale" | "transfer_out";
  readonly allocations: readonly AllocationView[];
  readonly totals: {
    readonly quantity: string;
    readonly acquisitionCost: string | null;
    readonly buyFees: string | null;
    readonly grossProceeds: string | null;
    readonly sellFees: string | null;
    readonly netProceeds: string | null;
    readonly realizedPnl: string | null;
  };
  /** Unmatched quantity of the disposal after these allocations. */
  readonly remainingToMatch: string;
}

export interface AllocationInput {
  readonly lotId: string;
  readonly quantity: string;
}

// --- Service ------------------------------------------------------------------

let idSeq = 0;
/**
 * Time-ordered match id: ordering by id reproduces decision order, which is
 * the order the engine applies matches of one disposal in.
 */
export function newMatchId(now: Date = new Date()): string {
  idSeq = (idSeq + 1) % 1_000_000;
  return `m${now.getTime().toString().padStart(15, "0")}${String(idSeq).padStart(6, "0")}${randomBytes(4).toString("hex")}`;
}

function totalOrNull(values: readonly (Decimal | null)[]): string | null {
  return values.some((v) => v === null) ? null : sum(values as Decimal[]).toFixed();
}

function strictDecimal(value: string): Decimal | null {
  try {
    return dec(value);
  } catch (e) {
    if (e instanceof InvalidDecimalError) return null;
    throw e;
  }
}

type InvalidMatchIssue = Extract<EngineIssue, { code: "invalid_lot_match" }>;

function invalidMatchIds(issues: readonly EngineIssue[]): Map<string, InvalidMatchIssue> {
  const out = new Map<string, InvalidMatchIssue>();
  for (const i of issues) if (i.code === "invalid_lot_match") out.set(i.matchId, i);
  return out;
}

function describeIssue(i: EngineIssue): string {
  switch (i.code) {
    case "invalid_lot_match":
      return `Stored lot match ${i.matchId} is invalid: ${describeProblem(i.problem)}`;
    case "unmatched_sale":
      return `Sale ${i.disposalId} has ${i.unmatchedQuantity.toFixed()} ${i.asset} not assigned to lots`;
    case "unresolved_transfer_out":
      return `Outgoing transfer ${i.disposalId} has ${i.unmatchedQuantity.toFixed()} ${i.asset} not assigned to lots`;
    case "unknown_cost_basis":
      return `Lot ${i.lotId} has no known cost basis (${i.reason})`;
    case "unknown_proceeds":
      return `Sale ${i.disposalId} has no known proceeds (${i.reason})`;
    case "insufficient_history":
      return `History is missing: ${i.shortfall.toFixed()} ${i.asset} left the account before it arrived`;
    case "orphan_manual_valuation":
      return `Manual valuation for ${i.targetId} matches nothing`;
    case "data_quality":
      return i.detail;
  }
}

function issueAsset(i: EngineIssue): string | null {
  return "asset" in i ? i.asset : null;
}

export class LotService {
  private readonly lots: LotRepository;
  private readonly history: HistoryRepository;

  constructor(
    db: Db,
    private readonly config: AccountingConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.lots = new LotRepository(db);
    this.history = new HistoryRepository(db);
  }

  /** Engine input from stored history and stored decisions. */
  async loadInput(providerAccountId: string): Promise<LotEngineInput> {
    const [trades, transfers, matches, manualValuations] = await Promise.all([
      this.history.loadTrades(providerAccountId),
      this.history.loadTransfers(providerAccountId),
      this.lots.loadMatches(providerAccountId),
      this.lots.loadManualValuations(providerAccountId),
    ]);
    const flows = deriveAssetFlows(trades, transfers, this.config);
    return {
      acquisitions: flows.acquisitions,
      disposals: flows.disposals,
      matches,
      manualValuations,
      dataQualityFlags: flows.flags,
    };
  }

  /** Recompute the account's lots and persist the projection. */
  async rebuild(providerAccountId: string): Promise<LotEngineResult> {
    const result = runLotEngine(await this.loadInput(providerAccountId));
    await this.lots.commit(providerAccountId, result);
    return result;
  }

  /** Validate proposed allocations for one disposal without saving anything. */
  async preview(providerAccountId: string, disposalId: string, allocations: readonly AllocationInput[]): Promise<MatchPreview> {
    const input = await this.loadInput(providerAccountId);
    const { proposal, disposal, result } = this.validateProposal(input, disposalId, allocations);
    return this.previewOf(result, disposal, proposal);
  }

  /** Save allocations for one disposal (all or nothing), then rebuild. */
  async saveMatches(providerAccountId: string, disposalId: string, allocations: readonly AllocationInput[]): Promise<LotEngineResult> {
    const input = await this.loadInput(providerAccountId);
    const { proposal, disposal, result } = this.validateProposal(input, disposalId, allocations);
    await this.lots.commit(providerAccountId, result, {
      insert: proposal.map((instruction) => ({ instruction, matchType: disposal.kind, disposalSourceKey: disposal.sourceKey })),
    });
    return result;
  }

  /** Replace one match's lot and/or quantity: the old decision is dropped and the new one validated from scratch. */
  async editMatch(providerAccountId: string, matchId: string, lotId: string, quantity: string): Promise<LotEngineResult> {
    const input = await this.loadInput(providerAccountId);
    const old = input.matches.find((m) => m.id === matchId);
    if (!old) throw new LotMatchError([{ lotId: null, problem: "unknown_match" }]);
    const without = { ...input, matches: input.matches.filter((m) => m.id !== matchId) };
    const qty = strictDecimal(quantity);
    if (qty === null) throw new LotMatchError([{ lotId, problem: "invalid_decimal" }]);
    // Same id: the decision keeps its place in the application order.
    const replacement: LotMatchInstruction = { id: matchId, disposalId: old.disposalId, lotId, quantity: qty };
    const result = this.checkProposal(without, [replacement]);
    await this.lots.commit(providerAccountId, result, { update: { id: matchId, lotId, quantity: d2s(qty) } });
    return result;
  }

  /** Remove a match; the lot's quantity and cost return to the open position. */
  async deleteMatch(providerAccountId: string, matchId: string): Promise<LotEngineResult> {
    const input = await this.loadInput(providerAccountId);
    if (!input.matches.some((m) => m.id === matchId)) throw new LotMatchError([{ lotId: null, problem: "unknown_match" }]);
    const result = runLotEngine({ ...input, matches: input.matches.filter((m) => m.id !== matchId) });
    await this.lots.commit(providerAccountId, result, { deleteIds: [matchId] });
    return result;
  }

  /**
   * Set the cost basis of a lot ("acquisition") or the proceeds of a sale
   * ("disposal") where provider data cannot determine it. Values are totals in
   * the reporting currency: gross value and fee.
   */
  async setValuation(
    providerAccountId: string,
    target: { type: ValuationTargetType; key: string },
    gross: string,
    fee: string,
    note: string | null = null,
  ): Promise<LotEngineResult> {
    const g = strictDecimal(gross);
    const f = strictDecimal(fee.trim() === "" ? "0" : fee);
    if (g === null || f === null) throw new ValuationInputError("Enter valid decimal numbers.");
    if (g.isNegative() || f.isNegative()) throw new ValuationInputError("Values cannot be negative.");
    const input = await this.loadInput(providerAccountId);
    const exists =
      target.type === "acquisition"
        ? input.acquisitions.some((a) => a.id === target.key)
        : input.disposals.some((d) => d.id === target.key && d.kind === "sale");
    if (!exists) throw new ValuationInputError("Nothing to value: unknown lot or sale in this account.");
    await this.lots.upsertManualValuation(target, d2s(g), d2s(f), note);
    return this.rebuild(providerAccountId);
  }

  async clearValuation(providerAccountId: string, target: { type: ValuationTargetType; key: string }): Promise<LotEngineResult> {
    await this.lots.deleteManualValuation(target);
    return this.rebuild(providerAccountId);
  }

  // --- views ----------------------------------------------------------------

  async summaries(providerAccountId: string): Promise<AssetSummary[]> {
    const result = await this.rebuild(providerAccountId);
    return assetsOf(result).map((asset) => summaryOf(result, asset));
  }

  async assetDetail(providerAccountId: string, asset: string): Promise<AssetDetail> {
    const result = await this.rebuild(providerAccountId);
    const lots = result.lots.filter((l) => l.asset === asset);
    const allocations = result.allocations.filter((a) => a.asset === asset);
    const disposals = result.disposals.filter((d) => d.disposal.asset === asset);
    const alloc = allocationViews(result);
    const view = (s: DisposalState) => disposalView(result, s, alloc);
    return {
      summary: summaryOf(result, asset),
      unresolved: disposals.filter((s) => s.status !== "matched").map(view),
      openLots: lots.filter((l) => l.remainingQuantity.greaterThan(0)).map(lotView),
      closedLots: lots.filter((l) => l.remainingQuantity.isZero()).map(lotView),
      saleMatches: allocations.filter((a) => a.kind === "sale").map(alloc),
      transferMatches: allocations.filter((a) => a.kind === "transfer_out").map(alloc),
      valuationDisposals: disposals
        .filter((s) => s.disposal.kind === "sale" && (s.proceeds?.status === "unknown" || s.proceedsSource === "manual"))
        .map(view),
      issues: result.issues.filter((i) => issueAsset(i) === asset).map(describeIssue),
    };
  }

  // --- internals ------------------------------------------------------------

  private validateProposal(
    input: LotEngineInput,
    disposalId: string,
    allocations: readonly AllocationInput[],
  ): { proposal: LotMatchInstruction[]; disposal: Disposal; result: LotEngineResult } {
    const disposal = input.disposals.find((d) => d.id === disposalId);
    if (!disposal) throw new LotMatchError([{ lotId: null, problem: "unknown_disposal" }]);
    const rows = allocations.filter((a) => a.quantity.trim() !== "");
    if (rows.length === 0) throw new LotMatchError([{ lotId: null, problem: "no_allocation" }]);
    const bad = rows.filter((a) => strictDecimal(a.quantity) === null);
    if (bad.length > 0) throw new LotMatchError(bad.map((a) => ({ lotId: a.lotId, problem: "invalid_decimal" as const })));
    const now = this.now();
    const proposal = rows.map((a) => ({ id: newMatchId(now), disposalId, lotId: a.lotId, quantity: dec(a.quantity) }));
    return { proposal, disposal, result: this.checkProposal(input, proposal) };
  }

  /**
   * Engine result with `proposal` added, or LotMatchError. Rejects both
   * problems with the proposal itself and proposals that would make an
   * existing (currently valid) decision invalid, e.g. by taking lot quantity a
   * later sale already relies on.
   */
  private checkProposal(input: LotEngineInput, proposal: readonly LotMatchInstruction[]): LotEngineResult {
    const before = invalidMatchIds(runLotEngine(input).issues);
    const { valid, problems, preview } = validateMatchProposal(input, proposal);
    if (!valid) {
      throw new LotMatchError(
        problems.flatMap((p) => (p.code === "invalid_lot_match" ? [{ lotId: p.lotId, problem: p.problem }] : [])),
      );
    }
    const proposedIds = new Set(proposal.map((p) => p.id));
    const broken = [...invalidMatchIds(preview.issues).values()].filter((i) => !proposedIds.has(i.matchId) && !before.has(i.matchId));
    if (broken.length > 0) {
      throw new LotMatchError(broken.map((i) => ({ lotId: i.lotId, problem: "would_invalidate_existing_match" as const })));
    }
    return preview;
  }

  private previewOf(result: LotEngineResult, disposal: Disposal, proposal: readonly LotMatchInstruction[]): MatchPreview {
    const ids = new Set(proposal.map((p) => p.id));
    const allocs = result.allocations.filter((a) => ids.has(a.matchId));
    const state = result.disposals.find((d) => d.disposal.id === disposal.id)!;
    const isSale = disposal.kind === "sale";
    return {
      kind: disposal.kind,
      allocations: allocs.map(allocationViews(result)),
      totals: {
        quantity: sum(allocs.map((a) => a.quantity)).toFixed(),
        acquisitionCost: totalOrNull(allocs.map((a) => a.allocatedAcquisitionCost)),
        buyFees: totalOrNull(allocs.map((a) => a.allocatedBuyFee)),
        grossProceeds: isSale ? totalOrNull(allocs.map((a) => a.grossSaleProceeds)) : null,
        sellFees: isSale ? totalOrNull(allocs.map((a) => a.allocatedSellFee)) : null,
        netProceeds: isSale ? totalOrNull(allocs.map((a) => a.netSaleProceeds)) : null,
        realizedPnl: isSale ? totalOrNull(allocs.map((a) => a.realizedPnl)) : null,
      },
      remainingToMatch: state.unmatchedQuantity.toFixed(),
    };
  }
}

function assetsOf(result: LotEngineResult): string[] {
  const set = new Set<string>([...result.lots.map((l) => l.asset), ...result.disposals.map((d) => d.disposal.asset)]);
  return [...set].sort();
}

function summaryOf(result: LotEngineResult, asset: string): AssetSummary {
  // No current price in Phase 3: value-dependent metrics are not shown.
  const m = calculatePositionMetrics(result, asset, null);
  const unresolved = result.disposals.filter((d) => d.disposal.asset === asset && d.unmatchedQuantity.greaterThan(ZERO));
  return {
    asset,
    holdings: m.holdings.toFixed(),
    openLots: result.lots.filter((l) => l.asset === asset && l.remainingQuantity.greaterThan(0)).length,
    costBasis: metricView(m.costBasis),
    averageCost: metricView(m.averageCost),
    realizedPnl: metricView(m.realizedPnl),
    unresolvedSales: unresolved.filter((d) => d.disposal.kind === "sale").length,
    unresolvedTransfers: unresolved.filter((d) => d.disposal.kind === "transfer_out").length,
    reviewRequired: m.reviewRequired,
  };
}

function disposalView(result: LotEngineResult, s: DisposalState, alloc: (a: LotAllocation) => AllocationView): DisposalView {
  const d = s.disposal;
  return {
    id: d.id,
    kind: d.kind,
    origin: d.origin,
    disposedAt: d.disposedAt.toISOString(),
    quantity: d.quantity.toFixed(),
    matchedQuantity: s.matchedQuantity.toFixed(),
    unmatchedQuantity: s.unmatchedQuantity.toFixed(),
    status: s.status,
    unitPrice: str(d.unitPrice),
    priceAsset: d.priceAsset,
    proceeds: proceedsView(s.proceeds, s.proceedsSource),
    candidates: candidateLotsFor(result, d.id).map(({ lot, available }) => ({
      lotId: lot.id,
      acquiredAt: lot.acquiredAt.toISOString(),
      origin: lot.origin,
      available: available.toFixed(),
      unitPrice: str(lot.unitPrice),
      priceAsset: lot.priceAsset,
      remainingCost: str(lot.remainingCost),
      costBasisStatus: lot.costBasisStatus,
    })),
    matches: result.allocations.filter((a) => a.disposalId === d.id).map(alloc),
  };
}
