import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncService, type SyncResult } from "@/application/sync/sync-service";
import { createAccountingConfig } from "@/domain/accounting/config";
import { dec } from "@/domain/decimal";
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
 * Buy Crypto / Kraken app transactions: ledger `spend` + `receive` lines that
 * share a refid. Numbers refer to the Phase 2.1 test list.
 */

const all = { since: null, until: new Date("2026-09-24T12:00:00Z") };
const T = ks("2026-09-10T08:30:00Z", "1234");
const config = createAccountingConfig("USD", undefined, ["KFEE"]);
const str = (d: { toFixed(): string }) => d.toFixed();

async function history(fake: FakeKraken) {
  const { provider } = krakenHarness({ fake });
  return {
    trades: await provider.syncTrades(all),
    ledger: await provider.syncLedgerEntries(all),
    transfers: await provider.syncTransfers(all),
  };
}

describe("#9 Instant Buy", () => {
  it("spend 100 USD + receive 250 ADA → a BUY of ADA with USD", async () => {
    const fake = new FakeKraken().addInstant({
      refid: "FTQcuak-V6Za8qrWnhzTx67yYHz8Tg",
      time: T,
      spend: { asset: "ZUSD", amount: "-100.0000", id: "LSPEND-AAAAA-000001" },
      receive: { asset: "ADA", amount: "250.00000000", id: "LRECV-AAAAA-000001" },
    });
    const { trades, ledger, transfers } = await history(fake);
    expect(trades).toHaveLength(1);
    const t = trades[0]!;
    expect(t).toMatchObject({
      externalTradeId: "ledger:LSPEND-AAAAA-000001+LRECV-AAAAA-000001",
      externalOrderId: "FTQcuak-V6Za8qrWnhzTx67yYHz8Tg",
      baseAsset: "ADA",
      quoteAsset: "USD",
      side: "buy",
      origin: "ledger",
      feeSource: "ledger",
      fee: expect.anything(),
      feeAsset: null,
    });
    expect([str(t.quantity), str(t.grossValue), str(t.price), str(t.fee)]).toEqual(["250", "100", "0.4", "0"]);
    expect(t.rawData).toMatchObject({ source: "ledger_spend_receive", spend: { id: "LSPEND-AAAAA-000001" }, receive: { id: "LRECV-AAAAA-000001" } });
    // No Kraken trade id is invented.
    expect(t.rawData).not.toHaveProperty("txid");
    // The ledger lines are represented by the trade: not unsupported, not transfers.
    expect(ledger.map((e) => e.entryType)).toEqual(["trade", "trade"]);
    expect(transfers).toEqual([]);
    expect(ledgerDataQualityFlags(ledger, config)).toEqual([]);
  });
});

describe("#10 Instant Sell", () => {
  it("spend 250 ADA + receive 99 USD (fee 1 USD) → a SELL of ADA; net proceeds 98", async () => {
    const fake = new FakeKraken().addInstant({
      refid: "R-SELL-1",
      time: T,
      spend: { asset: "ADA", amount: "-250" },
      receive: { asset: "ZUSD", amount: "99.0000", fee: "1.0000" },
    });
    const [t] = (await history(fake)).trades;
    expect(t).toMatchObject({ baseAsset: "ADA", quoteAsset: "USD", side: "sell", feeAsset: "USD" });
    expect([str(t!.quantity), str(t!.grossValue), str(t!.fee)]).toEqual(["250", "99", "1"]);
    const [d] = deriveAssetFlows([t!], [], config).disposals;
    expect(d!.proceeds).toMatchObject({ status: "known" });
    if (d!.proceeds?.status === "known") expect(str(d!.proceeds.gross.minus(d!.proceeds.fee))).toBe("98");
  });
});

describe("#11 Convert crypto → crypto", () => {
  it("spend 0.01 BTC + receive 0.2 ETH → BUY ETH with BTC; values unknown in USD, never guessed", async () => {
    const fake = new FakeKraken().addInstant({
      refid: "R-CONV-1",
      time: T,
      spend: { asset: "XXBT", amount: "-0.0100000000" },
      receive: { asset: "XETH", amount: "0.2000000000" },
    });
    const [t] = (await history(fake)).trades;
    expect(t).toMatchObject({ baseAsset: "ETH", quoteAsset: "BTC", side: "buy" });
    const flows = deriveAssetFlows([t!], [], config);
    expect(flows.acquisitions[0]).toMatchObject({ asset: "ETH", cost: { status: "unknown", reason: "non_reporting_currency" } });
    expect(flows.disposals[0]).toMatchObject({ asset: "BTC", kind: "sale" });
    expect(str(flows.disposals[0]!.quantity)).toBe("0.01");
  });
});

describe("#12 ambiguous activity stays review-required", () => {
  it("a lone spend (no receive with the same refid, even after the counterpart lookup) is not paired", async () => {
    const fake = new FakeKraken().addLedgerRow({ refid: "R-LONE", time: T, type: "spend", asset: "ZUSD", amount: "-50" });
    const { trades, ledger } = await history(fake);
    expect(trades).toEqual([]);
    expect(ledger[0]!.entryType).toBe("other");
    // One extra targeted Ledgers call looked for the counterpart (by refid).
    expect(fake.callsTo("Ledgers")).toBe(2);
  });

  it("never pairs a spend and a receive with different refids, however plausible", async () => {
    const fake = new FakeKraken()
      .addLedgerRow({ refid: "R-A", time: T, type: "spend", asset: "ZUSD", amount: "-100" })
      .addLedgerRow({ refid: "R-B", time: T, type: "receive", asset: "ADA", amount: "250" });
    const { trades, ledger } = await history(fake);
    expect(trades).toEqual([]);
    expect(ledger.every((e) => e.entryType === "other")).toBe(true);
    expect(ledgerDataQualityFlags(ledger, config).map((f) => f.asset)).toEqual(["ADA"]);
  });

  it.each([
    [
      "two receives in one group",
      (f: FakeKraken) =>
        f
          .addInstant({ refid: "R-X", time: T, spend: { asset: "ZUSD", amount: "-100" }, receive: { asset: "ADA", amount: "250" } })
          .addLedgerRow({ refid: "R-X", time: T, type: "receive", asset: "DOT", amount: "5" }),
    ],
    [
      "fees on both sides",
      (f: FakeKraken) =>
        f.addInstant({ refid: "R-X", time: T, spend: { asset: "ZUSD", amount: "-100", fee: "1" }, receive: { asset: "ADA", amount: "250", fee: "1" } }),
    ],
    [
      "an extra line of another type in the group",
      (f: FakeKraken) =>
        f
          .addInstant({ refid: "R-X", time: T, spend: { asset: "ZUSD", amount: "-100" }, receive: { asset: "ADA", amount: "250" } })
          .addLedgerRow({ refid: "R-X", time: T, type: "adjustment", asset: "ADA", amount: "1" }),
    ],
    [
      "wrong signs",
      (f: FakeKraken) => f.addInstant({ refid: "R-X", time: T, spend: { asset: "ZUSD", amount: "100" }, receive: { asset: "ADA", amount: "250" } }),
    ],
    [
      "the same asset on both sides",
      (f: FakeKraken) => f.addInstant({ refid: "R-X", time: T, spend: { asset: "ADA", amount: "-100" }, receive: { asset: "ADA.S", amount: "100" } }),
    ],
  ])("%s → no trade, lines kept for review", async (_name, build) => {
    const fake = new FakeKraken();
    build(fake);
    const { trades, ledger } = await history(fake);
    expect(trades).toEqual([]);
    expect(ledger.filter((e) => e.providerEntryType === "spend" || e.providerEntryType === "receive").every((e) => e.entryType === "other")).toBe(true);
  });

  it("links a pair across the window boundary only by refid (targeted lookup)", async () => {
    const until = new Date("2026-09-24T12:00:00Z");
    const fake = new FakeKraken().addInstant({
      refid: "R-EDGE",
      time: ks("2026-09-24T11:59:59Z"),
      spend: { asset: "ZUSD", amount: "-10" },
      receive: { asset: "ADA", amount: "25", time: ks("2026-09-24T12:00:01Z") },
    });
    const { provider } = krakenHarness({ fake });
    const trades = await provider.syncTrades({ since: null, until });
    expect(trades).toHaveLength(1);
    expect(trades[0]!.externalTradeId).toBe("ledger:LR-EDGE-S+LR-EDGE-R");
  });
});

describe("#13 deterministic synthesized ids", () => {
  it("the same Kraken ledger ids always give the same trade id", async () => {
    const build = () =>
      new FakeKraken().addInstant({
        refid: "R-DET",
        time: T,
        spend: { asset: "ZUSD", amount: "-100", id: "LS-1" },
        receive: { asset: "ADA", amount: "250", id: "LR-1" },
      });
    const a = (await history(build())).trades[0]!.externalTradeId;
    const b = (await history(build())).trades[0]!.externalTradeId;
    expect(a).toBe("ledger:LS-1+LR-1");
    expect(b).toBe(a);
  });
});

describe("#15/#16 Instant Buy fees", () => {
  it("#15 an explicit fee on the spend line is the buy fee: cost = amount + fee", async () => {
    const fake = new FakeKraken().addInstant({
      refid: "R-FEE",
      time: T,
      spend: { asset: "ZUSD", amount: "-100.00", fee: "1.49" },
      receive: { asset: "ADA", amount: "250" },
    });
    const [t] = (await history(fake)).trades;
    expect(t).toMatchObject({ feeAsset: "USD" });
    expect([str(t!.grossValue), str(t!.fee)]).toEqual(["100", "1.49"]);
    const flows = deriveAssetFlows([t!], [], config);
    const engine = runLotEngine({ acquisitions: flows.acquisitions, disposals: flows.disposals, matches: [] });
    expect(str(engine.lots[0]!.acquisitionCost!)).toBe("101.49");
  });

  it("#16 the fee is counted once: cost equals the actual USD balance decrease", async () => {
    const fake = new FakeKraken().addInstant({
      refid: "R-ONCE",
      time: T,
      spend: { asset: "ZUSD", amount: "-100.00", fee: "1.49" },
      receive: { asset: "ADA", amount: "250" },
    });
    const usdChange = fake.ledgerBalances()["ZUSD"]!; // Σ(amount − fee) = −101.49
    const [t] = (await history(fake)).trades;
    const flows = deriveAssetFlows([t!], [], config);
    const lotCost = runLotEngine({ acquisitions: flows.acquisitions, disposals: [], matches: [] }).lots[0]!.acquisitionCost!;
    expect(dec(usdChange).negated().equals(lotCost)).toBe(true);
    expect(str(lotCost)).toBe("101.49"); // not 102.98
  });

  it("#16 a fee taken from the received asset reduces the quantity kept, total cost stays the amount spent", async () => {
    const fake = new FakeKraken().addInstant({
      refid: "R-RFEE",
      time: T,
      spend: { asset: "ZUSD", amount: "-100" },
      receive: { asset: "ADA", amount: "250", fee: "2.5" },
    });
    const [t] = (await history(fake)).trades;
    expect(t).toMatchObject({ feeAsset: "ADA" });
    const [a] = deriveAssetFlows([t!], [], config).acquisitions;
    expect(str(a!.quantity)).toBe("247.5");
    if (a!.cost.status !== "known") throw new Error("expected known cost");
    expect(str(a!.cost.gross.plus(a!.cost.fee))).toBe("100");
  });
});

describe("#14 repeated Instant Buy imports are idempotent", () => {
  let db: Db;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
  });
  afterEach(async () => {
    await cleanup();
  });

  it("three syncs store one synthesized trade and identical rows, and balances reconcile", async () => {
    const repo = new HistoryRepository(db);
    await repo.ensureProvider("kraken", "exchange", "Kraken");
    const accountId = await repo.createAccount("kraken", "Kraken");
    const fake = new FakeKraken()
      .addLedgerRow({ type: "deposit", asset: "ZUSD", amount: "500", time: ks("2026-09-01T00:00:00Z") })
      .addInstant({ refid: "R-IDEM", time: T, spend: { asset: "ZUSD", amount: "-100", fee: "1.49" }, receive: { asset: "ADA", amount: "250" } });
    const h = krakenHarness({ fake, accountId });
    const service = new SyncService({ store: new PrismaSyncStore(db), now: () => new Date(h.clock.now()), config });
    const ok = (r: SyncResult) => {
      if (!r.ok) throw new Error(r.errorMessage);
      return r;
    };
    const first = ok(await service.sync(h.provider, "manual"));
    const rows = await db.trade.findMany();
    for (let i = 0; i < 2; i++) {
      h.clock.advance(60_000);
      expect(ok(await service.sync(h.provider, "manual")).counts.trades.inserted).toBe(0);
    }
    expect(await db.trade.findMany()).toEqual(rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: "ledger", externalTradeId: "ledger:LR-IDEM-S+LR-IDEM-R" });
    expect(first.reconciliation.find((r) => r.asset === "ADA")).toMatchObject({ status: "reconciled" });
  });
});
