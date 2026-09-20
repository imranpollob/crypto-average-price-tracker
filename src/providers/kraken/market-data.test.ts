import { describe, expect, it } from "vitest";
import { KrakenMarketData } from "./market-data";
import { FakeKraken } from "./testing/fake-kraken";
import { krakenHarness } from "./testing/harness";

/** MVP pricing: Kraken public Ticker, direct USD markets only. */

function setup(fake = new FakeKraken()) {
  const h = krakenHarness({ fake });
  return { fake, md: new KrakenMarketData(h.client, () => new Date(h.clock.now())) };
}

describe("Kraken current prices", () => {
  it("#1 returns the last trade price of the asset's USD market, keyed by canonical asset", async () => {
    const { fake, md } = setup();
    fake.tickers = { XXBTZUSD: "112500.10000", ADAUSD: "0.145000" };
    const r = await md.getCurrentPrices(["BTC", "ADA"], "USD");
    expect(r.quotes.map((q) => [q.baseAsset, q.quoteAsset, q.price.toFixed(), q.source])).toEqual([
      ["ADA", "USD", "0.145", "kraken"],
      ["BTC", "USD", "112500.1", "kraken"],
    ]);
    expect(r.unavailable).toEqual([]);
  });

  it("#25 keeps the exact decimal price (no float rounding)", async () => {
    const { fake, md } = setup();
    fake.tickers = { ADAUSD: "0.1234567890123456789" };
    const r = await md.getCurrentPrices(["ADA"], "USD");
    expect(r.quotes[0]!.price.toFixed()).toBe("0.1234567890123456789");
  });

  it("#2/#29 an asset without a direct USD market is unavailable, never converted through another pair", async () => {
    const { fake, md } = setup();
    fake.assets.KAS = { aclass: "currency", altname: "KAS" };
    fake.pairs.KASEUR = { altname: "KASEUR", base: "KAS", quote: "ZEUR" };
    fake.tickers = { ADAUSD: "0.145", KASEUR: "0.1" };
    const r = await md.getCurrentPrices(["ADA", "KAS", "NOMKT"], "USD");
    expect(r.quotes.map((q) => q.baseAsset)).toEqual(["ADA"]);
    expect(r.unavailable).toEqual([
      { asset: "KAS", reason: "no_direct_market" },
      { asset: "NOMKT", reason: "no_direct_market" },
    ]);
  });

  it("a market that returns no usable price is reported, not guessed", async () => {
    const { fake, md } = setup();
    fake.tickers = { ADAUSD: "0" };
    const r = await md.getCurrentPrices(["ADA", "BTC"], "USD");
    expect(r.quotes).toEqual([]);
    expect(r.unavailable).toEqual([
      { asset: "ADA", reason: "no_price_returned" },
      { asset: "BTC", reason: "no_price_returned" },
    ]);
  });

  it("uses one public Ticker request for all assets and never a private endpoint", async () => {
    const { fake, md } = setup();
    fake.tickers = { XXBTZUSD: "1", XETHZUSD: "2", ADAUSD: "3" };
    await md.getCurrentPrices(["BTC", "ETH", "ADA"], "USD");
    await md.getCurrentPrices(["BTC"], "USD");
    expect(fake.callsTo("Ticker")).toBe(2);
    // Asset metadata is loaded once and reused.
    expect(fake.callsTo("AssetPairs")).toBe(1);
    expect(["Balance", "TradesHistory", "Ledgers", "GetApiKeyInfo"].map((m) => fake.callsTo(m as never))).toEqual([0, 0, 0, 0]);
  });

  it("ignores dark-pool and delisted pairs", async () => {
    const { fake, md } = setup();
    fake.assets.XYZ = { aclass: "currency", altname: "XYZ" };
    fake.pairs["XYZUSD.d"] = { altname: "XYZUSD.d", base: "XYZ", quote: "ZUSD" };
    fake.pairs.XYZUSD = { altname: "XYZUSD", base: "XYZ", quote: "ZUSD", status: "delisted" };
    const r = await md.getCurrentPrices(["XYZ"], "USD");
    expect(r.unavailable).toEqual([{ asset: "XYZ", reason: "no_direct_market" }]);
    expect(fake.callsTo("Ticker")).toBe(0);
  });
});
