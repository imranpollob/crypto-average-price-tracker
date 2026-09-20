import { createHash } from "node:crypto";
import { ProviderError } from "../types";
import { createSigner, NonceGenerator, type Signer } from "./auth";
import { krakenError, throttledUntilMs } from "./errors";
import { parseJsonLossless } from "./json";
import { CallCounterLimiter, callCost, DEFAULT_KRAKEN_TIER, type RateLimitPolicy } from "./rate-limiter";
import type { KrakenCredentials, KrakenTier } from "./types";

export const KRAKEN_BASE_URL = "https://api.kraken.com";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

/**
 * State shared by every client using the same API key within this process:
 * the nonce sequence, the call-counter model, and a queue that keeps private
 * requests strictly sequential (so nonces reach Kraken in increasing order).
 */
export interface KrakenKeyContext {
  readonly nonce: NonceGenerator;
  readonly limiter: RateLimitPolicy;
  queue: Promise<unknown>;
}

export function createKeyContext(options: {
  tier?: KrakenTier;
  /** Custom policy (e.g. adaptive); overrides `tier`. */
  limiter?: RateLimitPolicy;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} = {}): KrakenKeyContext {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  return {
    nonce: new NonceGenerator(),
    limiter: options.limiter ?? new CallCounterLimiter(options.tier ?? DEFAULT_KRAKEN_TIER, now, sleep),
    queue: Promise.resolve(),
  };
}

const sharedContexts = new Map<string, KrakenKeyContext>();

/** Process-wide context for an API key (keyed by a hash — the key itself is not retained). */
export function sharedKeyContext(apiKey: string, tier: KrakenTier = DEFAULT_KRAKEN_TIER): KrakenKeyContext {
  const id = createHash("sha256").update(apiKey).digest("hex");
  let ctx = sharedContexts.get(id);
  if (!ctx) {
    ctx = createKeyContext({ tier });
    sharedContexts.set(id, ctx);
  }
  return ctx;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface KrakenClientOptions {
  /** Omit for a public-only client (market data); private calls then fail. */
  readonly credentials?: KrakenCredentials;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly context?: KrakenKeyContext;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Attempts per call for retryable failures (default 4). */
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

type Params = Readonly<Record<string, string | number | boolean | undefined>>;

function encodeForm(params: Params): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) usp.append(k, String(v));
  }
  return usp.toString();
}

/**
 * Minimal Kraken REST client. Read-only by construction: it only exposes
 * generic GET/POST, and the adapter only calls read endpoints.
 */
export class KrakenClient {
  private readonly apiKey: string;
  private readonly sign: Signer | null;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly context: KrakenKeyContext;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;

  constructor(options: KrakenClientOptions) {
    this.apiKey = options.credentials?.apiKey.trim() ?? "";
    this.sign = options.credentials ? createSigner(options.credentials.apiSecret) : null;
    this.baseUrl = options.baseUrl ?? KRAKEN_BASE_URL;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.context = options.context ?? (options.credentials ? sharedKeyContext(this.apiKey) : createKeyContext());
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.signal = options.signal;
  }

  /** Never reveal credentials through logging or serialization. */
  toJSON(): string {
    return "[KrakenClient]";
  }

  async publicGet<T>(method: string, params: Params = {}): Promise<T> {
    const query = encodeForm(params);
    const url = `${this.baseUrl}/0/public/${method}${query ? `?${query}` : ""}`;
    return this.withRetries(method, () => this.send(method, url, { method: "GET", headers: {} }));
  }

  /** Signed POST to /0/private/<method>; its call-counter cost comes from KRAKEN_CALL_COST. */
  privatePost<T>(method: string, params: Params = {}): Promise<T> {
    const sign = this.sign;
    if (!sign) return Promise.reject(new ProviderError("invalid_credentials", `Kraken ${method} requires API credentials`, false));
    const cost = callCost(method);
    // Serialize per key: nonces must reach Kraken in increasing order.
    const run = this.context.queue.then(() =>
      this.withRetries(method, async () => {
        await this.context.limiter.acquire(cost);
        const path = `/0/private/${method}`;
        const nonce = this.context.nonce.next(this.now());
        const body = encodeForm({ nonce, ...params });
        return this.send<T>(method, `${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            "API-Key": this.apiKey,
            "API-Sign": sign(path, nonce, body),
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          },
          body,
        });
      }),
    );
    this.context.queue = run.catch(() => undefined);
    return run;
  }

  private async withRetries<T>(method: string, attempt: () => Promise<T>): Promise<T> {
    let nonceRetried = false;
    for (let i = 1; ; i++) {
      try {
        return await attempt();
      } catch (error) {
        const pe = error instanceof ProviderError ? error : new ProviderError("unknown", "Unexpected client error", false);
        const isNonce = pe.code === "invalid_request" && pe.retryable;
        if (isNonce) {
          if (nonceRetried) throw pe;
          nonceRetried = true;
          continue;
        }
        if (!pe.retryable || i >= this.maxAttempts) throw pe;
        if (pe.code === "rate_limited") this.context.limiter.penalize();
        const wait = (error as { retryAfterMs?: number }).retryAfterMs ?? Math.min(30_000, 1000 * 2 ** (i - 1));
        await this.sleep(wait);
      }
    }
  }

  private async send<T>(
    method: string,
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<T> {
    const signals = [AbortSignal.timeout(this.timeoutMs), ...(this.signal ? [this.signal] : [])];
    let res: { status: number; text(): Promise<string> };
    let text: string;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.any(signals) });
      text = await res.text();
    } catch {
      if (this.signal?.aborted) throw new ProviderError("network", `Request to Kraken ${method} was cancelled`, false);
      throw new ProviderError("network", `Network error while calling Kraken ${method}`);
    }
    if (res.status >= 500) {
      throw new ProviderError("provider_unavailable", `Kraken ${method} returned HTTP ${res.status}`);
    }

    let parsed: unknown;
    try {
      parsed = parseJsonLossless(text);
    } catch {
      throw new ProviderError("invalid_response", `Kraken ${method} returned a non-JSON response (HTTP ${res.status})`, false);
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { error?: unknown }).error)) {
      throw new ProviderError("invalid_response", `Kraken ${method} returned an unexpected response shape`, false);
    }
    const envelope = parsed as { error: unknown[]; result?: unknown };
    const errors = envelope.error.filter((e): e is string => typeof e === "string");
    if (errors.some((e) => e.startsWith("E"))) {
      const err = krakenError(errors, method);
      const wait = throttledUntilMs(errors, this.now());
      if (wait !== null) Object.assign(err, { retryAfterMs: wait });
      throw err;
    }
    if (res.status >= 400) {
      throw new ProviderError("invalid_response", `Kraken ${method} returned HTTP ${res.status}`, false);
    }
    if (envelope.result === undefined || envelope.result === null || typeof envelope.result !== "object") {
      throw new ProviderError("invalid_response", `Kraken ${method} returned no result`, false);
    }
    return envelope.result as T;
  }
}
