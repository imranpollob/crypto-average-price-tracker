import type { Lot, LotAllocation, LotEngineResult, LotMatchInstruction, ManualValuation } from "@/domain/lots/types";
import { tradeKey, transferKey } from "@/domain/transactions/identity";
import type { Db } from "./client";
import { d2s, d2sOrNull, s2d } from "./codec";

/**
 * Persistence for the lot workflow. Only two kinds of rows here are user
 * decisions — lot_matches.quantity/lot_id/disposal_key and manual_valuations —
 * everything else (lots, match snapshot columns) is a projection rewritten from
 * the lot engine's output on every rebuild. Imported history is never touched.
 */

type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

export type ValuationTargetType = "acquisition" | "disposal";

export interface NewMatchRow {
  readonly instruction: LotMatchInstruction;
  readonly matchType: "sale" | "transfer_out";
  /** Source key of the disposing trade / transfer (see transactions/identity). */
  readonly disposalSourceKey: string;
}

export interface MatchChange {
  readonly insert?: readonly NewMatchRow[];
  readonly update?: { readonly id: string; readonly lotId: string; readonly quantity: string };
  readonly deleteIds?: readonly string[];
}

/** First segment after the record type is the account: "trade:<account>:<id>", "transfer:<account>:<id>". */
function accountOfKey(key: string): string | undefined {
  return key.split(":")[1];
}

function lotRow(lot: Lot, sourceIds: SourceIds) {
  return {
    id: lot.id,
    providerAccountId: lot.providerAccountId,
    sourceTradeId: lot.sourceType === "trade" ? (sourceIds.trades.get(lot.sourceKey) ?? null) : null,
    sourceTransferId: lot.sourceType === "transfer" ? (sourceIds.transfers.get(lot.sourceKey) ?? null) : null,
    asset: lot.asset,
    originalQuantity: d2s(lot.originalQuantity),
    remainingQuantity: d2s(lot.remainingQuantity),
    acquisitionPrice: d2sOrNull(lot.unitPrice),
    priceAsset: lot.priceAsset,
    acquisitionCost: d2sOrNull(lot.acquisitionCost),
    acquisitionFee: d2sOrNull(lot.acquisitionFee),
    remainingCost: d2sOrNull(lot.remainingCost),
    acquiredAt: lot.acquiredAt,
    costBasisStatus: lot.costBasisStatus as string,
  };
}

type LotRowData = ReturnType<typeof lotRow>;

function sameLot(a: LotRowData, b: LotRowData): boolean {
  return (Object.keys(a) as (keyof LotRowData)[]).every((k) => {
    const x = a[k];
    const y = b[k];
    return x instanceof Date && y instanceof Date ? x.getTime() === y.getTime() : x === y;
  });
}

function snapshot(a: LotAllocation | undefined) {
  return {
    allocatedAcquisitionCost: a ? d2sOrNull(a.allocatedAcquisitionCost) : null,
    allocatedBuyFee: a ? d2sOrNull(a.allocatedBuyFee) : null,
    grossSaleProceeds: a ? d2sOrNull(a.grossSaleProceeds) : null,
    allocatedSellFee: a ? d2sOrNull(a.allocatedSellFee) : null,
    realizedPnl: a ? d2sOrNull(a.realizedPnl) : null,
  };
}

interface SourceIds {
  readonly trades: ReadonlyMap<string, string>;
  readonly transfers: ReadonlyMap<string, string>;
}

export class LotRepository {
  constructor(private readonly db: Db) {}

  /**
   * The account's match decisions in application order. Ids are generated
   * time-ordered (see newMatchId), so ordering by id reproduces the order in
   * which the user made them — the engine applies matches of one disposal in
   * array order, which fixes proportional-allocation rounding deterministically.
   */
  async loadMatches(providerAccountId: string): Promise<LotMatchInstruction[]> {
    const rows = await this.db.lotMatch.findMany({
      where: { lot: { providerAccountId } },
      orderBy: { id: "asc" },
      select: { id: true, disposalKey: true, lotId: true, quantity: true },
    });
    return rows.map((r) => ({ id: r.id, disposalId: r.disposalKey, lotId: r.lotId, quantity: s2d(r.quantity) }));
  }

  async loadManualValuations(providerAccountId: string): Promise<ManualValuation[]> {
    const rows = await this.db.manualValuation.findMany({ orderBy: [{ targetType: "asc" }, { targetKey: "asc" }] });
    return rows
      .filter((r) => accountOfKey(r.targetKey) === providerAccountId)
      .map((r) => ({ targetId: r.targetKey, gross: s2d(r.gross), fee: s2d(r.fee) }));
  }

  async upsertManualValuation(target: { type: ValuationTargetType; key: string }, gross: string, fee: string, note: string | null): Promise<void> {
    await this.db.manualValuation.upsert({
      where: { targetType_targetKey: { targetType: target.type, targetKey: target.key } },
      create: { targetType: target.type, targetKey: target.key, gross, fee, note },
      update: { gross, fee, note },
    });
  }

  async deleteManualValuation(target: { type: ValuationTargetType; key: string }): Promise<void> {
    await this.db.manualValuation.deleteMany({ where: { targetType: target.type, targetKey: target.key } });
  }

  /**
   * Atomically: bring the lot projection in line with `result`, apply the match
   * decision change, and refresh every match's snapshot columns. `result` must
   * already reflect `change` (it is the engine output with the change applied).
   */
  async commit(providerAccountId: string, result: LotEngineResult, change: MatchChange = {}): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const sourceIds = await loadSourceIds(tx, providerAccountId);
      const lots = result.lots.filter((l) => l.providerAccountId === providerAccountId);

      const existing = new Map(
        (await tx.lot.findMany({ where: { providerAccountId } })).map((r) => [
          r.id,
          {
            id: r.id,
            providerAccountId: r.providerAccountId,
            sourceTradeId: r.sourceTradeId,
            sourceTransferId: r.sourceTransferId,
            asset: r.asset,
            originalQuantity: r.originalQuantity,
            remainingQuantity: r.remainingQuantity,
            acquisitionPrice: r.acquisitionPrice,
            priceAsset: r.priceAsset,
            acquisitionCost: r.acquisitionCost,
            acquisitionFee: r.acquisitionFee,
            remainingCost: r.remainingCost,
            acquiredAt: r.acquiredAt,
            costBasisStatus: r.costBasisStatus,
          } satisfies LotRowData,
        ]),
      );
      const current = new Set<string>();
      for (const lot of lots) {
        const row = lotRow(lot, sourceIds);
        current.add(row.id);
        const prev = existing.get(row.id);
        if (!prev) await tx.lot.create({ data: row });
        else if (!sameLot(prev, row)) await tx.lot.update({ where: { id: row.id }, data: row });
      }

      if (change.deleteIds?.length) await tx.lotMatch.deleteMany({ where: { id: { in: [...change.deleteIds] } } });
      if (change.update) {
        await tx.lotMatch.update({ where: { id: change.update.id }, data: { lotId: change.update.lotId, quantity: change.update.quantity } });
      }
      for (const m of change.insert ?? []) {
        await tx.lotMatch.create({
          data: {
            id: m.instruction.id,
            disposalKey: m.instruction.disposalId,
            matchType: m.matchType,
            sellTradeId: m.matchType === "sale" ? (sourceIds.trades.get(m.disposalSourceKey) ?? null) : null,
            transferId: m.matchType === "transfer_out" ? (sourceIds.transfers.get(m.disposalSourceKey) ?? null) : null,
            lotId: m.instruction.lotId,
            quantity: d2s(m.instruction.quantity),
          },
        });
      }

      // Lots that history no longer produces. Ones still referenced by a user
      // decision are kept: deleting them would destroy the decision, and the
      // engine already reports such a match as invalid (unknown_lot).
      const stale = [...existing.keys()].filter((id) => !current.has(id));
      if (stale.length > 0) await tx.lot.deleteMany({ where: { id: { in: stale }, matches: { none: {} } } });

      const allocations = new Map(result.allocations.map((a) => [a.matchId, a]));
      const matchRows = await tx.lotMatch.findMany({ where: { lot: { providerAccountId } } });
      for (const r of matchRows) {
        const next = snapshot(allocations.get(r.id));
        const changed = (Object.keys(next) as (keyof typeof next)[]).some((k) => r[k] !== next[k]);
        if (changed) await tx.lotMatch.update({ where: { id: r.id }, data: next });
      }
    });
  }
}

async function loadSourceIds(tx: Tx, providerAccountId: string): Promise<SourceIds> {
  const [trades, transfers] = await Promise.all([
    tx.trade.findMany({ where: { providerAccountId }, select: { id: true, providerAccountId: true, externalTradeId: true } }),
    tx.transfer.findMany({ where: { providerAccountId }, select: { id: true, providerAccountId: true, externalTransferId: true } }),
  ]);
  return {
    trades: new Map(trades.map((t) => [tradeKey(t), t.id])),
    transfers: new Map(transfers.map((t) => [transferKey(t), t.id])),
  };
}
