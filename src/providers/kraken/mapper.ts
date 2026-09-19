import type { AssetCode } from "@/domain/transactions/types";
import { ProviderError } from "../types";
import type { KrakenAssetPairsResult, KrakenAssetsResult } from "./types";

/**
 * The single place where Kraken asset and pair identifiers become canonical
 * internal codes. Nothing outside src/providers/kraken/ ever sees "XXBT",
 * "ZUSD" or "ADA.S".
 *
 * Resolution order for an asset id:
 *   1. strip a balance-bucket suffix (.S .M .B .F) — same economic asset
 *   2. Kraken's Assets endpoint: id → altname (e.g. XXBT → XBT)
 *   3. static fallback table of legacy ids (used when Assets is unavailable)
 *   4. canonical overrides of Kraken-specific tickers (XBT → BTC, XDG → DOGE)
 * No prefix stripping is ever attempted: "XTZ" is Tezos, not "X" + "TZ".
 */

/** Kraken ticker → common ticker. */
const CANONICAL_OVERRIDES: Readonly<Record<string, AssetCode>> = {
  XBT: "BTC",
  XDG: "DOGE",
  ETH2: "ETH",
  // Kraken fee credits: id KFEE, altname FEE.
  FEE: "KFEE",
};

/**
 * Kraken's xStocks are tokenized equities/ETFs (issued by Backed Finance,
 * settled on Solana), Kraken's only stock-like product — it has never offered
 * traditional equity trading. Confirmed live tickers use a trailing lowercase
 * "x" (e.g. "AAPLx"), which the API surfaces uppercased ("AAPLX"). Some
 * historical trades instead used the bare underlying ticker as the raw base
 * asset id (e.g. pair "AAPLZUSD"), predating that pair's current listing.
 * Explicit and conservative: only these confirmed tickers are mapped, and
 * only from the bare id to its "X"-suffixed canonical form. Nothing is
 * inferred for unlisted stock-like symbols in general.
 * Source: https://www.kraken.com/xstocks (checked 2026-09-24).
 * Excluded deliberately: "V" (Visa) — a single-character raw id is too easy
 * to collide with; "BRK.B" (Berkshire Hathaway) — its dot would be stripped
 * by BUCKET_SUFFIX (".B" is the yield-bearing bucket suffix) before this
 * table is ever consulted, so it needs separate handling if it appears.
 */
const XSTOCK_LEGACY_BASE_IDS: Readonly<Record<string, AssetCode>> = Object.fromEntries(
  [
    "AAPL", "ABBV", "ABT", "ACN", "AMZN", "APP", "AVGO", "AZN", "BAC", "CMCSA",
    "COIN", "CRM", "CRWD", "CSCO", "CVX", "DHR", "GLD", "GME", "GOOGL", "GS",
    "HD", "HON", "HOOD", "IBM", "INTC", "JNJ", "JPM", "KO", "LIN", "LLY",
    "MA", "MCD", "MDT", "META", "MRK", "MRVL", "MSFT", "MSTR", "NFLX", "NVDA",
    "NVO", "ORCL", "PEP", "PFE", "PG", "PLTR", "PM", "QQQ", "SPY", "TMO",
    "TSLA", "UNH", "VTI", "WMT", "XOM",
  ].map((ticker) => [ticker, `${ticker}X`]),
);

/**
 * Kraken's Bonded Earn / opt-in staking product gives some bonded positions
 * their own numbered asset id instead of a ".S" bucket suffix (the same
 * pattern already seen with ETH2 above, e.g. SOL's non-flexible staking).
 * Evidence-driven, not a naming guess: a real account's ledger shows SOL03
 * and SOL moving 1:1 on Kraken's own "spottostaking"/"stakingtospot"
 * transfer subtypes, e.g. SOL -1.87013618 paired with SOL03 +1.87013618 at
 * the same instant (2025-03-05T12:28:25Z), and the reverse (SOL
 * +1.878602009 / SOL03 -1.878602009 at 2025-04-12T19:18:09-10Z) — Kraken
 * itself treats the conversion as the same underlying asset. Only ids
 * confirmed this way are mapped; an unrecognized numbered asset is left
 * alone rather than guessed at (no blanket digit-stripping).
 */
const KRAKEN_BONDED_ASSET_ALIASES: Readonly<Record<string, AssetCode>> = {
  SOL03: "SOL",
};

/**
 * Kraken fee credits: an internal fee-payment mechanism (1,000 KFEE = 10 USD of
 * trading fees), not tradable or withdrawable, so not a portfolio asset.
 */
export const KRAKEN_FEE_CREDIT_ASSETS: readonly AssetCode[] = ["KFEE"];

/** Legacy Kraken ids with X/Z prefixes → Kraken altname. Fallback only. */
const LEGACY_IDS: Readonly<Record<string, string>> = {
  XXBT: "XBT",
  XETH: "ETH",
  XETC: "ETC",
  XLTC: "LTC",
  XXRP: "XRP",
  XXLM: "XLM",
  XXMR: "XMR",
  XZEC: "ZEC",
  XREP: "REP",
  XMLN: "MLN",
  XXDG: "XDG",
  KFEE: "FEE",
  ZUSD: "USD",
  ZEUR: "EUR",
  ZGBP: "GBP",
  ZCAD: "CAD",
  ZJPY: "JPY",
  ZAUD: "AUD",
};

/** Fiat legacy ids, i.e. the subset of LEGACY_IDS usable as a historical quote-suffix fallback. */
const FIAT_LEGACY_IDS: ReadonlySet<string> = new Set(["ZUSD", "ZEUR", "ZGBP", "ZCAD", "ZJPY", "ZAUD"]);

/**
 * Suffixes marking the same asset held in a staking / earn bucket
 * (see Balance docs). ".T" (tokenized assets) is deliberately NOT here, and
 * ".HOLD" is Kraken's fiat hold bucket.
 */
const BUCKET_SUFFIX = /^(.+)\.(S|M|B|F|HOLD)$/;

const PLAIN_CODE = /^[A-Z0-9]+(\.[A-Z0-9]+)?$/;

export interface ResolvedPair {
  readonly base: AssetCode;
  readonly quote: AssetCode;
  /** "asset_pairs": listed in the current AssetPairs response. "historical_fallback": deterministically derived. */
  readonly mappingSource: "asset_pairs" | "historical_fallback";
}

export class KrakenAssetMapper {
  private readonly altnames = new Map<string, string>();
  private readonly pairs = new Map<string, { base: string; quote: string }>();
  private readonly precisionByCanonical = new Map<AssetCode, number>();

  constructor(assets: KrakenAssetsResult = {}, assetPairs: KrakenAssetPairsResult = {}) {
    for (const [id, info] of Object.entries(assets)) {
      if (info && typeof info.altname === "string") this.altnames.set(id, info.altname);
    }
    for (const [key, p] of Object.entries(assetPairs)) {
      if (!p || typeof p.base !== "string" || typeof p.quote !== "string") continue;
      this.pairs.set(key, { base: p.base, quote: p.quote });
      if (typeof p.altname === "string") this.pairs.set(p.altname, { base: p.base, quote: p.quote });
      if (typeof p.wsname === "string") this.pairs.set(p.wsname, { base: p.base, quote: p.quote });
    }
    // Smallest representable unit per canonical asset, for precision-aware
    // reconciliation. Where several raw ids alias to one canonical asset
    // (e.g. SOL / SOL03), the coarsest (smallest) precision wins: a
    // difference too small for the least-precise contributing component is
    // not meaningful either way.
    for (const [id, info] of Object.entries(assets)) {
      if (!info || typeof info.decimals !== "string") continue;
      const decimals = Number.parseInt(info.decimals, 10);
      if (!Number.isInteger(decimals) || decimals < 0) continue;
      let canonical: AssetCode;
      try {
        canonical = this.canonicalAsset(id);
      } catch {
        continue;
      }
      const existing = this.precisionByCanonical.get(canonical);
      this.precisionByCanonical.set(canonical, existing === undefined ? decimals : Math.min(existing, decimals));
    }
  }

  /** Canonical code of a Kraken asset id, e.g. XXBT → BTC, ADA.S → ADA, ZUSD → USD. */
  canonicalAsset(krakenAsset: string): AssetCode {
    const id = krakenAsset.trim().toUpperCase();
    if (!PLAIN_CODE.test(id)) {
      throw new ProviderError("invalid_response", `Unrecognized Kraken asset id "${krakenAsset.slice(0, 20)}"`, false);
    }
    const bucket = BUCKET_SUFFIX.exec(id);
    const baseId = bucket ? bucket[1]! : id;
    const altname =
      this.altnames.get(baseId) ?? LEGACY_IDS[baseId] ?? XSTOCK_LEGACY_BASE_IDS[baseId] ?? KRAKEN_BONDED_ASSET_ALIASES[baseId] ?? baseId;
    return CANONICAL_OVERRIDES[altname] ?? altname;
  }

  /** Decimal places Kraken itself represents this canonical asset with, or null if unknown. */
  precisionOf(asset: AssetCode): number | null {
    return this.precisionByCanonical.get(asset) ?? null;
  }

  /** Every canonical asset with known Kraken precision, e.g. for building a reconciliation tolerance map. */
  assetPrecision(): ReadonlyMap<AssetCode, number> {
    return new Map(this.precisionByCanonical);
  }

  /** Base and quote (canonical) of a Kraken pair name such as XXBTZUSD, ADAUSD or XETHXXBT. */
  resolvePair(pair: string): ResolvedPair {
    const known = this.pairs.get(pair);
    if (known) {
      return { base: this.canonicalAsset(known.base), quote: this.canonicalAsset(known.quote), mappingSource: "asset_pairs" };
    }
    const split = this.uniqueSplit(pair);
    if (split) return { ...split, mappingSource: "historical_fallback" };
    const suffix = this.quoteSuffixSplit(pair);
    if (suffix) return { ...suffix, mappingSource: "historical_fallback" };
    throw new ProviderError(
      "invalid_response",
      `Cannot determine base and quote of Kraken pair "${pair.slice(0, 20)}" (not listed and not unambiguous)`,
      false,
    );
  }

  /**
   * Delisted pairs are absent from AssetPairs. Accept a split into two known
   * asset ids only when exactly one such split exists; never guess otherwise.
   */
  private uniqueSplit(pair: string): { base: AssetCode; quote: AssetCode } | null {
    const known = new Set<string>([...this.altnames.keys(), ...this.altnames.values(), ...Object.keys(LEGACY_IDS)]);
    const candidates: Array<{ base: AssetCode; quote: AssetCode }> = [];
    for (let i = 2; i <= pair.length - 2; i++) {
      const a = pair.slice(0, i);
      const b = pair.slice(i);
      if (known.has(a) && known.has(b)) {
        candidates.push({ base: this.canonicalAsset(a), quote: this.canonicalAsset(b) });
      }
    }
    const distinct = new Map(candidates.map((c) => [`${c.base}/${c.quote}`, c]));
    return distinct.size === 1 ? [...distinct.values()][0]! : null;
  }

  /**
   * Historical pairs can be absent from AssetPairs entirely (not merely
   * delisted-but-both-sides-still-known-assets, which uniqueSplit handles):
   * Kraken's raw base asset id for the trade may never have appeared in any
   * Assets response we've seen (e.g. an xStock base id before it was renamed,
   * or a stock ticker Kraken never listed as a standalone "asset"). The quote
   * side is still reliably one of Kraken's known quote-asset ids, so splitting
   * off the LONGEST matching known quote suffix is deterministic even when the
   * base is unrecognized. The base is then canonicalized normally (explicit
   * overrides, or an identity pass-through — never invented).
   */
  private quoteSuffixSplit(pair: string): { base: AssetCode; quote: AssetCode } | null {
    const quotes = [...this.knownQuoteIds()].sort((a, b) => b.length - a.length);
    for (const quote of quotes) {
      if (pair.length <= quote.length || !pair.endsWith(quote)) continue;
      const rawBase = pair.slice(0, pair.length - quote.length);
      if (!PLAIN_CODE.test(rawBase)) continue;
      return { base: this.canonicalAsset(rawBase), quote: this.canonicalAsset(quote) };
    }
    return null;
  }

  /** Every raw/altname id ever seen as a quote asset in AssetPairs, plus the static fiat fallback. */
  private knownQuoteIds(): Set<string> {
    const ids = new Set<string>();
    for (const { quote } of this.pairs.values()) {
      ids.add(quote);
      const alt = this.altnames.get(quote);
      if (alt) ids.add(alt);
    }
    for (const raw of FIAT_LEGACY_IDS) {
      ids.add(raw);
      ids.add(LEGACY_IDS[raw]!);
    }
    return ids;
  }
}
