import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncService, type SyncResult } from "@/application/sync/sync-service";
import { createAccountingConfig } from "@/domain/accounting/config";
import { dec } from "@/domain/decimal";
import { runLotEngine } from "@/domain/lots/engine";
import { deriveAssetFlows } from "@/domain/lots/flows";
import { calculatePortfolio } from "@/domain/portfolio/portfolio";
import { holdingsFromFlows, reconcileBalances } from "@/domain/reconciliation/reconcile";
import { ledgerDataQualityFlags } from "@/domain/transactions/ledger-quality";
import type { Db } from "@/server/db/client";
import { HistoryRepository } from "@/server/db/history-repository";
import { PrismaSyncStore } from "@/server/db/prisma-sync-store";
import { createTestDb } from "@/test/test-db";
import { KrakenAssetMapper } from "./mapper";
import { FakeKraken } from "./testing/fake-kraken";
import { krakenHarness, ks } from "./testing/harness";

/**
 * Kraken fee credits (KFEE): an internal fee-payment mechanism, not a portfolio
 * asset. Fees covered by KFEE cost the portfolio nothing; the usage is kept.
 */

const all = { since: null, until: new Date("2026-09-24T12:00:00Z") };
const config = createAccountingConfig("USD", undefined, ["KFEE"]);
const str = (d: { toFixed(): string }) => d.toFixed();

async function load(fake: FakeKraken) {
  const { provider } = krakenHarness({ fake });
  return {
    trades: await provider.syncTrades(all),
    ledger: await provider.syncLedgerEntries(all),
    transfers: await provider.syncTransfers(all),
    balances: await provider.getBalances(),
  };
}

function lotCosts(trades: Awaited<ReturnType<typeof load>>["trades"]) {
  const flows = deriveAssetFlows(trades, [], config);
  return runLotEngine({ acquisitions: flows.acquisitions, disposals: flows.disposals, matches: [] }).lots;
}

describe("KFEE naming", () => {
  it("KFEE and its altname FEE map to the fee-credit code", () => {
    const m = new KrakenAssetMapper({ KFEE: { aclass: "currency", altname: "FEE" } });
    expect(m.canonicalAsset("KFEE")).toBe("KFEE");
    expect(new KrakenAssetMapper().canonicalAsset("KFEE")).toBe("KFEE");
  });
});

describe("KFEE balances and credits", () => {
  it("1. a KFEE balance is reported but excluded from reconciliation (7.)", async () => {
    const fake = new FakeKraken();
    fake.balanceOverride = { ZUSD: "100", KFEE: "2500.00" };
    const { balances } = await load(fake);
    expect(balances.find((b) => b.asset === "KFEE")!.total.toFixed()).toBe("2500");
    const report = reconcileBalances({ calculated: [], reported: balances, config });
    expect(report.rows).toEqual([]);
    expect(report.reconciled).toBe(true);
  });

  it("2. a KFEE credit is kept as ledger data but creates no lot and no review item", async () => {
    const fake = new FakeKraken().addLedgerRow({ type: "credit", asset: "KFEE", amount: "1000.00", time: ks("2026-09-01T00:00:00Z") });
    const { ledger, transfers } = await load(fake);
    expect(ledger[0]).toMatchObject({ asset: "KFEE", providerEntryType: "credit" });
    const flows = deriveAssetFlows([], transfers, config);
    expect(flows.acquisitions).toEqual([]);
    expect(ledgerDataQualityFlags(ledger, config)).toEqual([]);
  });
});

describe("#19 normal fee versus KFEE-covered fee", () => {
  it("3. a normal fee is charged in USD and included in cost", async () => {
    const fake = new FakeKraken().addTrade({ txid: "TNORM", pair: "ADAUSD", type: "buy", vol: "1000", price: "0.2", fee: "0.52", time: ks("2026-09-01T00:00:00Z") });
    const { trades } = await load(fake);
    expect(trades[0]).toMatchObject({ feeAsset: "USD", feeSource: "ledger" });
    expect(str(lotCosts(trades)[0]!.acquisitionCost!)).toBe("200.52");
  });

  it.each(["amount", "fee"] as const)(
    "4. a fee covered by KFEE (credit shown as %s) is not deducted from USD: cost = gross only",
    async (kfeeAs) => {
      const fake = new FakeKraken().addTrade({
        txid: "TKFEE", pair: "ADAUSD", type: "buy", vol: "1000", price: "0.2", fee: "0.52", feeIn: "kfee", kfeeAs, time: ks("2026-09-01T00:00:00Z"),
      });
      const { trades } = await load(fake);
      const t = trades[0]!;
      // The credit usage is explicit: 0.52 USD of fees = 52 KFEE.
      expect(t).toMatchObject({ feeAsset: "KFEE", feeSource: "fee_credit" });
      expect(str(t.fee)).toBe("52");
      const flows = deriveAssetFlows(trades, [], config);
      expect(flows.acquisitions[0]!.feeCredit).toMatchObject({ asset: "KFEE" });
      expect(flows.flags).toEqual([]);
      expect(str(lotCosts(trades)[0]!.acquisitionCost!)).toBe("200");
    },
  );

  it("a fee partly covered by KFEE: only the real USD part is a cost; the credit use is recorded", async () => {
    const fake = new FakeKraken().addTrade({ txid: "TMIX", pair: "ADAUSD", type: "buy", vol: "1000", price: "0.2", fee: "0.20", time: ks("2026-09-01T00:00:00Z") });
    fake.addLedgerRow({ refid: "TMIX", time: ks("2026-09-01T00:00:00Z"), type: "trade", asset: "KFEE", amount: "-32" }, "LTMIX-K");
    const { trades } = await load(fake);
    expect(trades[0]).toMatchObject({ feeAsset: "USD", feeSource: "ledger" });
    expect(trades[0]!.rawData).toMatchObject({ feeCreditUsed: { amount: "32", asset: "KFEE" } });
    expect(str(lotCosts(trades)[0]!.acquisitionCost!)).toBe("200.2");
  });

  it("a fee reported by the trade record but not charged in the ledger costs nothing and is flagged in the fee source", async () => {
    const fake = new FakeKraken().addTrade({ txid: "TNC", pair: "ADAUSD", type: "buy", vol: "1000", price: "0.2", fee: "0.52", time: ks("2026-09-01T00:00:00Z") });
    // Ledger shows both legs but no fee anywhere (e.g. a credit line with another refid).
    fake.ledger.set("LTNC-Q", { ...fake.ledger.get("LTNC-Q")!, fee: "0" });
    const { trades } = await load(fake);
    expect(trades[0]).toMatchObject({ feeSource: "ledger_uncharged", feeAsset: null });
    expect(trades[0]!.rawData).toMatchObject({ reportedFeeNotCharged: "0.52" });
  });
});

describe("#17/#18 KFEE is not a portfolio asset", () => {
  let db: Db;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
  });
  afterEach(async () => {
    await cleanup();
  });

  it("5./6./7. a mixed history with KFEE: no KFEE position, no KFEE reconciliation row, everything else reconciles", async () => {
    const repo = new HistoryRepository(db);
    await repo.ensureProvider("kraken", "exchange", "Kraken");
    const accountId = await repo.createAccount("kraken", "Kraken");
    const fake = new FakeKraken()
      .addLedgerRow({ type: "deposit", asset: "ZUSD", amount: "1000", time: ks("2026-08-01T00:00:00Z") })
      .addLedgerRow({ type: "credit", asset: "KFEE", amount: "1000", time: ks("2026-08-01T00:00:01Z") })
      .addTrade({ txid: "T1", pair: "ADAUSD", type: "buy", vol: "1000", price: "0.2", fee: "0.52", time: ks("2026-08-02T00:00:00Z") })
      .addTrade({ txid: "T2", pair: "ADAUSD", type: "buy", vol: "1000", price: "0.2", fee: "0.52", feeIn: "kfee", time: ks("2026-08-03T00:00:00Z") })
      .addTrade({ txid: "T3", pair: "XXBTZUSD", type: "buy", vol: "0.001", price: "60000", fee: "0.156", feeIn: "kfee", time: ks("2026-08-04T00:00:00Z") });
    const h = krakenHarness({ fake, accountId });
    const service = new SyncService({ store: new PrismaSyncStore(db), now: () => new Date(h.clock.now()), config });
    const r = (await service.sync(h.provider, "manual")) as Extract<SyncResult, { ok: true }>;
    expect(r.ok).toBe(true);

    // 7. no KFEE reconciliation row; tracked assets reconcile exactly
    expect(r.reconciliation.map((x) => `${x.asset}:${x.status}`)).toEqual(["ADA:reconciled", "BTC:reconciled"]);
    expect((await db.balanceSnapshot.findFirstOrThrow({ where: { asset: "KFEE" } })).total).toBe("932.4");

    // 6. no KFEE position, no price needed for it
    const trades = await repo.loadTrades(accountId);
    const flows = deriveAssetFlows(trades, await repo.loadTransfers(accountId), config);
    const engine = runLotEngine({ acquisitions: flows.acquisitions, disposals: flows.disposals, matches: [], dataQualityFlags: flows.flags });
    const pf = calculatePortfolio({ engine, prices: new Map([["ADA", dec("0.25")], ["BTC", dec("65000")]]), reportingCurrency: "USD" });
    expect(pf.positions.map((p) => p.asset)).toEqual(["ADA", "BTC"]);
    expect(pf.totalCurrentValue.complete).toBe(true);

    // 5. P/L reflects only what actually left the portfolio: 0.52 USD fee on T1, nothing on T2/T3
    expect(pf.totalCostBasis.value.toFixed()).toBe("460.52");
    expect(holdingsFromFlows(flows.acquisitions, flows.disposals).map((x) => x.asset).sort()).toEqual(["ADA", "BTC"]);
  });
});
