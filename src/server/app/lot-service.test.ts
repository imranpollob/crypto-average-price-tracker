import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncService } from "@/application/sync/sync-service";
import { createAccountingConfig } from "@/domain/accounting/config";
import { dec } from "@/domain/decimal";
import { valueOf } from "@/domain/metric";
import { calculatePositionMetrics } from "@/domain/pnl/position";
import type { NormalizedTrade, NormalizedTransfer } from "@/domain/transactions/types";
import { FakeKraken } from "@/providers/kraken/testing/fake-kraken";
import { krakenHarness, ks } from "@/providers/kraken/testing/harness";
import type { Db } from "@/server/db/client";
import { tradeToRow, transferToRow } from "@/server/db/codec";
import { HistoryRepository } from "@/server/db/history-repository";
import { PrismaSyncStore } from "@/server/db/prisma-sync-store";
import { buy, day, deposit, flowId, sell, withdrawal } from "@/test/builders";
import { createTestDb } from "@/test/test-db";
import { LotMatchError, LotService, newMatchId } from "./lot-service";

/**
 * Phase 3: lot persistence, manual matching, rebuilds — against a real SQLite
 * database. Pure lot-engine arithmetic is covered in domain/lots/engine.test.ts;
 * these tests cover storing decisions and rebuilding from them.
 */

const config = createAccountingConfig("USD");

let db: Db;
let cleanup: () => Promise<void>;
let repo: HistoryRepository;
let acct: string;
let svc: LotService;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  repo = new HistoryRepository(db);
  await repo.ensureProvider("kraken", "exchange", "Kraken");
  acct = await repo.createAccount("kraken", "Kraken");
  svc = new LotService(db, config);
});

afterEach(async () => {
  await cleanup();
});

async function seed(trades: NormalizedTrade[], transfers: NormalizedTransfer[] = []) {
  if (trades.length) await db.trade.createMany({ data: trades.map(tradeToRow) });
  if (transfers.length) await db.transfer.createMany({ data: transfers.map(transferToRow) });
}

const s = (d: { toFixed(): string } | null) => (d === null ? null : d.toFixed());
const lotRow = (t: NormalizedTrade | NormalizedTransfer) => db.lot.findUniqueOrThrow({ where: { id: flowId(t) } });

async function expectRejected(p: Promise<unknown>, problem: string) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(LotMatchError);
  expect((e as LotMatchError).problems.map((x) => x.problem)).toContain(problem);
  expect(await db.lotMatch.count()).toBe(0);
}

// --- lot creation ---------------------------------------------------------------

describe("#1-2 lot creation", () => {
  it("one buy creates one persisted lot; cost basis includes the buy fee", async () => {
    const b = buy("100", "10", { account: acct, fee: "5" });
    await seed([b]);
    await svc.rebuild(acct);
    const lot = await lotRow(b);
    expect(lot).toMatchObject({
      asset: "ADA",
      originalQuantity: "100",
      remainingQuantity: "100",
      acquisitionPrice: "10",
      priceAsset: "USD",
      acquisitionCost: "1005",
      acquisitionFee: "5",
      remainingCost: "1005",
      costBasisStatus: "known",
    });
    const trade = await db.trade.findFirstOrThrow();
    expect(lot.sourceTradeId).toBe(trade.id);
  });

  it("multiple buys create multiple lots", async () => {
    await seed([buy("100", "0.20", { account: acct }), buy("100", "0.10", { account: acct })]);
    await svc.rebuild(acct);
    const lots = await db.lot.findMany({ orderBy: { acquiredAt: "asc" } });
    expect(lots.map((l) => [l.originalQuantity, l.acquisitionCost])).toEqual([
      ["100", "20"],
      ["100", "10"],
    ]);
  });
});

// --- sale matching --------------------------------------------------------------

describe("#3-8 sale matching", () => {
  it("full lot sale: realized P/L = net proceeds − cost incl. fees (+291)", async () => {
    const b = buy("100", "10", { account: acct, fee: "5" });
    const x = sell("100", "13", { account: acct, fee: "4" });
    await seed([b, x]);
    await svc.saveMatches(acct, flowId(x), [{ lotId: flowId(b), quantity: "100" }]);
    const m = await db.lotMatch.findFirstOrThrow();
    expect(m).toMatchObject({
      disposalKey: flowId(x),
      matchType: "sale",
      lotId: flowId(b),
      quantity: "100",
      allocatedAcquisitionCost: "1005",
      allocatedBuyFee: "5",
      grossSaleProceeds: "1300",
      allocatedSellFee: "4",
      realizedPnl: "291",
    });
    expect(m.sellTradeId).toBe((await db.trade.findFirstOrThrow({ where: { externalTradeId: x.externalTradeId } })).id);
    expect((await lotRow(b)).remainingQuantity).toBe("0");
  });

  it("matching the cheaper vs. the more expensive lot gives different realized P/L", async () => {
    const a = buy("100", "20", { account: acct });
    const b = buy("100", "10", { account: acct });
    const x = sell("100", "13", { account: acct });
    await seed([a, b, x]);
    const cheap = await svc.preview(acct, flowId(x), [{ lotId: flowId(b), quantity: "100" }]);
    const dear = await svc.preview(acct, flowId(x), [{ lotId: flowId(a), quantity: "100" }]);
    expect(cheap.totals.realizedPnl).toBe("300");
    expect(dear.totals.realizedPnl).toBe("-700");
    // Preview persists nothing.
    expect(await db.lotMatch.count()).toBe(0);
  });

  it("total P/L is the same whichever lot is chosen (only the realized/unrealized split moves)", async () => {
    const a = buy("100", "20", { account: acct });
    const b = buy("100", "10", { account: acct });
    const x = sell("100", "13", { account: acct });
    await seed([a, b, x]);
    const r1 = await svc.saveMatches(acct, flowId(x), [{ lotId: flowId(b), quantity: "100" }]);
    const matchId = (await db.lotMatch.findFirstOrThrow()).id;
    const r2 = await svc.editMatch(acct, matchId, flowId(a), "100");
    const m1 = calculatePositionMetrics(r1, "ADA", dec("15"));
    const m2 = calculatePositionMetrics(r2, "ADA", dec("15"));
    expect([s(valueOf(m1.realizedPnl)), s(valueOf(m2.realizedPnl))]).toEqual(["300", "-700"]);
    // 2 × 100 bought for 3000, 100 sold for 1300, 100 held at 15 = +(1300 + 1500 − 3000) = −200 either way.
    expect([s(valueOf(m1.totalPnl)), s(valueOf(m2.totalPnl))]).toEqual(["-200", "-200"]);
  });

  it("partial lot close keeps the rest of the lot and its proportional cost open", async () => {
    const b = buy("100", "10", { account: acct, fee: "5" });
    const x = sell("25", "13", { account: acct });
    await seed([b, x]);
    await svc.saveMatches(acct, flowId(x), [{ lotId: flowId(b), quantity: "25" }]);
    expect(await lotRow(b)).toMatchObject({ remainingQuantity: "75", remainingCost: "753.75" });
    expect((await db.lotMatch.findFirstOrThrow()).allocatedAcquisitionCost).toBe("251.25");
  });

  it("one sell across two lots, with the sale fee split by quantity (2 + 1)", async () => {
    const a = buy("100", "10", { account: acct });
    const b = buy("100", "12", { account: acct });
    const x = sell("150", "14", { account: acct, fee: "3" });
    await seed([a, b, x]);
    await svc.saveMatches(acct, flowId(x), [
      { lotId: flowId(a), quantity: "100" },
      { lotId: flowId(b), quantity: "50" },
    ]);
    expect((await lotRow(a)).remainingQuantity).toBe("0");
    expect((await lotRow(b)).remainingQuantity).toBe("50");
    const rows = await db.lotMatch.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((r) => [r.lotId, r.allocatedSellFee, r.realizedPnl])).toEqual([
      [flowId(a), "2", "398"],
      [flowId(b), "1", "99"],
    ]);
  });

  it("one sell across three lots", async () => {
    const lots = [buy("50", "1", { account: acct }), buy("50", "2", { account: acct }), buy("50", "3", { account: acct })];
    const x = sell("150", "4", { account: acct });
    await seed([...lots, x]);
    const r = await svc.saveMatches(acct, flowId(x), lots.map((l) => ({ lotId: flowId(l), quantity: "50" })));
    expect(r.disposals.find((d) => d.disposal.id === flowId(x))!.status).toBe("matched");
    expect(r.allocations.map((a) => a.realizedPnl!.toFixed())).toEqual(["150", "100", "50"]);
  });

  it("a partially matched sale stays partially matched, and realized P/L stays incomplete", async () => {
    const a = buy("100", "10", { account: acct });
    const b = buy("100", "12", { account: acct });
    const x = sell("150", "14", { account: acct });
    await seed([a, b, x]);
    const p = await svc.preview(acct, flowId(x), [{ lotId: flowId(a), quantity: "100" }]);
    expect(p.remainingToMatch).toBe("50");
    const r = await svc.saveMatches(acct, flowId(x), [{ lotId: flowId(a), quantity: "100" }]);
    const state = r.disposals.find((d) => d.disposal.id === flowId(x))!;
    expect([state.status, s(state.matchedQuantity), s(state.unmatchedQuantity)]).toEqual(["partially_matched", "100", "50"]);
    const [summary] = await svc.summaries(acct);
    expect(summary!.realizedPnl).toEqual({ status: "incomplete", reasons: ["unmatched_sale"] });
    expect(summary!.costBasis).toEqual({ status: "incomplete", reasons: ["unmatched_sale"] });
  });
});

// --- validation -----------------------------------------------------------------

describe("#11-14, #39-40 invalid assignments are rejected and nothing is saved", () => {
  it("allocation greater than the sale", async () => {
    const b = buy("200", "10", { account: acct });
    const x = sell("100", "13", { account: acct });
    await seed([b, x]);
    await expectRejected(svc.saveMatches(acct, flowId(x), [{ lotId: flowId(b), quantity: "150" }]), "exceeds_disposal_remaining");
  });

  it("allocation greater than the lot's remaining quantity", async () => {
    const b = buy("50", "10", { account: acct });
    const x = sell("100", "13", { account: acct });
    await seed([b, x]);
    await expectRejected(svc.saveMatches(acct, flowId(x), [{ lotId: flowId(b), quantity: "60" }]), "exceeds_lot_remaining");
  });

  it("a lot of a different asset", async () => {
    const b = buy("1", "50000", { account: acct, base: "BTC" });
    const x = sell("1", "13", { account: acct });
    await seed([buy("1", "10", { account: acct }), b, x]);
    await expectRejected(svc.saveMatches(acct, flowId(x), [{ lotId: flowId(b), quantity: "1" }]), "asset_mismatch");
  });

  it("a lot acquired after the sale", async () => {
    const early = buy("100", "10", { account: acct, at: day(100) });
    const x = sell("100", "13", { account: acct, at: day(105) });
    const later = buy("100", "9", { account: acct, at: day(110) });
    await seed([early, x, later]);
    await expectRejected(svc.saveMatches(acct, flowId(x), [{ lotId: flowId(later), quantity: "100" }]), "lot_acquired_after_disposal");
  });

  it.each([["0"], ["-5"]])("non-positive quantity %s", async (q) => {
    const b = buy("100", "10", { account: acct });
    const x = sell("100", "13", { account: acct });
    await seed([b, x]);
    await expectRejected(svc.saveMatches(acct, flowId(x), [{ lotId: flowId(b), quantity: q }]), "non_positive_quantity");
  });

  it.each([["abc"], ["1,5"], ["1e"], ["NaN"]])("invalid decimal input %s", async (q) => {
    const b = buy("100", "10", { account: acct });
    const x = sell("100", "13", { account: acct });
    await seed([b, x]);
    await expectRejected(svc.saveMatches(acct, flowId(x), [{ lotId: flowId(b), quantity: q }]), "invalid_decimal");
  });

  it("an empty allocation", async () => {
    const x = sell("100", "13", { account: acct });
    await seed([buy("100", "10", { account: acct }), x]);
    await expectRejected(svc.saveMatches(acct, flowId(x), [{ lotId: "anything", quantity: "  " }]), "no_allocation");
  });

  it("a lot from another provider account (V1: no cross-account matching)", async () => {
    const other = await repo.createAccount("kraken", "Second");
    const foreign = buy("100", "10", { account: other });
    const x = sell("100", "13", { account: acct });
    await seed([foreign, buy("100", "11", { account: acct }), x]);
    // The other account's lots are not even part of this account's engine input.
    await expectRejected(svc.saveMatches(acct, flowId(x), [{ lotId: flowId(foreign), quantity: "100" }]), "unknown_lot");
  });

  it("an allocation that would take quantity a later sale's existing match relies on", async () => {
    const a = buy("100", "10", { account: acct, at: day(200) });
    const s1 = sell("60", "12", { account: acct, at: day(205) });
    const s2 = sell("60", "13", { account: acct, at: day(210) });
    await seed([a, s1, s2]);
    await svc.saveMatches(acct, flowId(s2), [{ lotId: flowId(a), quantity: "60" }]);
    // s1 is earlier, so the engine would apply it first and break s2's match.
    const e = await svc.saveMatches(acct, flowId(s1), [{ lotId: flowId(a), quantity: "60" }]).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(LotMatchError);
    expect((e as LotMatchError).problems.map((p) => p.problem)).toEqual(["would_invalidate_existing_match"]);
    expect(await db.lotMatch.count()).toBe(1);
    // Only the unclaimed 40 is offered for s1.
    const detail = await svc.assetDetail(acct, "ADA");
    const d1 = detail.unresolved.find((d) => d.id === flowId(s1))!;
    expect(d1.candidates.map((c) => c.available)).toEqual(["40"]);
  });
});

// --- fees and precision ---------------------------------------------------------

describe("#15-18, #34-36 fees and precision", () => {
  it("a sale fee split across lots sums exactly to the fee; the last share takes the exact remainder", async () => {
    const lots = [buy("1", "10", { account: acct }), buy("1", "10", { account: acct }), buy("1", "10", { account: acct })];
    const x = sell("3", "11", { account: acct, fee: "1" });
    await seed([...lots, x]);
    const r = await svc.saveMatches(acct, flowId(x), lots.map((l) => ({ lotId: flowId(l), quantity: "1" })));
    const fees = r.allocations.map((a) => a.allocatedSellFee!);
    expect(fees[0]!.toFixed()).toBe("0.333333333333333333333333333333333333");
    expect(fees.reduce((acc, f) => acc.plus(f)).toFixed()).toBe("1");
  });

  it("successive partial closes of one lot conserve its cost exactly (high-precision buy fee)", async () => {
    const b = buy("3", "0.1", { account: acct, fee: "0.0100000007" });
    const sales = [sell("1", "0.2", { account: acct }), sell("1", "0.2", { account: acct }), sell("1", "0.2", { account: acct })];
    await seed([b, ...sales]);
    for (const x of sales) await svc.saveMatches(acct, flowId(x), [{ lotId: flowId(b), quantity: "1" }]);
    const rows = await db.lotMatch.findMany();
    const allocated = rows.map((r) => dec(r.allocatedAcquisitionCost!)).reduce((a, c) => a.plus(c));
    expect(allocated.toFixed()).toBe("0.3100000007");
    expect(await lotRow(b)).toMatchObject({ remainingQuantity: "0", remainingCost: "0" });
  });

  it("fractional and dust-scale quantities round-trip exactly", async () => {
    const b = buy("0.0000034845", "150", { account: acct, base: "SOL" });
    const x = sell("0.0000034845", "160", { account: acct, base: "SOL" });
    await seed([b, x]);
    await svc.saveMatches(acct, flowId(x), [{ lotId: flowId(b), quantity: "0.0000034845" }]);
    const m = await db.lotMatch.findFirstOrThrow();
    expect(m).toMatchObject({ quantity: "0.0000034845", allocatedAcquisitionCost: "0.000522675", realizedPnl: "0.000034845" });
    expect((await lotRow(b)).remainingQuantity).toBe("0");
  });
});

// --- rebuild / edit / delete ----------------------------------------------------

describe("#19-22 rebuilds and editing decisions", () => {
  async function snapshotDb() {
    const [lots, matches] = await Promise.all([
      db.lot.findMany({ orderBy: { id: "asc" } }),
      db.lotMatch.findMany({ orderBy: { id: "asc" } }),
    ]);
    return { lots, matches };
  }

  it("repeated rebuilds produce identical rows (unchanged rows are not rewritten)", async () => {
    const a = buy("100", "10", { account: acct, fee: "1" });
    const x = sell("40", "13", { account: acct, fee: "0.5" });
    await seed([a, buy("10", "12", { account: acct }), x]);
    await svc.saveMatches(acct, flowId(x), [{ lotId: flowId(a), quantity: "40" }]);
    const first = await snapshotDb();
    await svc.rebuild(acct);
    await svc.rebuild(acct);
    expect(await snapshotDb()).toEqual(first);
  });

  it("saved matches survive a rebuild after new history arrives", async () => {
    const a = buy("100", "10", { account: acct });
    const x = sell("100", "13", { account: acct });
    await seed([a, x]);
    await svc.saveMatches(acct, flowId(x), [{ lotId: flowId(a), quantity: "100" }]);
    const before = await db.lotMatch.findFirstOrThrow();
    await seed([buy("5", "20", { account: acct })]);
    await svc.rebuild(acct);
    expect(await db.lotMatch.findFirstOrThrow()).toEqual(before);
    expect(await db.lot.count()).toBe(2);
  });

  it("changing a match moves the quantity and P/L to the new lot and restores the old one", async () => {
    const a = buy("100", "20", { account: acct });
    const b = buy("100", "10", { account: acct });
    const x = sell("100", "13", { account: acct });
    await seed([a, b, x]);
    await svc.saveMatches(acct, flowId(x), [{ lotId: flowId(b), quantity: "100" }]);
    const id = (await db.lotMatch.findFirstOrThrow()).id;
    await svc.editMatch(acct, id, flowId(a), "100");
    expect(await lotRow(a)).toMatchObject({ remainingQuantity: "0", remainingCost: "0" });
    expect(await lotRow(b)).toMatchObject({ remainingQuantity: "100", remainingCost: "1000" });
    expect(await db.lotMatch.findFirstOrThrow()).toMatchObject({ id, lotId: flowId(a), realizedPnl: "-700" });
  });

  it("an invalid edit is rejected and the original decision is kept", async () => {
    const a = buy("50", "20", { account: acct });
    const b = buy("100", "10", { account: acct });
    const x = sell("100", "13", { account: acct });
    await seed([a, b, x]);
    await svc.saveMatches(acct, flowId(x), [{ lotId: flowId(b), quantity: "100" }]);
    const before = await db.lotMatch.findFirstOrThrow();
    await expect(svc.editMatch(acct, before.id, flowId(a), "100")).rejects.toBeInstanceOf(LotMatchError);
    expect(await db.lotMatch.findFirstOrThrow()).toEqual(before);
  });

  it("deleting a match restores the lot's quantity and cost; the sale is unmatched again", async () => {
    const b = buy("100", "10", { account: acct, fee: "5" });
    const x = sell("60", "13", { account: acct });
    await seed([b, x]);
    await svc.saveMatches(acct, flowId(x), [{ lotId: flowId(b), quantity: "60" }]);
    const id = (await db.lotMatch.findFirstOrThrow()).id;
    const r = await svc.deleteMatch(acct, id);
    expect(await db.lotMatch.count()).toBe(0);
    expect(await lotRow(b)).toMatchObject({ remainingQuantity: "100", remainingCost: "1005" });
    expect(r.disposals[0]!.status).toBe("unmatched");
  });

  it("match ids are time-ordered, so stored order reproduces decision order", () => {
    const ids = [newMatchId(new Date(1000)), newMatchId(new Date(1000)), newMatchId(new Date(2000))];
    expect([...ids].sort()).toEqual(ids);
  });
});

// --- positions ------------------------------------------------------------------

describe("#23-24 closing and re-entering a position", () => {
  it("a fully matched position closes to zero, and a later buy opens a new position", async () => {
    const a = buy("100", "10", { account: acct });
    const x = sell("100", "13", { account: acct });
    await seed([a, x]);
    await svc.saveMatches(acct, flowId(x), [{ lotId: flowId(a), quantity: "100" }]);
    let [sum] = await svc.summaries(acct);
    expect(sum).toMatchObject({ holdings: "0", openLots: 0, costBasis: { status: "known", value: "0" }, averageCost: { status: "not_applicable" } });
    expect(sum!.realizedPnl).toEqual({ status: "known", value: "300" });

    await seed([buy("50", "8", { account: acct })]);
    [sum] = await svc.summaries(acct);
    expect(sum).toMatchObject({ holdings: "50", openLots: 1, costBasis: { status: "known", value: "400" }, averageCost: { status: "known", value: "8" } });
    expect(sum!.realizedPnl).toEqual({ status: "known", value: "300" });
  });
});

// --- non-sale disposals ---------------------------------------------------------

describe("#25-28, #32 transfers out", () => {
  it("a withdrawal consumes lot quantity and carries its cost basis, with no proceeds and no realized P/L", async () => {
    const b = buy("100", "10", { account: acct, fee: "2" });
    const w = withdrawal("ADA", "40", { account: acct });
    await seed([b], [w]);
    const r = await svc.saveMatches(acct, flowId(w), [{ lotId: flowId(b), quantity: "40" }]);
    const alloc = r.allocations[0]!;
    expect([alloc.kind, s(alloc.allocatedAcquisitionCost), alloc.grossSaleProceeds, alloc.netSaleProceeds, alloc.realizedPnl]).toEqual([
      "transfer_out",
      "400.8",
      null,
      null,
      null,
    ]);
    const m = await db.lotMatch.findFirstOrThrow();
    expect(m).toMatchObject({ matchType: "transfer_out", allocatedAcquisitionCost: "400.8", grossSaleProceeds: null, realizedPnl: null, sellTradeId: null });
    expect(m.transferId).toBe((await db.transfer.findFirstOrThrow()).id);
    expect(await lotRow(b)).toMatchObject({ remainingQuantity: "60", remainingCost: "601.2" });
    const [sum] = await svc.summaries(acct);
    // The removed basis is not a trading loss.
    expect(sum!.realizedPnl).toEqual({ status: "known", value: "0" });
    expect(sum!.costBasis).toEqual({ status: "known", value: "601.2" });
    const detail = await svc.assetDetail(acct, "ADA");
    expect(detail.saleMatches).toEqual([]);
    expect(detail.transferMatches.map((t) => t.allocatedAcquisitionCost)).toEqual(["400.8"]);
  });

  it("an unresolved withdrawal keeps open-position metrics incomplete", async () => {
    await seed([buy("100", "10", { account: acct })], [withdrawal("ADA", "40", { account: acct })]);
    const [sum] = await svc.summaries(acct);
    expect(sum!.costBasis).toEqual({ status: "incomplete", reasons: ["unresolved_transfer_out"] });
    expect(sum!.unresolvedTransfers).toBe(1);
    expect(sum!.reviewRequired).toBe(true);
  });

  it("#29 a Kraken dust sweep (imported through the real adapter) is a non-sale disposal", async () => {
    const fake = new FakeKraken()
      .addLedgerRow({ type: "deposit", asset: "KAS", amount: "10", time: ks("2026-09-01T00:00:00Z") }, "LDEPKAS")
      .addLedgerRow({ type: "spend", subtype: "dustsweeping", asset: "KAS", amount: "-0.00053", time: ks("2026-09-02T00:00:00Z") }, "LDUSTKAS");
    const h = krakenHarness({ fake, accountId: acct, startIso: "2026-09-24T12:00:00Z" });
    const sync = await new SyncService({ store: new PrismaSyncStore(db), now: () => new Date(h.clock.now()) }).sync(h.provider, "manual");
    expect(sync.ok).toBe(true);

    let detail = await svc.assetDetail(acct, "KAS");
    expect(detail.unresolved).toHaveLength(1);
    const dust = detail.unresolved[0]!;
    expect(dust).toMatchObject({ kind: "transfer_out", origin: "adjustment", quantity: "0.00053", proceeds: null });
    expect(dust.candidates.map((c) => [c.origin, c.available])).toEqual([["deposit", "10"]]);

    await svc.saveMatches(acct, dust.id, [{ lotId: dust.candidates[0]!.lotId, quantity: "0.00053" }]);
    detail = await svc.assetDetail(acct, "KAS");
    expect(detail.unresolved).toEqual([]);
    expect(detail.saleMatches).toEqual([]);
    expect(detail.transferMatches).toHaveLength(1);
    expect(detail.transferMatches[0]).toMatchObject({ quantity: "0.00053", grossSaleProceeds: null, realizedPnl: null });
    expect(detail.openLots.map((l) => l.remainingQuantity)).toEqual(["9.99947"]);
    expect(await db.trade.count()).toBe(0);
  });
});

// --- valuations -----------------------------------------------------------------

describe("#30-31 manual valuations", () => {
  it("a deposit has unknown basis until the user supplies one; clearing it restores unknown", async () => {
    const d = deposit("BTC", "1", { account: acct });
    await seed([], [d]);
    let [sum] = await svc.summaries(acct);
    expect(sum!.costBasis).toEqual({ status: "incomplete", reasons: ["unknown_cost_basis"] });
    expect(await lotRow(d)).toMatchObject({ costBasisStatus: "unknown", acquisitionCost: null });

    await svc.setValuation(acct, { type: "acquisition", key: flowId(d) }, "50000", "10", "bought on another exchange");
    [sum] = await svc.summaries(acct);
    expect(sum!.costBasis).toEqual({ status: "known", value: "50010" });
    expect(await lotRow(d)).toMatchObject({ costBasisStatus: "manual", acquisitionCost: "50010", acquisitionFee: "10" });

    await svc.clearValuation(acct, { type: "acquisition", key: flowId(d) });
    expect(await lotRow(d)).toMatchObject({ costBasisStatus: "unknown", acquisitionCost: null });
  });

  it("unknown sale proceeds (crypto-quoted sale) can be supplied manually", async () => {
    const b = buy("100", "1", { account: acct });
    const x = sell("100", "0.00002", { account: acct, quote: "BTC" });
    await seed([b, x]);
    await svc.saveMatches(acct, flowId(x), [{ lotId: flowId(b), quantity: "100" }]);
    expect((await db.lotMatch.findFirstOrThrow()).realizedPnl).toBeNull();
    await svc.setValuation(acct, { type: "disposal", key: flowId(x) }, "130", "1");
    expect((await db.lotMatch.findFirstOrThrow()).realizedPnl).toBe("29");
  });

  it("rejects invalid or negative values and unknown targets", async () => {
    const d = deposit("BTC", "1", { account: acct });
    await seed([], [d]);
    await expect(svc.setValuation(acct, { type: "acquisition", key: flowId(d) }, "abc", "0")).rejects.toThrow(/valid decimal/);
    await expect(svc.setValuation(acct, { type: "acquisition", key: flowId(d) }, "-1", "0")).rejects.toThrow(/negative/);
    await expect(svc.setValuation(acct, { type: "acquisition", key: "trade:nope:x:base" }, "1", "0")).rejects.toThrow(/unknown/);
    expect(await db.manualValuation.count()).toBe(0);
  });
});

// --- ordering -------------------------------------------------------------------

describe("#37-38 ordering", () => {
  it("a lot bought at the same instant as a sale may close it; equal timestamps order deterministically", async () => {
    const t = day(300);
    const b1 = buy("10", "5", { account: acct, at: t, id: "TSAME-B" });
    const b2 = buy("10", "6", { account: acct, at: t, id: "TSAME-A" });
    const x = sell("10", "7", { account: acct, at: t });
    await seed([b1, b2, x]);
    await svc.saveMatches(acct, flowId(x), [{ lotId: flowId(b1), quantity: "10" }]);
    const detail = await svc.assetDetail(acct, "ADA");
    // Same timestamp: ordered by id (TSAME-A before TSAME-B).
    expect([...detail.openLots, ...detail.closedLots].map((l) => l.id).sort()).toEqual([flowId(b2), flowId(b1)].sort());
    expect(detail.closedLots.map((l) => l.id)).toEqual([flowId(b1)]);
    const r1 = await svc.rebuild(acct);
    const r2 = await svc.rebuild(acct);
    expect(r1.lots.map((l) => l.id)).toEqual(r2.lots.map((l) => l.id));
    expect(r1.lots.filter((l) => l.acquiredAt.getTime() === t.getTime()).map((l) => l.id)).toEqual([flowId(b2), flowId(b1)]);
  });
});
