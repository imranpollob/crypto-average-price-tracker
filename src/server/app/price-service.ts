import type { Decimal } from "@/domain/decimal";
import type { AssetCode } from "@/domain/transactions/types";
import { safeErrorMessage } from "@/lib/redact";
import type { MarketDataProvider, PriceUnavailableReason } from "@/providers/types";
import type { Db } from "../db/client";
import { d2s, s2d } from "../db/codec";

/**
 * Current prices: fetched from a public market-data source and cached in
 * price_cache. Market data only — never accounting truth. A refresh never
 * touches the account (no private endpoints, no history sync).
 */

export interface CachedPrice {
  readonly asset: AssetCode;
  readonly price: Decimal;
  readonly asOf: Date;
}

export interface PriceRefreshOutcome {
  readonly ok: boolean;
  readonly at: Date;
  readonly updated: number;
  readonly unavailable: readonly { readonly asset: AssetCode; readonly reason: PriceUnavailableReason }[];
  readonly error: string | null;
}

/** A price older than this is shown as stale (it is still the latest known price). */
export const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

export class PriceService {
  private inFlight: Promise<PriceRefreshOutcome> | null = null;
  private last: PriceRefreshOutcome | null = null;
  private lastSuccessAt: Date | null = null;
  private readonly unavailable = new Map<AssetCode, PriceUnavailableReason>();

  constructor(
    private readonly db: Db,
    private readonly source: MarketDataProvider | null,
    private readonly quote: AssetCode,
    private readonly now: () => Date = () => new Date(),
    readonly staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
  ) {}

  /** Latest cached price per asset, in the reporting currency. */
  async cached(): Promise<Map<AssetCode, CachedPrice>> {
    if (!this.source) return new Map();
    const rows = await this.db.priceCache.findMany({ where: { source: this.source.source, quoteAsset: this.quote } });
    return new Map(rows.map((r) => [r.baseAsset, { asset: r.baseAsset, price: s2d(r.price), asOf: r.asOf }]));
  }

  isStale(asOf: Date): boolean {
    return this.now().getTime() - asOf.getTime() > this.staleAfterMs;
  }

  /** Why the last refresh returned no price for `asset`, if it did not. */
  unavailableReason(asset: AssetCode): PriceUnavailableReason | null {
    return this.unavailable.get(asset) ?? null;
  }

  lastRefresh(): PriceRefreshOutcome | null {
    return this.last;
  }

  isRefreshing(): boolean {
    return this.inFlight !== null;
  }

  /** Time of the last successful refresh in this process, else the newest cached price. */
  async updatedAt(): Promise<Date | null> {
    if (this.lastSuccessAt) return this.lastSuccessAt;
    if (!this.source) return null;
    const newest = await this.db.priceCache.findFirst({
      where: { source: this.source.source, quoteAsset: this.quote },
      orderBy: { asOf: "desc" },
      select: { asOf: true },
    });
    return newest?.asOf ?? null;
  }

  /** Fetch and cache current prices. Concurrent calls share one request. Never throws. */
  refresh(assets: readonly AssetCode[]): Promise<PriceRefreshOutcome> {
    this.inFlight ??= this.fetch(assets).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Refresh only when the last successful refresh is older than `maxAgeMs`; returns null when fresh enough. */
  async refreshIfOlderThan(assets: readonly AssetCode[], maxAgeMs: number): Promise<PriceRefreshOutcome | null> {
    if (this.inFlight) return this.inFlight;
    const last = await this.updatedAt();
    const lastAttempt = this.last?.at ?? null;
    const t = this.now().getTime();
    // Also back off after a failed attempt, so an outage is not hammered.
    if (last && t - last.getTime() < maxAgeMs) return null;
    if (lastAttempt && t - lastAttempt.getTime() < maxAgeMs) return null;
    return this.refresh(assets);
  }

  private async fetch(assets: readonly AssetCode[]): Promise<PriceRefreshOutcome> {
    const at = this.now();
    if (!this.source) {
      return (this.last = { ok: false, at, updated: 0, unavailable: [], error: "No market-data source is configured." });
    }
    if (assets.length === 0) return (this.last = { ok: true, at, updated: 0, unavailable: [], error: null });
    try {
      const { quotes, unavailable } = await this.source.getCurrentPrices(assets, this.quote);
      await this.db.$transaction(
        quotes.map((q) =>
          this.db.priceCache.upsert({
            where: { source_baseAsset_quoteAsset: { source: q.source, baseAsset: q.baseAsset, quoteAsset: q.quoteAsset } },
            create: { source: q.source, baseAsset: q.baseAsset, quoteAsset: q.quoteAsset, price: d2s(q.price), asOf: q.asOf },
            update: { price: d2s(q.price), asOf: q.asOf },
          }),
        ),
      );
      for (const q of quotes) this.unavailable.delete(q.baseAsset);
      for (const u of unavailable) this.unavailable.set(u.asset, u.reason);
      this.lastSuccessAt = at;
      return (this.last = { ok: true, at, updated: quotes.length, unavailable, error: null });
    } catch (error) {
      return (this.last = { ok: false, at, updated: 0, unavailable: [], error: safeErrorMessage(error) });
    }
  }
}
