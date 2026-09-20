import { describe, expect, it } from "vitest";
import { createAccountingConfig } from "@/domain/accounting/config";
import { dec } from "@/domain/decimal";
import { deriveAssetFlows } from "@/domain/lots/flows";
import { ledgerDataQualityFlags } from "@/domain/transactions/ledger-quality";
import { ProviderError } from "../types";
import { FakeKraken } from "./testing/fake-kraken";
import { krakenHarness, ks } from "./testing/harness";

const UNTIL = new Date("2026-09-24T12:00:00Z");
const all = { since: null, until: UNTIL };
const str = (d: { toFixed(): string }) => d.toFixed();

describe("connection test", () => {
  it("#1 valid read-only credentials → connected, with a permissions warning", async () => {
    const { provider, fake } = krakenHarness();
    const r = await provider.testConnection();
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.warnings[0]).toBe("This application only needs read-only access.");
    expect(fake.requests.map((q) => q.method)).toEqual(["GetApiKeyInfo"]);
  });

  it("#2 wrong private key → invalid credentials", async () => {
    const { provider } = krakenHarness({ secret: Buffer.alloc(64, 1).toString("base64") });
    expect(await provider.testConnection()).toMatchObject({ ok: false, code: "invalid_credentials" });
  });

  it("#2 unknown API key → invalid credentials", async () => {
    const { provider } = krakenHarness({ apiKey: "someone-else" });
    const r = await provider.testConnection();
    expect(r).toMatchObject({ ok: false, code: "invalid_credentials" });
    if (!r.ok) expect(r.message).toContain("EAPI:Invalid key");
  });

  it("#3 missing permission → names the permission to enable", async () => {
    const fake = new FakeKraken();
    fake.keyPermissions.delete("query-ledger");
    const r = await krakenHarness({ fake }).provider.testConnection();
    expect(r).toMatchObject({ ok: false, code: "insufficient_permissions" });
    if (!r.ok) expect(r.message).toContain("Query Ledger Entries");
  });

  it("Kraken unavailable → provider_unavailable after retries", async () => {
    const fake = new FakeKraken().fail("GetApiKeyInfo", { error: "EService:Unavailable" }, 10);
    const r = await krakenHarness({ fake }).provider.testConnection();
    expect(r).toMatchObject({ ok: false, code: "provider_unavailable" });
    expect(fake.callsTo("GetApiKeyInfo")).toBe(4);
  });

  it("rate limited → rate_limited; temporary lockout is not retried", async () => {
    const limited = new FakeKraken().fail("GetApiKeyInfo", { error: "EAPI:Rate limit exceeded" }, 10);
    expect(await krakenHarness({ fake: limited }).provider.testConnection()).toMatchObject({ ok: false, code: "rate_limited" });
    const locked = new FakeKraken().fail("GetApiKeyInfo", { error: "EGeneral:Temporary lockout" }, 10);
    expect(await krakenHarness({ fake: locked }).provider.testConnection()).toMatchObject({ ok: false, code: "rate_limited" });
    expect(locked.callsTo("GetApiKeyInfo")).toBe(1);
  });

  it("errors never contain the secret or the signature", async () => {
    const fake = new FakeKraken().fail("GetApiKeyInfo", { error: "EAPI:Invalid signature" });
    const { provider } = krakenHarness({ fake });
    const r = await provider.testConnection();
    const text = JSON.stringify(r) + JSON.stringify(provider);
    expect(text).not.toContain(fake.apiSecret);
    expect(text).not.toContain(fake.apiKey);
  });
});

describe("trades", () => {
  it("#4 one buy (#10 USD pair, #13 buy fee from the ledger)", async () => {
    const fake = new FakeKraken().addTrade({
      txid: "TBUY01-AAAAA-BBBBBB", ordertxid: "OBUY01-AAAAA-BBBBBB", pair: "ADAUSD", type: "buy",
      vol: "1000.00000000", price: "0.140000", fee: "0.36400", time: ks("2026-09-01T10:00:00Z", "1234"),
    });
    const [t] = await krakenHarness({ fake }).provider.syncTrades(all);
    expect(t).toMatchObject({
      provider: "kraken",
      externalTradeId: "TBUY01-AAAAA-BBBBBB",
      externalOrderId: "OBUY01-AAAAA-BBBBBB",
      baseAsset: "ADA",
      quoteAsset: "USD",
      side: "buy",
      feeAsset: "USD",
    });
    expect([str(t!.quantity), str(t!.price), str(t!.grossValue), str(t!.fee)]).toEqual(["1000", "0.14", "140", "0.364"]);
    expect(t!.executedAt.toISOString()).toBe("2026-09-01T10:00:00.123Z");
  });

  it("#5 one sell (#14 sell fee)", async () => {
    const fake = new FakeKraken().addTrade({
      txid: "TSELL1", pair: "XXBTZUSD", type: "sell", vol: "0.5", price: "65000.1", fee: "84.50", time: ks("2026-09-02T00:00:00Z"),
    });
    const [t] = await krakenHarness({ fake }).provider.syncTrades(all);
    expect(t).toMatchObject({ baseAsset: "BTC", quoteAsset: "USD", side: "sell", feeAsset: "USD" });
    expect([str(t!.grossValue), str(t!.fee)]).toEqual(["32500.05", "84.5"]);
  });

  it("#6 multiple fills of one order stay separate executions", async () => {
    const fake = new FakeKraken();
    for (let i = 1; i <= 3; i++) {
      fake.addTrade({ txid: `TFILL${i}`, ordertxid: "OSAME1", pair: "ADAUSD", type: "buy", vol: "100", price: `0.1${i}`, time: ks("2026-09-03T00:00:00Z", `000${i}`) });
    }
    const trades = await krakenHarness({ fake }).provider.syncTrades(all);
    expect(trades).toHaveLength(3);
    expect(new Set(trades.map((t) => t.externalOrderId))).toEqual(new Set(["OSAME1"]));
    expect(fake.requests.find((r) => r.method === "TradesHistory")!.params["consolidate_taker"]).toBe("false");
  });

  it("#11 stablecoin pairs: USDC bought with USD is a lot; ADA bought with USDT disposes USDT", async () => {
    const fake = new FakeKraken()
      .addTrade({ txid: "TUSDC", pair: "USDCUSD", type: "buy", vol: "500", price: "1.0001", time: ks("2026-09-01T00:00:00Z") })
      .addTrade({ txid: "TADAT", pair: "ADAUSDT", type: "buy", vol: "100", price: "0.35", time: ks("2026-09-02T00:00:00Z") });
    const trades = await krakenHarness({ fake }).provider.syncTrades(all);
    const flows = deriveAssetFlows(trades, [], createAccountingConfig("USD"));
    const usdcLot = flows.acquisitions.find((a) => a.asset === "USDC")!;
    expect(usdcLot.cost).toEqual({ status: "known", gross: dec("500.05"), fee: dec("0") });
    expect(flows.disposals.find((d) => d.asset === "USDT")).toMatchObject({ kind: "sale", origin: "trade_payment" });
    expect(flows.acquisitions.find((a) => a.asset === "ADA")!.cost.status).toBe("unknown");
  });

  it("#12 crypto/crypto pair: ETH/BTC normalizes both legs, values unknown in USD", async () => {
    const fake = new FakeKraken().addTrade({ txid: "TETHBTC", pair: "XETHXXBT", type: "buy", vol: "2", price: "0.05", fee: "0.0002", time: ks("2026-09-01T00:00:00Z") });
    const [t] = await krakenHarness({ fake }).provider.syncTrades(all);
    expect(t).toMatchObject({ baseAsset: "ETH", quoteAsset: "BTC", feeAsset: "BTC" });
    const flows = deriveAssetFlows([t!], [], createAccountingConfig("USD"));
    expect(flows.acquisitions[0]!.cost).toEqual({ status: "unknown", reason: "non_reporting_currency" });
    expect(str(flows.disposals[0]!.quantity)).toBe("0.1002");
  });

  it("fee charged in the base asset is taken from the ledger, not the quote-currency summary", async () => {
    const fake = new FakeKraken().addTrade({ txid: "TFCIB", pair: "ADAUSD", type: "buy", vol: "1000", price: "0.2", fee: "2.6", feeIn: "base", time: ks("2026-09-01T00:00:00Z") });
    const [t] = await krakenHarness({ fake }).provider.syncTrades(all);
    expect(t!.feeAsset).toBe("ADA");
    expect(str(t!.fee)).toBe("2.6");
    expect(t!.feeSource).toBe("ledger");
    expect(t!.rawData).toMatchObject({ feeLedgerIds: ["LTFCIB-B"] });
  });

  it("without ledger evidence, falls back to the quote-currency fee and records that", async () => {
    const fake = new FakeKraken().addTrade({ txid: "TNOLED", pair: "ADAUSD", type: "buy", vol: "10", price: "1", fee: "0.026", withoutLedger: true, time: ks("2026-09-01T00:00:00Z") });
    const [t] = await krakenHarness({ fake }).provider.syncTrades(all);
    expect(t).toMatchObject({ feeAsset: "USD", feeSource: "trade_record" });
  });

  it("#15 decimal precision is preserved exactly", async () => {
    const fake = new FakeKraken().addTrade({ txid: "TPREC", pair: "XXBTZUSD", type: "buy", vol: "0.00000001", price: "65432.123456789", fee: "0.00000026", time: ks("2026-09-01T00:00:00Z", "9999") });
    const [t] = await krakenHarness({ fake }).provider.syncTrades(all);
    expect([str(t!.quantity), str(t!.price), str(t!.grossValue), str(t!.fee)]).toEqual([
      "0.00000001", "65432.123456789", "0.00065432123456789", "0.00000026",
    ]);
  });

  it("margin trades are excluded from spot trades", async () => {
    const fake = new FakeKraken().addTrade({ txid: "TMARGIN", pair: "XXBTZUSD", type: "buy", vol: "1", price: "60000", margin: "12000.00000", withoutLedger: true, time: ks("2026-09-01T00:00:00Z") });
    expect(await krakenHarness({ fake }).provider.syncTrades(all)).toEqual([]);
  });

  it("invalid trade data fails loudly instead of being guessed", async () => {
    const fake = new FakeKraken().addTrade({ txid: "TBAD", pair: "ADAUSD", type: "buy", vol: "1", price: "1", time: ks("2026-09-01T00:00:00Z") });
    fake.trades.set("TBAD", { ...fake.trades.get("TBAD")!, vol: "1,5" });
    await expect(krakenHarness({ fake }).provider.syncTrades(all)).rejects.toThrow(/invalid trade volume/);
  });
});

describe("pagination", () => {
  function fakeWithTrades(n: number) {
    const fake = new FakeKraken();
    const start = Date.parse("2026-01-01T00:00:00Z") / 1000;
    for (let i = 0; i < n; i++) {
      fake.addTrade({ txid: `T${String(i).padStart(6, "0")}`, pair: "ADAUSD", type: "buy", vol: "1", price: "0.5", fee: "0.0013", time: `${start + i * 60}.0000` });
    }
    return fake;
  }

  it("#7 multiple pages of trades are all retrieved", async () => {
    const fake = fakeWithTrades(250);
    const trades = await krakenHarness({ fake }).provider.syncTrades(all);
    expect(trades).toHaveLength(250);
    expect(new Set(trades.map((t) => t.externalTradeId)).size).toBe(250);
    expect(fake.requests.filter((r) => r.method === "TradesHistory").map((r) => r.params["ofs"])).toEqual(["0", "100", "200"]);
    // 500 ledger lines at 50 per page
    expect(fake.callsTo("Ledgers")).toBe(10);
  });

  it("#8 large history under the Starter rate limit: complete, and never trips Kraken's limiter", async () => {
    const fake = fakeWithTrades(3000);
    const { provider, clock } = krakenHarness({ fake, tier: "starter" });
    fake.rateLimit = { max: 15, decayPerSecond: 0.33, now: clock.now };
    const trades = await provider.syncTrades(all);
    const ledger = await provider.syncLedgerEntries(all);
    expect(trades).toHaveLength(3000);
    expect(ledger).toHaveLength(6000);
    // 30 trade pages + 120 ledger pages, cost 2 each, simulated waiting only
    expect(fake.callsTo("TradesHistory") + fake.callsTo("Ledgers")).toBe(150);
    expect(clock.sleptMs).toBeGreaterThan(500_000);
    expect(fake.rateLimitErrors).toBe(0);
  }, 30_000); // heavy simulation (3,000 signed requests): slow under a fully parallel test run

  it("sends a fixed window: end = sync end, start exclusive", async () => {
    const fake = fakeWithTrades(3);
    await krakenHarness({ fake }).provider.syncTrades({ since: new Date("2026-01-01T00:01:00Z"), until: UNTIL });
    const p = fake.requests.find((r) => r.method === "TradesHistory")!.params;
    expect(p["end"]).toBe(String(UNTIL.getTime() / 1000));
    expect(p["start"]).toBe(String(Date.parse("2026-01-01T00:01:00Z") / 1000 - 1));
  });

  it("#23 a row appearing at the head during pagination is neither lost nor duplicated", async () => {
    const fake = fakeWithTrades(250);
    fake.beforeResponse = (method, _params, call) => {
      if (method === "TradesHistory" && call === 2) {
        fake.addTrade({ txid: "TLATE", pair: "ADAUSD", type: "buy", vol: "1", price: "0.5", time: ks("2026-06-01T00:00:00Z") });
      }
    };
    const trades = await krakenHarness({ fake }).provider.syncTrades(all);
    expect(trades).toHaveLength(251);
    expect(trades.some((t) => t.externalTradeId === "TLATE")).toBe(true);
  });

  it("#24 transient errors during pagination are retried", async () => {
    const fake = fakeWithTrades(150).fail("TradesHistory", { error: "EService:Busy" }, 2, 100);
    const trades = await krakenHarness({ fake }).provider.syncTrades(all);
    expect(trades).toHaveLength(150);
  });

  it("#24 a persistent error during pagination fails the whole download", async () => {
    const fake = fakeWithTrades(150).fail("TradesHistory", "network", 99, 100);
    await expect(krakenHarness({ fake }).provider.syncTrades(all)).rejects.toMatchObject({ code: "network" });
  });

  it("garbage or HTTP errors are reported, not parsed", async () => {
    const garbage = fakeWithTrades(1).fail("TradesHistory", "garbage");
    await expect(krakenHarness({ fake: garbage }).provider.syncTrades(all)).rejects.toMatchObject({ code: "invalid_response" });
    const http = fakeWithTrades(1).fail("TradesHistory", "http500", 99);
    await expect(krakenHarness({ fake: http }).provider.syncTrades(all)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("ledger activity", () => {
  const T = (d: string) => ks(`2026-09-${d}T00:00:00Z`);

  it("#16 deposit → incoming transfer with its fee", async () => {
    const fake = new FakeKraken().addLedgerRow({ type: "deposit", asset: "XXBT", amount: "1.0000000000", fee: "0.0001000000", time: T("01") }, "LDEP1");
    const [x] = await krakenHarness({ fake }).provider.syncTransfers(all);
    expect(x).toMatchObject({ externalTransferId: "LDEP1", direction: "in", kind: "deposit", asset: "BTC", feeAsset: "BTC" });
    expect([str(x!.quantity), str(x!.fee)]).toEqual(["1", "0.0001"]);
  });

  it("#17 withdrawal → outgoing transfer, never a sale", async () => {
    const fake = new FakeKraken().addLedgerRow({ type: "withdrawal", asset: "ADA", amount: "-500.00000000", fee: "1.00000000", time: T("02") }, "LWD1");
    const { provider } = krakenHarness({ fake });
    const [x] = await provider.syncTransfers(all);
    expect(x).toMatchObject({ direction: "out", kind: "withdrawal", asset: "ADA" });
    expect([str(x!.quantity), str(x!.fee)]).toEqual(["500", "1"]);
    expect(await provider.syncTrades(all)).toEqual([]);
  });

  it("#18 staking reward → reward acquisition with unknown cost; spot↔staking moves are internal", async () => {
    const fake = new FakeKraken()
      .addLedgerRow({ type: "transfer", subtype: "spottostaking", asset: "ADA", amount: "-100", time: T("03") }, "LSTK1")
      .addLedgerRow({ type: "transfer", subtype: "stakingfromspot", asset: "ADA.S", amount: "100", time: T("03") }, "LSTK2")
      .addLedgerRow({ type: "staking", asset: "ADA.S", amount: "0.25", time: T("04") }, "LRWD1");
    const { provider } = krakenHarness({ fake });
    const transfers = await provider.syncTransfers(all);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ externalTransferId: "LRWD1", kind: "reward", direction: "in", asset: "ADA" });
    const ledger = await provider.syncLedgerEntries(all);
    expect(ledger.find((e) => e.externalLedgerId === "LSTK2")).toMatchObject({ entryType: "transfer", providerEntryType: "transfer", providerSubtype: "stakingfromspot", asset: "ADA" });
    const flows = deriveAssetFlows([], transfers, createAccountingConfig());
    expect(flows.acquisitions[0]!.cost).toEqual({ status: "unknown", reason: "no_acquisition_price" });
  });

  it("#29 unknown / unsupported ledger types are imported, flagged for review, never turned into transactions", async () => {
    const fake = new FakeKraken()
      .addLedgerRow({ type: "spend", asset: "ZUSD", amount: "-100", time: T("05") }, "LSPEND")
      .addLedgerRow({ type: "receive", asset: "DOT", amount: "20", time: T("05") }, "LRECV")
      .addLedgerRow({ type: "margin", asset: "XXBT", amount: "-0.01", time: T("06") }, "LMARGIN")
      .addLedgerRow({ type: "somethingnew", subtype: "x", asset: "ADA", amount: "5", time: T("07") }, "LNEW");
    const { provider } = krakenHarness({ fake });
    expect(await provider.syncTransfers(all)).toEqual([]);
    const ledger = await provider.syncLedgerEntries(all);
    expect(ledger.every((e) => e.entryType === "other")).toBe(true);
    const flags = ledgerDataQualityFlags(ledger, createAccountingConfig());
    expect(flags.map((f) => `${f.asset}:${f.reason}`).sort()).toEqual([
      "ADA:unsupported_activity",
      "BTC:unsupported_activity",
      "DOT:unsupported_activity",
    ]);
    expect(flags.find((f) => f.asset === "DOT")!.detail).toContain('"receive"');
  });

  it("trade ledger lines are kept for audit but never become transfers", async () => {
    const fake = new FakeKraken().addTrade({ txid: "TX1", pair: "ADAUSD", type: "buy", vol: "10", price: "1", time: T("08") });
    const { provider } = krakenHarness({ fake });
    expect(await provider.syncTransfers(all)).toEqual([]);
    const ledger = await provider.syncLedgerEntries(all);
    expect(ledger.map((e) => [e.entryType, e.externalReferenceId, e.asset])).toEqual(
      expect.arrayContaining([["trade", "TX1", "ADA"], ["trade", "TX1", "USD"]]),
    );
  });

  it("trades and ledger share one download per sync window", async () => {
    const fake = new FakeKraken().addTrade({ txid: "TX1", pair: "ADAUSD", type: "buy", vol: "10", price: "1", time: T("08") });
    const { provider } = krakenHarness({ fake });
    await provider.syncTrades(all);
    await provider.syncLedgerEntries(all);
    await provider.syncTransfers(all);
    expect(fake.callsTo("TradesHistory")).toBe(1);
    expect(fake.callsTo("Ledgers")).toBe(1);
    expect(fake.callsTo("AssetPairs")).toBe(1);
  });
});

describe("balances", () => {
  it("sums staking/earn buckets into the canonical asset and keeps the components", async () => {
    const fake = new FakeKraken();
    fake.balanceOverride = { ZUSD: "171.6158", XXBT: "0.1908877900", "ADA": "100.00000000", "ADA.S": "50.25000000", "ETH2.S": "1.5", "ETH2": "0.5" };
    const balances = await krakenHarness({ fake }).provider.getBalances();
    const byAsset = Object.fromEntries(balances.map((b) => [b.asset, b.total.toFixed()]));
    expect(byAsset).toEqual({ USD: "171.6158", BTC: "0.19088779", ADA: "150.25", ETH: "2" });
    expect(balances.find((b) => b.asset === "ADA")!.rawData).toEqual({ components: { ADA: "100.00000000", "ADA.S": "50.25000000" } });
  });
});
