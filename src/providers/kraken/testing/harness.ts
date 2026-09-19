import { createKeyContext, KrakenClient } from "../client";
import { KrakenProvider } from "../provider";
import type { KrakenTier } from "../types";
import { FakeKraken } from "./fake-kraken";

/** Kraken-style seconds string for an ISO time, with optional 4-digit fraction. */
export function ks(iso: string, fraction = "0000"): string {
  return `${Math.floor(Date.parse(iso) / 1000)}.${fraction}`;
}

/**
 * A real KrakenClient + KrakenProvider talking to a FakeKraken, with a
 * simulated clock: rate-limit waits and retry backoffs advance time instantly.
 */
export function krakenHarness(options: {
  fake?: FakeKraken;
  accountId?: string;
  startIso?: string;
  tier?: KrakenTier;
  maxAttempts?: number;
  secret?: string;
  apiKey?: string;
} = {}) {
  const fake = options.fake ?? new FakeKraken();
  let nowMs = Date.parse(options.startIso ?? "2026-09-24T12:00:00Z");
  let slept = 0;
  const clock = {
    now: () => nowMs,
    sleep: async (ms: number) => {
      slept += ms;
      nowMs += ms;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    set: (iso: string) => {
      nowMs = Date.parse(iso);
    },
    get sleptMs() {
      return slept;
    },
  };
  const context = createKeyContext({ tier: options.tier ?? "pro", now: clock.now, sleep: clock.sleep });
  const client = new KrakenClient({
    credentials: { apiKey: options.apiKey ?? fake.apiKey, apiSecret: options.secret ?? fake.apiSecret },
    fetch: fake.fetch,
    context,
    now: clock.now,
    sleep: clock.sleep,
    maxAttempts: options.maxAttempts,
  });
  const provider = new KrakenProvider(options.accountId ?? "acct-kraken", client, () => new Date(clock.now()));
  return { fake, client, provider, clock };
}
