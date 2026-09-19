import { createHash, createHmac, randomBytes } from "node:crypto";
import { dec, ZERO, type Decimal } from "@/domain/decimal";
import type { FetchLike } from "../client";
import type { KrakenAssetInfo, KrakenAssetPair, KrakenLedgerRow, KrakenTradeRow } from "../types";

/**
 * An in-process fake of Kraken's REST API for tests, modeled on the documented
 * behaviour (docs/kraken-api-notes.md):
 *  - verifies API-Key, API-Sign (HMAC-SHA512) and strictly increasing nonces
 *  - enforces per-endpoint permissions
 *  - paginates newest-first with start exclusive / end inclusive, `ofs`,
 *    TradesHistory `limit` (≤ 100, default 50) and Ledgers pages of 50
 *  - serializes `time` and `count` as JSON numbers, amounts as strings
 *  - generates the two ledger lines of every trade (refid = trade txid)
 *  - can inject errors, network failures and HTTP failures per endpoint
 * Contains no real data.
 */

type Method = "Balance" | "TradesHistory" | "Ledgers" | "GetApiKeyInfo" | "Assets" | "AssetPairs";

/** Permission each private endpoint needs (GetApiKeyInfo needs none). */
const ENDPOINT_PERMISSION: Partial<Record<Method, string>> = {
  Balance: "query-funds",
  TradesHistory: "query-closed-trades",
  Ledgers: "query-ledger",
};

export const FAKE_IBAN = "AA88 N84G WOAK NMOI";

export interface FakeTradeInput {
  readonly txid: string;
  readonly pair: string;
  readonly type: "buy" | "sell";
  readonly vol: string;
  readonly price: string;
  readonly fee?: string;
  /**
   * Which asset Kraken actually charges the fee in (ledger); TradesHistory always reports quote.
   * "kfee": covered by fee credits (1 KFEE = 0.01 USD), shown on a KFEE ledger line with the trade refid.
   */
  readonly feeIn?: "quote" | "base" | "kfee";
  /** For feeIn "kfee": credit usage as a negative amount (default) or in the fee field. */
  readonly kfeeAs?: "amount" | "fee";
  readonly time: string;
  readonly ordertxid?: string;
  readonly margin?: string;
  /** Omit ledger lines (e.g. to simulate missing ledger evidence). */
  readonly withoutLedger?: boolean;
}

type Failure = {
  method: Method;
  remaining: number;
  kind: { error: string } | "network" | "http500" | "garbage";
  /** Only fail calls with this `ofs` (pagination). */
  ofs?: number;
};

const DEFAULT_ASSETS: Record<string, KrakenAssetInfo> = {
  XXBT: { aclass: "currency", altname: "XBT" },
  XETH: { aclass: "currency", altname: "ETH" },
  XXDG: { aclass: "currency", altname: "XDG" },
  ZUSD: { aclass: "currency", altname: "USD" },
  ZEUR: { aclass: "currency", altname: "EUR" },
  ADA: { aclass: "currency", altname: "ADA" },
  DOT: { aclass: "currency", altname: "DOT" },
  USDT: { aclass: "currency", altname: "USDT" },
  USDC: { aclass: "currency", altname: "USDC" },
  XTZ: { aclass: "currency", altname: "XTZ" },
  KFEE: { aclass: "currency", altname: "FEE" },
  ETH2: { aclass: "currency", altname: "ETH2" },
};

const DEFAULT_PAIRS: Record<string, KrakenAssetPair> = {
  XXBTZUSD: { altname: "XBTUSD", wsname: "XBT/USD", base: "XXBT", quote: "ZUSD" },
  XETHZUSD: { altname: "ETHUSD", wsname: "ETH/USD", base: "XETH", quote: "ZUSD" },
  XETHXXBT: { altname: "ETHXBT", wsname: "ETH/XBT", base: "XETH", quote: "XXBT" },
  ADAUSD: { altname: "ADAUSD", wsname: "ADA/USD", base: "ADA", quote: "ZUSD" },
  ADAEUR: { altname: "ADAEUR", wsname: "ADA/EUR", base: "ADA", quote: "ZEUR" },
  ADAUSDT: { altname: "ADAUSDT", wsname: "ADA/USDT", base: "ADA", quote: "USDT" },
  USDCUSD: { altname: "USDCUSD", wsname: "USDC/USD", base: "USDC", quote: "ZUSD" },
  DOTUSD: { altname: "DOTUSD", wsname: "DOT/USD", base: "DOT", quote: "ZUSD" },
};

export class FakeKraken {
  readonly apiKey = "fake-api-key-for-tests";
  readonly apiSecret = randomBytes(64).toString("base64");

  assets: Record<string, KrakenAssetInfo> = { ...DEFAULT_ASSETS };
  pairs: Record<string, KrakenAssetPair> = { ...DEFAULT_PAIRS };
  readonly trades = new Map<string, KrakenTradeRow>();
  readonly ledger = new Map<string, KrakenLedgerRow>();
  /** Replace the ledger-derived balances (e.g. to create a mismatch). */
  balanceOverride: Record<string, string> | null = null;
  /** Documented permission strings granted to the key (GetApiKeyInfo). */
  keyPermissions = new Set<string>(["query-funds", "query-closed-trades", "query-ledger"]);
  /** Extra GetApiKeyInfo fields (e.g. queryFrom, validUntil). */
  keyInfoOverrides: Record<string, unknown> = {};
  /** Simulate an account/API version without GetApiKeyInfo. */
  supportsKeyInfo = true;
  readonly requests: Array<{ method: Method; params: Record<string, string> }> = [];
  /** Called before each private request is answered (e.g. to add late rows). */
  beforeResponse: ((method: Method, params: Record<string, string>, callIndex: number) => void) | null = null;

  /** Server-side call-counter enforcement (Kraken's documented model), when configured. */
  rateLimit: { max: number; decayPerSecond: number; now: () => number } | null = null;
  rateLimitErrors = 0;
  private counter = 0;
  private counterAt = 0;

  private readonly failures: Failure[] = [];
  private lastNonce = 0n;
  private ledgerSeq = 0;

  // --- data setup -----------------------------------------------------------

  addTrade(t: FakeTradeInput): this {
    const vol = dec(t.vol);
    const price = dec(t.price);
    const cost = vol.times(price);
    const fee = dec(t.fee ?? "0");
    this.trades.set(t.txid, {
      ordertxid: t.ordertxid ?? `O${t.txid}`,
      postxid: "TKH2SE-M7IF5-CFI7LT",
      pair: t.pair,
      time: t.time,
      type: t.type,
      ordertype: "limit",
      price: price.toFixed(),
      cost: cost.toFixed(),
      fee: (t.feeIn === "base" ? fee.times(price) : fee).toFixed(),
      vol: vol.toFixed(),
      margin: t.margin ?? "0.00000",
      misc: "",
      trade_id: String(this.trades.size + 1),
      maker: false,
    });
    if (t.withoutLedger) return this;

    const p = this.pairs[t.pair];
    if (!p) throw new Error(`Fake: unknown pair ${t.pair}`);
    const sign = t.type === "buy" ? 1 : -1;
    const baseAmount = sign === 1 ? vol : vol.negated();
    const quoteAmount = sign === 1 ? cost.negated() : cost;
    const baseFee = t.feeIn === "base" ? fee : ZERO;
    const quoteFee = t.feeIn === "base" || t.feeIn === "kfee" ? ZERO : fee;
    if (t.feeIn === "kfee") {
      const credits = fee.times(100).toFixed();
      this.addLedgerRow(
        t.kfeeAs === "fee"
          ? { refid: t.txid, time: t.time, type: "trade", asset: "KFEE", amount: "0", fee: credits }
          : { refid: t.txid, time: t.time, type: "trade", asset: "KFEE", amount: `-${credits}` },
        `L${t.txid}-K`,
      );
    }
    this.addLedgerRow({ refid: t.txid, time: t.time, type: "trade", asset: p.base, amount: baseAmount.toFixed(), fee: baseFee.toFixed() }, `L${t.txid}-B`);
    this.addLedgerRow({ refid: t.txid, time: t.time, type: "trade", asset: p.quote, amount: quoteAmount.toFixed(), fee: quoteFee.toFixed() }, `L${t.txid}-Q`);
    return this;
  }

  addLedgerRow(
    row: { refid?: string; time: string; type: string; subtype?: string; asset: string; amount: string; fee?: string },
    id = `L${String(++this.ledgerSeq).padStart(6, "0")}-FAKE`,
  ): this {
    this.ledger.set(id, {
      refid: row.refid ?? `R${id}`,
      time: row.time,
      type: row.type,
      subtype: row.subtype ?? "",
      aclass: "currency",
      asset: row.asset,
      amount: row.amount,
      fee: row.fee ?? "0",
      balance: "0",
    });
    return this;
  }

  /** A Buy Crypto / Kraken app transaction: a spend and a receive line sharing a refid. */
  addInstant(i: {
    refid: string;
    time: string;
    spend: { asset: string; amount: string; fee?: string; id?: string };
    receive: { asset: string; amount: string; fee?: string; id?: string; time?: string };
  }): this {
    this.addLedgerRow({ refid: i.refid, time: i.time, type: "spend", asset: i.spend.asset, amount: i.spend.amount, fee: i.spend.fee }, i.spend.id ?? `L${i.refid}-S`);
    this.addLedgerRow({ refid: i.refid, time: i.receive.time ?? i.time, type: "receive", asset: i.receive.asset, amount: i.receive.amount, fee: i.receive.fee }, i.receive.id ?? `L${i.refid}-R`);
    return this;
  }

  /** Fail the next `times` calls of `method` (optionally only at a given offset). */
  fail(method: Method, kind: Failure["kind"], times = 1, ofs?: number): this {
    this.failures.push({ method, kind, remaining: times, ofs });
    return this;
  }

  callsTo(method: Method): number {
    return this.requests.filter((r) => r.method === method).length;
  }

  /** Balances implied by the ledger: Σ (amount − fee) per Kraken asset id. */
  ledgerBalances(): Record<string, string> {
    const totals = new Map<string, Decimal>();
    for (const row of this.ledger.values()) {
      const prev = totals.get(row.asset) ?? ZERO;
      totals.set(row.asset, prev.plus(dec(row.amount)).minus(dec(row.fee)));
    }
    return Object.fromEntries([...totals].map(([a, v]) => [a, v.toFixed(10)]));
  }

  // --- HTTP -----------------------------------------------------------------

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = u.pathname.split("/").pop() as Method;
    const isPrivate = u.pathname.startsWith("/0/private/");
    const params = Object.fromEntries(new URLSearchParams(isPrivate ? init.body ?? "" : u.search));
    this.requests.push({ method, params });

    const failure = this.failures.find(
      (f) => f.method === method && f.remaining > 0 && (f.ofs === undefined || String(f.ofs) === (params["ofs"] ?? "0")),
    );
    if (failure) {
      failure.remaining -= 1;
      if (failure.kind === "network") throw new TypeError("fetch failed");
      if (failure.kind === "http500") return respond(502, "<html>Bad gateway</html>");
      if (failure.kind === "garbage") return respond(200, "not json at all");
      return respond(200, JSON.stringify({ error: [failure.kind.error] }));
    }

    if (isPrivate) {
      const authError = this.authenticate(u.pathname, init.headers, init.body ?? "", params);
      if (authError) return respond(200, JSON.stringify({ error: [authError] }));
      const needs = ENDPOINT_PERMISSION[method];
      if (needs && !this.keyPermissions.has(needs)) return respond(200, JSON.stringify({ error: ["EGeneral:Permission denied"] }));
      if (this.rateLimit) {
        const { max, decayPerSecond, now } = this.rateLimit;
        const t = now();
        this.counter = Math.max(0, this.counter - ((t - this.counterAt) / 1000) * decayPerSecond);
        this.counterAt = t;
        const cost = method === "TradesHistory" || method === "Ledgers" ? 2 : 1;
        if (this.counter + cost > max) {
          this.rateLimitErrors++;
          return respond(200, JSON.stringify({ error: ["EAPI:Rate limit exceeded"] }));
        }
        this.counter += cost;
      }
      this.beforeResponse?.(method, params, this.callsTo(method));
    }

    switch (method) {
      case "Assets":
        return ok(this.assets);
      case "AssetPairs":
        return ok(this.pairs);
      case "GetApiKeyInfo":
        if (!this.supportsKeyInfo) return respond(200, JSON.stringify({ error: ["EGeneral:Unknown method"] }));
        return ok({
          apiKeyName: "read-only",
          apiKey: this.apiKey,
          nonce: "1772627060997",
          nonceWindow: numberToken("0"),
          permissions: [...this.keyPermissions],
          iban: FAKE_IBAN,
          validUntil: "0",
          queryFrom: "0",
          queryTo: "0",
          createdTime: "1772542900",
          modifiedTime: "1772543095",
          ipAllowlist: [],
          lastUsed: null,
          ...this.keyInfoOverrides,
        });
      case "Balance":
        return ok(this.balanceOverride ?? this.ledgerBalances());
      case "TradesHistory": {
        const limit = Math.min(100, Math.max(1, Number(params["limit"] ?? "50")));
        const { rows, count } = page(this.trades, params, limit);
        return ok({ trades: Object.fromEntries(rows), count: numberToken(String(count)) });
      }
      case "Ledgers": {
        const { rows, count } = page(this.ledger, params, 50);
        return ok({ ledger: Object.fromEntries(rows), count: numberToken(String(count)) });
      }
      default:
        return respond(200, JSON.stringify({ error: ["EGeneral:Unknown method"] }));
    }
  };

  private authenticate(path: string, headers: Record<string, string>, body: string, params: Record<string, string>): string | null {
    if (headers["API-Key"] !== this.apiKey) return "EAPI:Invalid key";
    const nonce = params["nonce"] ?? "";
    const inner = createHash("sha256").update(nonce + body).digest();
    const expected = createHmac("sha512", Buffer.from(this.apiSecret, "base64"))
      .update(Buffer.concat([Buffer.from(path), inner]))
      .digest("base64");
    if (headers["API-Sign"] !== expected) return "EAPI:Invalid signature";
    if (!/^\d+$/.test(nonce) || BigInt(nonce) <= this.lastNonce) return "EAPI:Invalid nonce";
    this.lastNonce = BigInt(nonce);
    return null;
  }
}

// --- helpers -------------------------------------------------------------------

const NUMBER_TOKEN = "\u0000num:";
/** Mark a value to be emitted as a bare JSON number (like Kraken's time / count). */
const numberToken = (s: string) => `${NUMBER_TOKEN}${s}`;

function page<Row extends { time: string }>(
  source: Map<string, Row>,
  params: Record<string, string>,
  limit: number,
): { rows: Array<[string, Row]>; count: number } {
  const start = params["start"] !== undefined ? timeKey(params["start"]) : null;
  const end = params["end"] !== undefined ? timeKey(params["end"]) : null;
  const matching = [...source]
    .map(([id, r]) => ({ id, r, t: timeKey(r.time) }))
    .filter(({ t }) => (start === null || t > start) && (end === null || t <= end));
  // Newest first; ties broken by id for determinism.
  matching.sort((a, b) => (b.t > a.t ? 1 : b.t < a.t ? -1 : a.id < b.id ? 1 : -1));
  const ofs = Number(params["ofs"] ?? "0");
  const rows = matching.slice(ofs, ofs + limit).map(({ id, r }) => [id, { ...r, time: numberToken(r.time) }] as [string, Row]);
  return { rows, count: matching.length };
}

/** Exact integer key (ten-thousandths of a second) for Kraken's 4-decimal timestamps. */
function timeKey(s: string): bigint {
  const [int, frac = ""] = s.split(".");
  return BigInt(int!) * 10_000n + BigInt((frac + "0000").slice(0, 4));
}

function ok(result: unknown) {
  const json = JSON.stringify({ error: [], result }).replace(
    new RegExp(`"${NUMBER_TOKEN.replace("\u0000", "\\\\u0000")}([0-9.]+)"`, "g"),
    "$1",
  );
  return respond(200, json);
}

function respond(status: number, body: string) {
  return { status, text: async () => body };
}
