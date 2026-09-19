import { allocateProportionally, type Decimal, ZERO } from "../decimal";
import type {
  Acquisition,
  CostBasisStatus,
  Disposal,
  DisposalState,
  EngineIssue,
  InvalidMatchProblem,
  Lot,
  LotAllocation,
  LotEngineInput,
  LotEngineResult,
  LotMatchInstruction,
  ManualValuation,
  UnknownValueReason,
  Valuation,
} from "./types";

/**
 * The lot engine: a pure function from (asset flows + user decisions) to lots,
 * allocations and issues.
 *
 *  - Every acquisition becomes a lot. There is no global average price.
 *  - Lots are only closed by explicit match instructions — V1 never guesses
 *    which lot a sale closed (no FIFO/LIFO default).
 *  - Matches are applied in chronological disposal order and validated against
 *    the lot's remaining quantity at that point; invalid ones are rejected and
 *    reported, never partially applied.
 *  - Partial closes allocate cost and fees proportionally from what remains, and
 *    the final close takes the exact remainder, so cost is conserved exactly:
 *    Σ allocated + remaining = original, with no rounding residue.
 */
export function runLotEngine(input: LotEngineInput): LotEngineResult {
  const issues: EngineIssue[] = [];
  const valuations = indexValuations(input, issues);

  const lots = new Map<string, WorkingLot>();
  for (const a of input.acquisitions) {
    if (lots.has(a.id)) throw new Error(`Duplicate acquisition id: ${a.id}`);
    lots.set(a.id, createWorkingLot(a, valuations.get(a.id)));
  }

  const disposals = new Map<string, WorkingDisposal>();
  for (const d of input.disposals) {
    if (disposals.has(d.id)) throw new Error(`Duplicate disposal id: ${d.id}`);
    disposals.set(d.id, createWorkingDisposal(d, valuations.get(d.id)));
  }

  const matchesByDisposal = new Map<string, LotMatchInstruction[]>();
  for (const m of input.matches) {
    if (!disposals.has(m.disposalId)) {
      issues.push(invalid(m, null, "unknown_disposal"));
      continue;
    }
    const list = matchesByDisposal.get(m.disposalId) ?? [];
    list.push(m);
    matchesByDisposal.set(m.disposalId, list);
  }

  const allocations: LotAllocation[] = [];
  const orderedDisposals = [...disposals.values()].sort((a, b) =>
    compareEvents(a.disposal.disposedAt, a.disposal.id, b.disposal.disposedAt, b.disposal.id),
  );

  for (const wd of orderedDisposals) {
    for (const m of matchesByDisposal.get(wd.disposal.id) ?? []) {
      const problem = validateMatch(m, wd, lots.get(m.lotId));
      if (problem) {
        issues.push(invalid(m, wd.disposal.asset, problem));
        continue;
      }
      allocations.push(applyMatch(m, wd, lots.get(m.lotId)!));
    }
  }

  const disposalStates = orderedDisposals.map(finishDisposal);
  for (const s of disposalStates) {
    if (s.unmatchedQuantity.greaterThan(0)) {
      issues.push({
        code: s.disposal.kind === "sale" ? "unmatched_sale" : "unresolved_transfer_out",
        disposalId: s.disposal.id,
        asset: s.disposal.asset,
        unmatchedQuantity: s.unmatchedQuantity,
      });
    }
    if (s.proceeds?.status === "unknown") {
      issues.push({
        code: "unknown_proceeds",
        disposalId: s.disposal.id,
        asset: s.disposal.asset,
        reason: s.proceeds.reason,
      });
    }
  }

  const finishedLots = [...lots.values()]
    .map(finishLot)
    .sort((a, b) => compareEvents(a.acquiredAt, a.id, b.acquiredAt, b.id));

  // An unknown-cost lot matters while it is open or once it has fed a sale.
  const soldLotIds = new Set(allocations.filter((a) => a.kind === "sale").map((a) => a.lotId));
  for (const lot of finishedLots) {
    if (
      lot.costBasisStatus === "unknown" &&
      (lot.remainingQuantity.greaterThan(0) || soldLotIds.has(lot.id))
    ) {
      issues.push({
        code: "unknown_cost_basis",
        lotId: lot.id,
        asset: lot.asset,
        reason: lot.unknownCostReason!,
      });
    }
  }

  issues.push(...findHistoryShortfalls(input.acquisitions, input.disposals));
  for (const f of input.dataQualityFlags ?? []) {
    issues.push({ code: "data_quality", asset: f.asset, reason: f.reason, detail: f.detail, sourceKey: f.sourceKey });
  }

  return { lots: finishedLots, allocations, disposals: disposalStates, issues };
}

// ---------------------------------------------------------------------------

interface WorkingLot {
  readonly acquisition: Acquisition;
  readonly costBasisStatus: CostBasisStatus;
  readonly unknownCostReason: UnknownValueReason | null;
  readonly acquisitionCost: Decimal | null;
  readonly acquisitionFee: Decimal | null;
  remainingQuantity: Decimal;
  remainingCost: Decimal | null;
  remainingFee: Decimal | null;
}

interface WorkingDisposal {
  readonly disposal: Disposal;
  readonly proceeds: Valuation | null;
  readonly proceedsSource: "provider" | "manual" | null;
  remainingQuantity: Decimal;
  remainingGross: Decimal | null;
  remainingFee: Decimal | null;
}

function indexValuations(input: LotEngineInput, issues: EngineIssue[]): Map<string, ManualValuation> {
  const targets = new Set<string>([
    ...input.acquisitions.map((a) => a.id),
    ...input.disposals.filter((d) => d.kind === "sale").map((d) => d.id),
  ]);
  const map = new Map<string, ManualValuation>();
  for (const v of input.manualValuations ?? []) {
    if (v.gross.isNegative() || v.fee.isNegative()) {
      throw new Error(`Manual valuation for ${v.targetId} must not be negative`);
    }
    if (!targets.has(v.targetId)) {
      issues.push({ code: "orphan_manual_valuation", targetId: v.targetId });
      continue;
    }
    map.set(v.targetId, v);
  }
  return map;
}

function createWorkingLot(a: Acquisition, manual: ManualValuation | undefined): WorkingLot {
  if (!a.quantity.greaterThan(0)) throw new Error(`Acquisition ${a.id} has non-positive quantity`);
  let status: CostBasisStatus;
  let cost: Decimal | null;
  let fee: Decimal | null;
  let reason: UnknownValueReason | null = null;
  if (manual) {
    status = "manual";
    cost = manual.gross.plus(manual.fee);
    fee = manual.fee;
  } else if (a.cost.status === "known") {
    status = "known";
    cost = a.cost.gross.plus(a.cost.fee);
    fee = a.cost.fee;
  } else {
    status = "unknown";
    cost = null;
    fee = null;
    reason = a.cost.reason;
  }
  return {
    acquisition: a,
    costBasisStatus: status,
    unknownCostReason: reason,
    acquisitionCost: cost,
    acquisitionFee: fee,
    remainingQuantity: a.quantity,
    remainingCost: cost,
    remainingFee: fee,
  };
}

function createWorkingDisposal(d: Disposal, manual: ManualValuation | undefined): WorkingDisposal {
  if (!d.quantity.greaterThan(0)) throw new Error(`Disposal ${d.id} has non-positive quantity`);
  let proceeds: Valuation | null = d.proceeds;
  let source: WorkingDisposal["proceedsSource"] = d.kind === "sale" ? "provider" : null;
  if (manual && d.kind === "sale") {
    proceeds = { status: "known", gross: manual.gross, fee: manual.fee };
    source = "manual";
  }
  const known = proceeds?.status === "known" ? proceeds : null;
  return {
    disposal: d,
    proceeds,
    proceedsSource: source,
    remainingQuantity: d.quantity,
    remainingGross: known ? known.gross : null,
    remainingFee: known ? known.fee : null,
  };
}

function validateMatch(
  m: LotMatchInstruction,
  wd: WorkingDisposal,
  lot: WorkingLot | undefined,
): InvalidMatchProblem | null {
  if (!lot) return "unknown_lot";
  const d = wd.disposal;
  const a = lot.acquisition;
  if (a.asset !== d.asset) return "asset_mismatch";
  if (a.providerAccountId !== d.providerAccountId) return "account_mismatch";
  if (a.acquiredAt.getTime() > d.disposedAt.getTime()) return "lot_acquired_after_disposal";
  if (!m.quantity.greaterThan(0)) return "non_positive_quantity";
  if (m.quantity.greaterThan(wd.remainingQuantity)) return "exceeds_disposal_remaining";
  if (m.quantity.greaterThan(lot.remainingQuantity)) return "exceeds_lot_remaining";
  return null;
}

function applyMatch(m: LotMatchInstruction, wd: WorkingDisposal, lot: WorkingLot): LotAllocation {
  const qty = m.quantity;

  const cost =
    lot.remainingCost === null
      ? null
      : allocateProportionally(lot.remainingCost, qty, lot.remainingQuantity);
  const buyFee =
    lot.remainingFee === null
      ? null
      : allocateProportionally(lot.remainingFee, qty, lot.remainingQuantity);
  lot.remainingCost = lot.remainingCost === null ? null : lot.remainingCost.minus(cost!);
  lot.remainingFee = lot.remainingFee === null ? null : lot.remainingFee.minus(buyFee!);
  lot.remainingQuantity = lot.remainingQuantity.minus(qty);

  const isSale = wd.disposal.kind === "sale";
  let gross: Decimal | null = null;
  let sellFee: Decimal | null = null;
  if (isSale && wd.remainingGross !== null && wd.remainingFee !== null) {
    gross = allocateProportionally(wd.remainingGross, qty, wd.remainingQuantity);
    sellFee = allocateProportionally(wd.remainingFee, qty, wd.remainingQuantity);
    wd.remainingGross = wd.remainingGross.minus(gross);
    wd.remainingFee = wd.remainingFee.minus(sellFee);
  }
  wd.remainingQuantity = wd.remainingQuantity.minus(qty);

  const net = gross !== null && sellFee !== null ? gross.minus(sellFee) : null;
  return {
    matchId: m.id,
    disposalId: wd.disposal.id,
    lotId: lot.acquisition.id,
    kind: wd.disposal.kind,
    asset: wd.disposal.asset,
    providerAccountId: wd.disposal.providerAccountId,
    quantity: qty,
    lotAcquiredAt: lot.acquisition.acquiredAt,
    disposedAt: wd.disposal.disposedAt,
    lotUnitPrice: lot.acquisition.unitPrice,
    disposalUnitPrice: wd.disposal.unitPrice,
    allocatedAcquisitionCost: cost,
    allocatedBuyFee: buyFee,
    grossSaleProceeds: gross,
    allocatedSellFee: sellFee,
    netSaleProceeds: net,
    realizedPnl: isSale && net !== null && cost !== null ? net.minus(cost) : null,
  };
}

function finishDisposal(wd: WorkingDisposal): DisposalState {
  const matched = wd.disposal.quantity.minus(wd.remainingQuantity);
  return {
    disposal: wd.disposal,
    matchedQuantity: matched,
    unmatchedQuantity: wd.remainingQuantity,
    status: wd.remainingQuantity.isZero() ? "matched" : matched.isZero() ? "unmatched" : "partially_matched",
    proceeds: wd.proceeds,
    proceedsSource: wd.proceedsSource,
  };
}

function finishLot(w: WorkingLot): Lot {
  const a = w.acquisition;
  return {
    id: a.id,
    provider: a.provider,
    providerAccountId: a.providerAccountId,
    sourceType: a.sourceType,
    sourceKey: a.sourceKey,
    origin: a.origin,
    asset: a.asset,
    acquiredAt: a.acquiredAt,
    unitPrice: a.unitPrice,
    priceAsset: a.priceAsset,
    originalQuantity: a.quantity,
    remainingQuantity: w.remainingQuantity,
    costBasisStatus: w.costBasisStatus,
    unknownCostReason: w.unknownCostReason,
    acquisitionCost: w.acquisitionCost,
    acquisitionFee: w.acquisitionFee,
    remainingCost: w.remainingCost,
    remainingFee: w.remainingFee,
  };
}

/**
 * Walk each (account, asset) balance chronologically. If it ever goes negative,
 * more left the account than ever arrived: history is missing.
 * Same-timestamp inflows are applied before outflows.
 */
function findHistoryShortfalls(
  acquisitions: readonly Acquisition[],
  disposals: readonly Disposal[],
): EngineIssue[] {
  type Ev = { at: number; delta: Decimal; inflow: boolean; account: string; asset: string };
  const groups = new Map<string, Ev[]>();
  const push = (e: Ev) => {
    const k = `${e.account}\u0000${e.asset}`;
    const list = groups.get(k) ?? [];
    list.push(e);
    groups.set(k, list);
  };
  for (const a of acquisitions) {
    push({ at: a.acquiredAt.getTime(), delta: a.quantity, inflow: true, account: a.providerAccountId, asset: a.asset });
  }
  for (const d of disposals) {
    push({ at: d.disposedAt.getTime(), delta: d.quantity.negated(), inflow: false, account: d.providerAccountId, asset: d.asset });
  }

  const issues: EngineIssue[] = [];
  for (const events of groups.values()) {
    events.sort((x, y) => x.at - y.at || Number(y.inflow) - Number(x.inflow));
    let balance = ZERO;
    let lowest = ZERO;
    for (const e of events) {
      balance = balance.plus(e.delta);
      if (balance.lessThan(lowest)) lowest = balance;
    }
    if (lowest.isNegative()) {
      const first = events[0]!;
      issues.push({
        code: "insufficient_history",
        asset: first.asset,
        providerAccountId: first.account,
        shortfall: lowest.negated(),
      });
    }
  }
  return issues;
}

function invalid(
  m: LotMatchInstruction,
  asset: string | null,
  problem: InvalidMatchProblem,
): EngineIssue {
  return { code: "invalid_lot_match", matchId: m.id, disposalId: m.disposalId, lotId: m.lotId, asset, problem };
}

function compareEvents(atA: Date, idA: string, atB: Date, idB: string): number {
  return atA.getTime() - atB.getTime() || (idA < idB ? -1 : idA > idB ? 1 : 0);
}
