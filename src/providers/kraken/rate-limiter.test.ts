import { describe, expect, it } from "vitest";
import { createKeyContext, KrakenClient } from "./client";
import { CallCounterLimiter, callCost, DEFAULT_KRAKEN_TIER, type RateLimitPolicy } from "./rate-limiter";
import { FakeKraken } from "./testing/fake-kraken";
import { KrakenProvider } from "./provider";

describe("rate limiting", () => {
  it("defaults to the most conservative documented tier", () => {
    expect(DEFAULT_KRAKEN_TIER).toBe("starter");
    expect(createKeyContext().limiter).toBeInstanceOf(CallCounterLimiter);
  });

  it("uses the documented call costs", () => {
    expect([callCost("TradesHistory"), callCost("Ledgers"), callCost("Balance"), callCost("GetApiKeyInfo")]).toEqual([2, 2, 1, 1]);
  });

  it("any RateLimitPolicy can be plugged in without changing the client or sync logic", async () => {
    const acquired: number[] = [];
    const policy: RateLimitPolicy = {
      acquire: async (cost) => {
        acquired.push(cost);
      },
      penalize: () => {},
    };
    const fake = new FakeKraken().addTrade({ txid: "T1", pair: "ADAUSD", type: "buy", vol: "1", price: "1", time: "1790000000.0000" });
    const client = new KrakenClient({
      credentials: { apiKey: fake.apiKey, apiSecret: fake.apiSecret },
      fetch: fake.fetch,
      context: createKeyContext({ limiter: policy }),
    });
    const provider = new KrakenProvider("acct", client, () => new Date("2026-09-24T12:00:00Z"));
    await provider.testConnection();
    await provider.syncTrades({ since: null, until: new Date("2026-09-24T12:00:00Z") });
    // GetApiKeyInfo (1), TradesHistory (2), Ledgers (2) — public endpoints are not counted.
    expect(acquired).toEqual([1, 2, 2]);
  });

  it("the Starter limiter waits instead of exceeding 15 points", async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new CallCounterLimiter("starter", () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    for (let i = 0; i < 7; i++) await limiter.acquire(2); // 14 points, no wait
    expect(waits).toEqual([]);
    await limiter.acquire(2); // would be 16 → wait for 1 point to decay at 0.33/s
    expect(waits).toEqual([Math.ceil((1 / 0.33) * 1000)]);
  });
});
