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
    expect(m.resolvePair(pair)).toEqual({ base, quote });
  });

  it("resolves a delisted pair only when the split is unambiguous", () => {
    expect(m.resolvePair("XTZEUR")).toEqual({ base: "XTZ", quote: "EUR" });
  });

  it("refuses to guess an unknown pair", () => {
    expect(() => m.resolvePair("FOOBAR")).toThrow(/Cannot determine/);
  });
});
