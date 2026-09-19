import { describe, expect, it } from "vitest";
import { KrakenAssetMapper } from "./mapper";

const assets = {
  XXBT: { aclass: "currency", altname: "XBT" },
  XETH: { aclass: "currency", altname: "ETH" },
  XXDG: { aclass: "currency", altname: "XDG" },
  ZUSD: { aclass: "currency", altname: "USD" },
  ZEUR: { aclass: "currency", altname: "EUR" },
  ADA: { aclass: "currency", altname: "ADA" },
  XTZ: { aclass: "currency", altname: "XTZ" },
  USDT: { aclass: "currency", altname: "USDT" },
  ETH2: { aclass: "currency", altname: "ETH2" },
};
const pairs = {
  XXBTZUSD: { altname: "XBTUSD", wsname: "XBT/USD", base: "XXBT", quote: "ZUSD" },
  XETHXXBT: { altname: "ETHXBT", wsname: "ETH/XBT", base: "XETH", quote: "XXBT" },
  ADAUSD: { altname: "ADAUSD", wsname: "ADA/USD", base: "ADA", quote: "ZUSD" },
  ADAUSDT: { altname: "ADAUSDT", base: "ADA", quote: "USDT" },
};

describe("#9 Kraken asset-symbol mapping", () => {
  const m = new KrakenAssetMapper(assets, pairs);

  it.each([
    ["XXBT", "BTC"],
    ["XBT", "BTC"],
    ["XBT.M", "BTC"],
    ["XETH", "ETH"],
    ["ETH2", "ETH"],
    ["ETH2.S", "ETH"],
    ["XXDG", "DOGE"],
    ["ZUSD", "USD"],
    ["USD.HOLD", "USD"],
    ["USD.M", "USD"],
    ["ZEUR", "EUR"],
    ["ADA", "ADA"],
    ["ADA.S", "ADA"],
    ["USDT.F", "USDT"],
    ["XTZ", "XTZ"], // Tezos: never stripped to "TZ"
    ["DOT", "DOT"], // not in Assets: plain code passes through
  ])("%s → %s", (kraken, canonical) => {
    expect(m.canonicalAsset(kraken)).toBe(canonical);
  });

  it("does not strip the tokenized-asset suffix", () => {
    expect(m.canonicalAsset("AAPLX.T")).toBe("AAPLX.T");
  });

  it("uses the static legacy table when Assets is unavailable", () => {
    const bare = new KrakenAssetMapper();
    expect(bare.canonicalAsset("XXBT")).toBe("BTC");
    expect(bare.canonicalAsset("ZUSD")).toBe("USD");
  });

  it("rejects malformed asset ids", () => {
    expect(() => m.canonicalAsset("ADA/USD")).toThrow(/Unrecognized/);
  });

  it("normalizes the confirmed SOL03 bonded-staking alias to SOL", () => {
    expect(m.canonicalAsset("SOL03")).toBe("SOL");
  });

  it("does not guess an unconfirmed numbered asset", () => {
    expect(m.canonicalAsset("DOT02")).toBe("DOT02");
    expect(m.canonicalAsset("SOL04")).toBe("SOL04");
  });
});

describe("#12 Kraken asset precision", () => {
  it("reads decimals from the Assets response per canonical asset", () => {
    const m = new KrakenAssetMapper({ ...assets, SOL: { aclass: "currency", altname: "SOL", decimals: "10" } }, pairs);
    expect(m.precisionOf("SOL")).toBe(10);
    expect(m.precisionOf("ADA")).toBeNull();
  });

  it("uses the coarsest (smallest) precision when several raw ids alias to one canonical asset", () => {
    // XETH and ETH2 both legitimately appear in a real Assets response and
    // both canonicalize to ETH (via altname and CANONICAL_OVERRIDES respectively).
    const m = new KrakenAssetMapper(
      {
        XETH: { aclass: "currency", altname: "ETH", decimals: "10" },
        ETH2: { aclass: "currency", altname: "ETH2", decimals: "5" },
      },
      {},
    );
    expect(m.precisionOf("ETH")).toBe(5);
  });

  it("is null for an asset with no decimals field", () => {
    const m = new KrakenAssetMapper({ ADA: { aclass: "currency", altname: "ADA" } }, {});
    expect(m.precisionOf("ADA")).toBeNull();
  });

  it("exposes the full precision map", () => {
    const m = new KrakenAssetMapper(
      { ADA: { aclass: "currency", altname: "ADA", decimals: "8" }, ZUSD: { aclass: "currency", altname: "USD", decimals: "4" } },
      {},
    );
    expect(m.assetPrecision()).toEqual(new Map([["ADA", 8], ["USD", 4]]));
  });
});

describe("Kraken pair resolution", () => {
  const m = new KrakenAssetMapper(assets, pairs);

  it.each([
    ["XXBTZUSD", "BTC", "USD"],
    ["XBTUSD", "BTC", "USD"],
    ["XBT/USD", "BTC", "USD"],
    ["XETHXXBT", "ETH", "BTC"],
    ["ADAUSD", "ADA", "USD"],
    ["ADAUSDT", "ADA", "USDT"],
  ])("%s → %s/%s", (pair, base, quote) => {
    expect(m.resolvePair(pair)).toEqual({ base, quote, mappingSource: "asset_pairs" });
  });

  it("resolves a delisted pair only when the split is unambiguous", () => {
    expect(m.resolvePair("XTZEUR")).toEqual({ base: "XTZ", quote: "EUR", mappingSource: "historical_fallback" });
  });

  it("refuses to guess an unknown pair", () => {
    expect(() => m.resolvePair("FOOBAR")).toThrow(/Cannot determine/);
  });
});

describe("#10 historical-pair fallback (quote-suffix split)", () => {
  const m = new KrakenAssetMapper(assets, pairs);

  it("splits a historical xStock pair absent from AssetPairs (AAPLZUSD)", () => {
    // Base "AAPL" is not in Assets/AssetPairs at all (it predates or was renamed
    // since the pair's current listing); the quote "ZUSD" is a known fiat quote.
    expect(m.resolvePair("AAPLZUSD")).toEqual({ base: "AAPLX", quote: "USD", mappingSource: "historical_fallback" });
  });

  it("still resolves ordinary listed pairs via AssetPairs, not the fallback", () => {
    expect(m.resolvePair("XXBTZUSD")).toEqual({ base: "BTC", quote: "USD", mappingSource: "asset_pairs" });
  });

  it("still resolves ADAUSD via AssetPairs (listed), not the fallback", () => {
    expect(m.resolvePair("ADAUSD")).toEqual({ base: "ADA", quote: "USD", mappingSource: "asset_pairs" });
  });

  it("prefers the longest matching quote suffix (ZUSD over USD)", () => {
    // Both "ZUSD" (4 chars) and "USD" (3 chars) are known quote candidates.
    // Matching the shorter "USD" first would wrongly leave "AAPLZ" as the base.
    expect(m.resolvePair("AAPLZUSD")).not.toEqual(expect.objectContaining({ base: "AAPLZ" }));
    expect(m.resolvePair("AAPLZUSD")).toEqual({ base: "AAPLX", quote: "USD", mappingSource: "historical_fallback" });
  });

  it("does not false-split a base whose name merely contains a quote-like substring", () => {
    // "EURT" contains "EUR" but does not END in a known quote suffix by itself;
    // only the trailing "ZUSD" is a real quote, so the base stays whole ("EURT").
    expect(m.resolvePair("EURTZUSD")).toEqual({ base: "EURT", quote: "USD", mappingSource: "historical_fallback" });
  });

  it("resolves a historical pair absent from AssetPairs but deterministically parseable", () => {
    // "DOGEUSD" absent from AssetPairs (only XXDGZUSD is listed under its legacy
    // pair key); the bare altname "DOGE" is not a registered asset id either, so
    // this only resolves via the quote-suffix fallback, not uniqueSplit.
    expect(m.resolvePair("DOGEZUSD")).toEqual({ base: "DOGE", quote: "USD", mappingSource: "historical_fallback" });
  });

  it("throws on a genuinely ambiguous pair (multiple equally valid both-known splits)", () => {
    // Assets "AB", "CAB" and "ABC" are all known, but none is a registered quote,
    // so two distinct interpretations of "ABCAB" are both valid: ambiguous.
    const ambiguous = new KrakenAssetMapper(
      {
        AB: { aclass: "currency", altname: "AB" },
        CAB: { aclass: "currency", altname: "CAB" },
        ABC: { aclass: "currency", altname: "ABC" },
      },
      {},
    );
    expect(() => ambiguous.resolvePair("ABCAB")).toThrow(/Cannot determine/);
  });

  it("throws on a genuinely unparseable pair (no known quote suffix, no known split)", () => {
    expect(() => m.resolvePair("ZZZZZZ")).toThrow(/Cannot determine/);
  });

  it("current AssetPairs mapping always takes precedence over fallback logic", () => {
    // ADAUSD is listed with base "ADA"; even though "USD" would also be a valid
    // quote-suffix split candidate, the listed mapping must win.
    expect(m.resolvePair("ADAUSD")).toEqual({ base: "ADA", quote: "USD", mappingSource: "asset_pairs" });
  });
});
