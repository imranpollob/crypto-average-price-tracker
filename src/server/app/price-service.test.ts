import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dec } from "@/domain/decimal";
import type { AssetCode } from "@/domain/transactions/types";
import { KrakenMarketData } from "@/providers/kraken/market-data";
import { FakeKraken } from "@/providers/kraken/testing/fake-kraken";
import { krakenHarness } from "@/providers/kraken/testing/harness";
import type { CurrentPrices, MarketDataProvider } from "@/providers/types";
import type { Db } from "@/server/db/client";
import { createTestDb } from "@/test/test-db";
import { PriceService } from "./price-service";

let db: Db;
let cleanup: () => Promise<void>;
let nowMs: number;
const now = () => new Date(nowMs);

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  nowMs = Date.parse("2026-09-24T12:00:00Z");
});
afterEach(async () => {
  await cleanup();
});

/** Controllable market-data source. */
class StubSource implements MarketDataProvider {
  readonly source = "kraken";
  calls = 0;
  prices: Record<string, string> = {};
  fail: string | null = null;
  async getCurrentPrices(assets: readonly AssetCode[], quote: AssetCode): Promise<CurrentPrices> {
    this.calls++;
    await new Promise((r) => setTimeout(r, 5));
    if (this.fail) throw new Error(this.fail);
    return {
      quotes: assets.filter((a) => this.prices[a]).map((a) => ({ source: "kraken", baseAsset: a, quoteAsset: quote, price: dec(this.prices[a]!), asOf: now() })),
      unavailable: assets.filter((a) => !this.prices[a]).map((a) => ({ asset: a, reason: "no_direct_market" as const })),
    };
  }
}

describe("#3-4 price cache", () => {
  it("#3 caches fetched prices; a new process reads them without any request", async () => {
    const src = new StubSource();
    src.prices = { ADA: "0.145", BTC: "112500" };
    const out = await new PriceService(db, src, "USD", now).refresh(["ADA", "BTC"]);
    expect([out.ok, out.updated]).toEqual([true, 2]);

    const restarted = new PriceService(db, src, "USD", now);
    const cached = await restarted.cached();
    expect([...cached.values()].map((c) => [c.asset, c.price.toFixed(), c.asOf.toISOString()])).toEqual([
      ["ADA", "0.145", "2026-09-24T12:00:00.000Z"],
      ["BTC", "112500", "2026-09-24T12:00:00.000Z"],
    ]);
    expect(src.calls).toBe(1);
    expect((await restarted.updatedAt())?.toISOString()).toBe("2026-09-24T12:00:00.000Z");
  });

  it("#4 an old cached price is still the latest known price, but reported as stale", async () => {
    const src = new StubSource();
    src.prices = { ADA: "0.145" };
    const svc = new PriceService(db, src, "USD", now, 5 * 60_000);
    await svc.refresh(["ADA"]);
    const asOf = (await svc.cached()).get("ADA")!.asOf;
    expect(svc.isStale(asOf)).toBe(false);
    nowMs += 6 * 60_000;
    expect(svc.isStale(asOf)).toBe(true);
    expect((await svc.cached()).get("ADA")!.price.toFixed()).toBe("0.145");
  });

  it("a failed refresh keeps the cached prices and reports the error", async () => {
    const src = new StubSource();
    src.prices = { ADA: "0.145" };
    const svc = new PriceService(db, src, "USD", now);
    await svc.refresh(["ADA"]);
    src.fail = "Network error while calling Kraken Ticker";
    nowMs += 60_000;
    const out = await svc.refresh(["ADA"]);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("Network error while calling Kraken Ticker");
    expect((await svc.cached()).get("ADA")!.price.toFixed()).toBe("0.145");
  });

  it("records why an asset has no price", async () => {
    const src = new StubSource();
    src.prices = { ADA: "0.145" };
    const svc = new PriceService(db, src, "USD", now);
    await svc.refresh(["ADA", "BRICK"]);
    expect(svc.unavailableReason("BRICK")).toBe("no_direct_market");
    expect(svc.unavailableReason("ADA")).toBeNull();
  });

  it("concurrent refreshes share one request; refreshIfOlderThan respects the interval and backs off after a failure", async () => {
    const src = new StubSource();
    src.prices = { ADA: "0.145" };
    const svc = new PriceService(db, src, "USD", now);
    await Promise.all([svc.refresh(["ADA"]), svc.refresh(["ADA"]), svc.refresh(["ADA"])]);
    expect(src.calls).toBe(1);

    expect(await svc.refreshIfOlderThan(["ADA"], 30_000)).toBeNull();
    nowMs += 31_000;
    expect((await svc.refreshIfOlderThan(["ADA"], 30_000))?.ok).toBe(true);
    expect(src.calls).toBe(2);

    src.fail = "down";
    nowMs += 31_000;
    expect((await svc.refreshIfOlderThan(["ADA"], 30_000))?.ok).toBe(false);
    nowMs += 5_000;
    expect(await svc.refreshIfOlderThan(["ADA"], 30_000)).toBeNull();
    expect(src.calls).toBe(3);
  });
});

describe("#23 a price refresh is not an account sync", () => {
  it("only calls public market-data endpoints and records no sync run", async () => {
    const fake = new FakeKraken();
    fake.tickers = { XXBTZUSD: "112500", ADAUSD: "0.145" };
    const h = krakenHarness({ fake });
    const svc = new PriceService(db, new KrakenMarketData(h.client, now), "USD", now);
    const out = await svc.refresh(["BTC", "ADA"]);
    expect(out.updated).toBe(2);
    expect(["Balance", "TradesHistory", "Ledgers", "GetApiKeyInfo"].map((m) => fake.callsTo(m as never))).toEqual([0, 0, 0, 0]);
    expect(await db.syncRun.count()).toBe(0);
  });
});
