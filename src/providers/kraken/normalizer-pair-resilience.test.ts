import { describe, expect, it } from "vitest";
import { KrakenAssetMapper } from "./mapper";
import { normalizeTrades } from "./normalizer";
import type { KrakenTradeRow } from "./types";

/**
 * #11 A single unparseable historical Kraken pair must not abort the rest of
 * the account's trade history sync. See docs/kraken-api-notes.md and
 * mapper.test.ts (#10) for the pair-resolution logic itself.
 */

function tradeRow(overrides: Partial<KrakenTradeRow> & { pair: string }): KrakenTradeRow {
  return {
    ordertxid: "O1",
    time: "1700000000.0000",
    type: "buy",
    ordertype: "market",
    price: "1.0",
    cost: "1.0",
    fee: "0.0",
    vol: "1.0",
    margin: "0",
    misc: "",
    ...overrides,
  };
}

const mapper = new KrakenAssetMapper(
  { ZUSD: { aclass: "currency", altname: "USD" }, ADA: { aclass: "currency", altname: "ADA" } },
  { ADAUSD: { altname: "ADAUSD", wsname: "ADA/USD", base: "ADA", quote: "ZUSD" } },
);

function normalize(rows: ReadonlyMap<string, KrakenTradeRow>) {
  return normalizeTrades({
    mapper,
    providerAccountId: "acct-1",
    feeCreditAssets: new Set(),
    rows,
    ledgerByRefid: new Map(),
  });
}

describe("#11 unsupported Kraken pair does not abort the rest of the sync", () => {
  it("skips only the unparseable trade and still normalizes the rest", () => {
    const rows = new Map<string, KrakenTradeRow>([
      ["T1", tradeRow({ pair: "ADAUSD" })],
      ["T2", tradeRow({ pair: "ZZZZZZ" })], // no registered asset, no known quote suffix
      ["T3", tradeRow({ pair: "ADAUSD" })],
    ]);

    const { trades, skipped } = normalize(rows);

    expect(trades.map((t) => t.externalTradeId)).toEqual(["T1", "T3"]);
    expect(skipped).toEqual([{ txid: "T2", reason: "unsupported_pair", pair: "ZZZZZZ", row: rows.get("T2") }]);
  });

  it("preserves the original raw pair string and full trade row on the skipped record", () => {
    const badRow = tradeRow({ pair: "ZZZZZZ", vol: "42.5", price: "3.14" });
    const rows = new Map<string, KrakenTradeRow>([["T1", badRow]]);

    const { trades, skipped } = normalize(rows);

    expect(trades).toEqual([]);
    expect(skipped).toHaveLength(1);
    const entry = skipped[0]!;
    expect(entry.reason).toBe("unsupported_pair");
    expect(entry).toMatchObject({ pair: "ZZZZZZ", row: badRow });
  });

  it("records mapping_source on trades resolved via the historical fallback", () => {
    const rows = new Map<string, KrakenTradeRow>([["T1", tradeRow({ pair: "ADAUSD" })]]);
    const { trades } = normalize(rows);
    expect((trades[0]!.rawData as { pairMappingSource: string }).pairMappingSource).toBe("asset_pairs");
  });
});
