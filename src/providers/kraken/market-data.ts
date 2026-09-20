import { dec, InvalidDecimalError } from "@/domain/decimal";
import type { AssetCode, PriceQuote } from "@/domain/transactions/types";
import type { CurrentPrices, MarketDataProvider, PriceUnavailableReason } from "../types";
import type { KrakenClient } from "./client";
import type { KrakenAssetMapper } from "./mapper";
import { PROVIDER_TYPE } from "./normalizer";
import { fetchTicker } from "./rest";
import { loadAssetMapper } from "./sync";

/** Asset/pair metadata changes rarely; reload it at most this often. */
const MAPPER_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Current prices from Kraken's public Ticker endpoint (last trade price), via
 * direct markets only (e.g. ADA/USD). An asset without a direct market is
 * reported as unavailable — no cross-rate is computed.
 */
export class KrakenMarketData implements MarketDataProvider {
  readonly source = PROVIDER_TYPE;
  private mapper: { value: Promise<KrakenAssetMapper>; loadedAt: number } | null = null;

  constructor(
    private readonly client: KrakenClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getCurrentPrices(assets: readonly AssetCode[], quote: AssetCode): Promise<CurrentPrices> {
    const mapper = await this.assetMapper();
    const unavailable: { asset: AssetCode; reason: PriceUnavailableReason }[] = [];
    const wanted: { asset: AssetCode; key: string }[] = [];
    for (const asset of [...new Set(assets)].sort()) {
      const market = mapper.marketFor(asset, quote);
      if (market) wanted.push({ asset, key: market.key });
      else unavailable.push({ asset, reason: "no_direct_market" });
    }
    if (wanted.length === 0) return { quotes: [], unavailable };

    const ticker = await fetchTicker(this.client, wanted.map((w) => w.key));
    const asOf = this.now();
    const quotes: PriceQuote[] = [];
    for (const w of wanted) {
      const last = ticker[w.key]?.c?.[0];
      const price = typeof last === "string" ? parsePrice(last) : null;
      if (price === null) unavailable.push({ asset: w.asset, reason: "no_price_returned" });
      else quotes.push({ source: PROVIDER_TYPE, baseAsset: w.asset, quoteAsset: quote, price, asOf });
    }
    return { quotes, unavailable };
  }

  private assetMapper(): Promise<KrakenAssetMapper> {
    const t = this.now().getTime();
    if (!this.mapper || t - this.mapper.loadedAt > MAPPER_TTL_MS) {
      const value = loadAssetMapper(this.client);
      this.mapper = { value, loadedAt: t };
      value.catch(() => {
        if (this.mapper?.value === value) this.mapper = null;
      });
    }
    return this.mapper.value;
  }
}

function parsePrice(s: string) {
  try {
    const d = dec(s);
    return d.greaterThan(0) ? d : null;
  } catch (e) {
    if (e instanceof InvalidDecimalError) return null;
    throw e;
  }
}
