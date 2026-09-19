import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Reconciler, SyncService, type SyncResult } from "@/application/sync/sync-service";
import { createAccountingConfig } from "@/domain/accounting/config";
import { deriveAssetFlows } from "@/domain/lots/flows";
import { runLotEngine } from "@/domain/lots/engine";
import { ledgerDataQualityFlags } from "@/domain/transactions/ledger-quality";
import type { Db } from "@/server/db/client";
import { HistoryRepository } from "@/server/db/history-repository";
import { PrismaSyncStore } from "@/server/db/prisma-sync-store";
import { createTestDb } from "@/test/test-db";
import { FakeKraken } from "./testing/fake-kraken";
import { krakenHarness, ks } from "./testing/harness";

/**
 * Phase 2.2 cleanup: Kraken `spend/dustsweeping` normalization, the confirmed
 * SOL03 → SOL bonded-staking alias, and precision-aware reconciliation.
 */

const all = { since: null, until: new Date("2026-09-24T12:00:00Z") };
const config = createAccountingConfig("USD", undefined, ["KFEE"]);

async function load(fake: FakeKraken) {
  const { provider } = krakenHarness({ fake });
  return {
    trades: await provider.syncTrades(all),
    ledger: await provider.syncLedgerEntries(all),
    transfers: await provider.syncTransfers(all),
  };
}

let db: Db;
let cleanup: () => Promise<void>;
let repo: HistoryRepository;
let store: PrismaSyncStore;
let accountId: string;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  repo = new HistoryRepository(db);
  store = new PrismaSyncStore(db);
  await repo.ensureProvider("kraken", "exchange", "Kraken");
  accountId = await repo.createAccount("kraken", "Kraken");
});

afterEach(async () => {
  await cleanup();
});

function setup(fake = new FakeKraken()) {
  const h = krakenHarness({ fake, accountId, startIso: "2026-09-24T12:00:00Z" });
  const service = new SyncService({ store, now: () => new Date(h.clock.now()) });
  return { ...h, service, sync: () => service.sync(h.provider, "manual") };
}

function expectOk(r: SyncResult): Extract<SyncResult, { ok: true }> {
  if (!r.ok) throw new Error(`sync failed: [${r.errorCategory}] ${r.errorMessage}`);
  return r;
}

// --- 1-4: dust sweeping ------------------------------------------------------

describe("#1-4 Kraken spend/dustsweeping normalization", () => {
  it("1. reduces the asset's holdings", async () => {
    const fake = new FakeKraken()
      .addLedgerRow({ type: "deposit", asset: "KAS", amount: "10", time: ks("2026-09-01T00:00:00Z") }, "LDEP")
      .addLedgerRow({ type: "spend", subtype: "dustsweeping", asset: "KAS", amount: "-0.00053", time: ks("2026-09-02T00:00:00Z") }, "LDUST");
    const { trades, transfers } = await load(fake);
    const flows = deriveAssetFlows(trades, transfers, config);
    const deposited = flows.acquisitions.find((a) => a.asset === "KAS")!;
    const dustDisposal = flows.disposals.find((d) => d.asset === "KAS")!;
    expect(deposited.quantity.toFixed()).toBe("10");
    expect(dustDisposal.quantity.toFixed()).toBe("0.00053");
    expect(dustDisposal.kind).toBe("transfer_out");
  });

  it("2. does not become an ordinary trade", async () => {
    const fake = new FakeKraken().addLedgerRow(
      { type: "spend", subtype: "dustsweeping", asset: "KAS", amount: "-0.00053", time: ks("2026-09-02T00:00:00Z") },
      "LDUST",
    );
    const { trades, transfers, ledger } = await load(fake);
    expect(trades).toEqual([]);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ asset: "KAS", direction: "out", kind: "adjustment" });
    expect(ledger.find((e) => e.externalLedgerId === "LDUST")).toMatchObject({ entryType: "adjustment" });
  });

  it("3. preserves the raw Kraken ledger data", async () => {
    const fake = new FakeKraken().addLedgerRow(
      { type: "spend", subtype: "dustsweeping", asset: "KAS", amount: "-0.00053", time: ks("2026-09-02T00:00:00Z") },
      "LDUST",
    );
    const { ledger } = await load(fake);
    const entry = ledger.find((e) => e.externalLedgerId === "LDUST")!;
    expect(entry.providerEntryType).toBe("spend");
    expect(entry.providerSubtype).toBe("dustsweeping");
    expect(entry.rawData).toMatchObject({ id: "LDUST", ledger: { type: "spend", subtype: "dustsweeping", asset: "KAS", amount: "-0.00053" } });
    // No longer flagged for manual review: normalized, not unsupported.
    expect(ledgerDataQualityFlags(ledger, config)).toEqual([]);
  });

  it("4. makes P/L incomplete for that asset while the disposal is unmatched (unknown value)", async () => {
    const fake = new FakeKraken()
      .addLedgerRow({ type: "deposit", asset: "KAS", amount: "10", time: ks("2026-09-01T00:00:00Z") }, "LDEP")
      .addLedgerRow({ type: "spend", subtype: "dustsweeping", asset: "KAS", amount: "-0.00053", time: ks("2026-09-02T00:00:00Z") }, "LDUST");
    const { trades, transfers } = await load(fake);
    const flows = deriveAssetFlows(trades, transfers, config);
    const engine = runLotEngine({ acquisitions: flows.acquisitions, disposals: flows.disposals, matches: [], dataQualityFlags: flows.flags });
    // No proceeds are invented, no P/L is invented: the transfer_out sits unmatched until the user resolves it.
    expect(engine.issues.some((i) => i.code === "unresolved_transfer_out" && i.asset === "KAS")).toBe(true);
  });
});

// --- 5-9: dust sweeping reconciles for arbitrary assets ----------------------

describe("#5-9 dust sweeping reconciles for any asset (not special-cased)", () => {
  it.each([
    ["KAS", "0.00053"],
    ["CRV", "0.00000452"],
    ["USDG", "0.34291088"],
    ["BABY", "0.15464"],
    ["WELL", "0.08472"],
  ])("%s dust sweep of %s reconciles cleanly", async (asset, amount) => {
    const fake = new FakeKraken()
      .addLedgerRow({ type: "deposit", asset, amount: "100", time: ks("2026-09-01T00:00:00Z") }, `LDEP-${asset}`)
      .addLedgerRow({ type: "spend", subtype: "dustsweeping", asset, amount: `-${amount}`, time: ks("2026-09-02T00:00:00Z") }, `LDUST-${asset}`);
    const r = expectOk(await setup(fake).sync());
    const row = r.reconciliation.find((x) => x.asset === asset)!;
    expect(row).toMatchObject({ status: "reconciled" });
    expect(row.calculated.toFixed()).toBe(row.reported.toFixed());
  });
});

// --- 10-11: SOL03 bonded-staking alias ---------------------------------------

describe("#10-11 SOL03 bonded-staking alias", () => {
  function withSol(fake: FakeKraken) {
    fake.assets.SOL = { aclass: "currency", altname: "SOL", decimals: "9" };
    fake.pairs.SOLUSD = { altname: "SOLUSD", wsname: "SOL/USD", base: "SOL", quote: "ZUSD" };
    return fake;
  }

  it("10. confirmed SOL03 alias aggregates into a single canonical SOL reconciliation row", async () => {
    const fake = withSol(new FakeKraken())
      .addLedgerRow({ type: "deposit", asset: "ZUSD", amount: "1000", time: ks("2026-08-31T00:00:00Z") })
      .addTrade({ txid: "TSOL1", pair: "SOLUSD", type: "buy", vol: "10", price: "100", time: ks("2026-09-01T00:00:00Z") })
      // Kraken's own ledger: SOL -> SOL03 and back, paired 1:1 on the same instant.
      .addLedgerRow({ type: "transfer", subtype: "spottostaking", asset: "SOL", amount: "-4", time: ks("2026-09-02T00:00:00Z") })
      .addLedgerRow({ type: "transfer", subtype: "spottostaking", asset: "SOL03", amount: "4", time: ks("2026-09-02T00:00:00Z") })
      .addLedgerRow({ type: "staking", asset: "SOL03", amount: "0.05", time: ks("2026-09-03T00:00:00Z") });
    const r = expectOk(await setup(fake).sync());
    const solRows = r.reconciliation.filter((row) => row.asset === "SOL" || row.asset === "SOL03");
    expect(solRows.map((row) => row.asset)).toEqual(["SOL"]);
    expect(solRows[0]!.calculated.toFixed()).toBe("10.05");
    expect(solRows[0]!.status).toBe("reconciled");
  });

  it("11. an unconfirmed numbered asset (e.g. DOT02) is not guessed as an alias and stays separate", async () => {
    const fake = new FakeKraken()
      .addLedgerRow({ type: "deposit", asset: "DOT", amount: "5", time: ks("2026-09-01T00:00:00Z") })
      .addLedgerRow({ type: "staking", asset: "DOT02", amount: "0.2", time: ks("2026-09-02T00:00:00Z") });
    const { transfers } = await load(fake);
    expect(transfers.map((t) => t.asset).sort()).toEqual(["DOT", "DOT02"]);
  });
});

// --- 12-15: precision-aware reconciliation -----------------------------------

describe("#12-15 precision-aware reconciliation", () => {
  it("12. a difference within Kraken's own reportable precision is reconciled_within_precision", async () => {
    const fake = new FakeKraken().addLedgerRow({ type: "deposit", asset: "KAS", amount: "10", time: ks("2026-09-01T00:00:00Z") });
    fake.assets.KAS = { aclass: "currency", altname: "KAS", decimals: "5" };
    fake.balanceOverride = { ...fake.ledgerBalances(), KAS: "10.000005" };
    const r = expectOk(await setup(fake).sync());
    const row = r.reconciliation.find((x) => x.asset === "KAS")!;
    expect(row.status).toBe("reconciled_within_precision");
    expect(row.precision).toBe(5);
  });

  it("13. the exact difference is still stored and displayable, not rounded away", async () => {
    const fake = new FakeKraken().addLedgerRow({ type: "deposit", asset: "KAS", amount: "10", time: ks("2026-09-01T00:00:00Z") });
    fake.assets.KAS = { aclass: "currency", altname: "KAS", decimals: "5" };
    fake.balanceOverride = { ...fake.ledgerBalances(), KAS: "10.000005" };
    const r = expectOk(await setup(fake).sync());
    const row = r.reconciliation.find((x) => x.asset === "KAS")!;
    expect(row.difference.toFixed()).toBe("0.000005");
    const stored = await db.reconciliationResult.findFirstOrThrow({ where: { asset: "KAS" } });
    expect(stored.difference).toBe("0.000005");
    expect(stored.status).toBe("reconciled_within_precision");
  });

  it("14. a meaningful mismatch (beyond precision) stays a mismatch", async () => {
    const fake = new FakeKraken().addLedgerRow({ type: "deposit", asset: "KAS", amount: "10", time: ks("2026-09-01T00:00:00Z") });
    fake.assets.KAS = { aclass: "currency", altname: "KAS", decimals: "5" };
    fake.balanceOverride = { ...fake.ledgerBalances(), KAS: "12" };
    const r = expectOk(await setup(fake).sync());
    const row = r.reconciliation.find((x) => x.asset === "KAS")!;
    expect(row.status).toBe("mismatch");
    expect(row.difference.toFixed()).toBe("2");
  });

  it("15. a small residual is never silently dropped from the reconciliation report", async () => {
    const fake = new FakeKraken().addLedgerRow({ type: "deposit", asset: "KAS", amount: "10", time: ks("2026-09-01T00:00:00Z") });
    fake.assets.KAS = { aclass: "currency", altname: "KAS", decimals: "5" };
    fake.balanceOverride = { ...fake.ledgerBalances(), KAS: "10.000005" };
    const r = expectOk(await setup(fake).sync());
    expect(r.reconciliation.some((row) => row.asset === "KAS")).toBe(true);
    const stored = await db.reconciliationResult.findMany({ where: { asset: "KAS" } });
    expect(stored).toHaveLength(1);
  });

  it("an asset with a mismatch and known unsupported ledger activity is review_required, not a bare mismatch", async () => {
    const fake = new FakeKraken()
      .addLedgerRow({ type: "deposit", asset: "MXC", amount: "10", time: ks("2026-09-01T00:00:00Z") })
      // "sale" is not a normalized type: it becomes entryType "other" (unsupported activity).
      .addLedgerRow({ type: "sale", asset: "MXC", amount: "-1", time: ks("2026-09-02T00:00:00Z") });
    fake.balanceOverride = { ...fake.ledgerBalances(), MXC: "9" };
    const r = expectOk(await setup(fake).sync());
    const row = r.reconciliation.find((x) => x.asset === "MXC")!;
    expect(row.status).toBe("review_required");
  });
});
