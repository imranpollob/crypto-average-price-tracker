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
}

export class KrakenAssetMapper {
  private readonly altnames = new Map<string, string>();
  private readonly pairs = new Map<string, { base: string; quote: string }>();

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
  }

  /** Canonical code of a Kraken asset id, e.g. XXBT → BTC, ADA.S → ADA, ZUSD → USD. */
  canonicalAsset(krakenAsset: string): AssetCode {
    const id = krakenAsset.trim().toUpperCase();
    if (!PLAIN_CODE.test(id)) {
      throw new ProviderError("invalid_response", `Unrecognized Kraken asset id "${krakenAsset.slice(0, 20)}"`, false);
    }
    const bucket = BUCKET_SUFFIX.exec(id);
    const baseId = bucket ? bucket[1]! : id;
    const altname = this.altnames.get(baseId) ?? LEGACY_IDS[baseId] ?? baseId;
    return CANONICAL_OVERRIDES[altname] ?? altname;
  }

  /** Base and quote (canonical) of a Kraken pair name such as XXBTZUSD, ADAUSD or XETHXXBT. */
  resolvePair(pair: string): ResolvedPair {
    const known = this.pairs.get(pair);
    if (known) return { base: this.canonicalAsset(known.base), quote: this.canonicalAsset(known.quote) };
    const split = this.uniqueSplit(pair);
    if (split) return split;
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
  private uniqueSplit(pair: string): ResolvedPair | null {
    const known = new Set<string>([...this.altnames.keys(), ...this.altnames.values(), ...Object.keys(LEGACY_IDS)]);
    const candidates: ResolvedPair[] = [];
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
}
