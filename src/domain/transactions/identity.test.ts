import { describe, expect, it } from "vitest";
import { dedupeBy, newRecords, tradeKey } from "@/domain/transactions/identity";
import { validateTrade } from "@/domain/transactions/validate";
import { dec } from "@/domain/decimal";
import { buy, scenario } from "@/test/builders";

describe("#21 duplicate imported transaction", () => {
  it("the same provider record always has the same key", () => {
    const a = buy("1", "10", { id: "TXID-1" });
    const b = { ...a, rawData: { refetched: true } };
    expect(tradeKey(a)).toBe(tradeKey(b));
    expect(tradeKey(a)).not.toBe(tradeKey({ ...a, providerAccountId: "other" }));
  });

  it("in-batch duplicates are dropped, first occurrence kept", () => {
    const a = buy("1", "10", { id: "TXID-1" });
    const { unique, duplicates } = dedupeBy([a, { ...a }, buy("2", "10", { id: "TXID-2" })], tradeKey);
    expect(unique.map((t) => t.externalTradeId)).toEqual(["TXID-1", "TXID-2"]);
    expect(duplicates).toHaveLength(1);
  });

  it("already-stored keys are skipped", () => {
    const a = buy("1", "10", { id: "TXID-1" });
    const b = buy("1", "10", { id: "TXID-2" });
    expect(newRecords([a, b], new Set([tradeKey(a)]), tradeKey)).toEqual([b]);
  });
});

describe("#22 duplicate WebSocket + REST event", () => {
  it("a live event and its REST counterpart collapse to one trade and one lot", () => {
    const fromRest = buy("5", "2", { id: "TX-LIVE" });
    const fromWs = { ...fromRest, rawData: { channel: "executions" } };
    const { unique } = dedupeBy([fromWs, fromRest], tradeKey);
    expect(unique).toHaveLength(1);
    const s = scenario({ trades: unique });
    expect(s.engine.lots).toHaveLength(1);
    expect(s.position().holdings.toFixed()).toBe("5");
  });
});

describe("record validation", () => {
  it("rejects malformed trades", () => {
    const t = buy("1", "10", { id: "X" });
    expect(validateTrade(t, "acct-1")).toEqual([]);
    expect(validateTrade({ ...t, quantity: dec("0") }, "acct-1")).toContain("quantity must be positive");
    expect(validateTrade({ ...t, fee: dec("1"), feeAsset: null }, "acct-1")).toContain("fee asset missing for non-zero fee");
    expect(validateTrade({ ...t, executedAt: new Date("garbage") }, "acct-1")).toContain("invalid execution time");
    expect(validateTrade(t, "acct-2")).toContain("belongs to another account");
  });
});
