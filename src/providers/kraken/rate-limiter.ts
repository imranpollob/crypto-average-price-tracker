import type { KrakenTier } from "./types";

/**
 * Client-side rate limiting for Kraken's private REST "call counter": each call
 * adds its cost; the counter decays at a tier-dependent rate. We wait before a
 * call rather than trip the server limit.
 *
 * The client depends only on `RateLimitPolicy`, so a different tier, an
 * adaptive policy or external configuration can be plugged in later without
 * touching the client or the sync logic. V1 always uses the most conservative
 * documented tier (Starter): correctness over initial-sync speed.
 */

export interface RateLimitPolicy {
  /** Resolve once a call of this cost may be sent (and account for it). */
  acquire(cost: number): Promise<void>;
  /** The server reported a rate-limit error: back off as if the budget were exhausted. */
  penalize(): void;
}

export const KRAKEN_TIERS: Readonly<Record<KrakenTier, { max: number; decayPerSecond: number }>> = {
  starter: { max: 15, decayPerSecond: 0.33 },
  intermediate: { max: 20, decayPerSecond: 0.5 },
  pro: { max: 20, decayPerSecond: 1 },
};

/** Lowest documented tier; safe for every account. */
export const DEFAULT_KRAKEN_TIER: KrakenTier = "starter";

/** Documented counter cost per private endpoint (ledger/trade history: 2, others: 1). */
export const KRAKEN_CALL_COST: Readonly<Record<string, number>> = {
  TradesHistory: 2,
  Ledgers: 2,
  QueryLedgers: 2,
  QueryTrades: 2,
};

export function callCost(method: string): number {
  return KRAKEN_CALL_COST[method] ?? 1;
}

export class CallCounterLimiter implements RateLimitPolicy {
  private counter = 0;
  private updatedAt: number;

  constructor(
    private readonly tier: KrakenTier,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {
    this.updatedAt = now();
  }

  private decay(): void {
    const t = this.now();
    const { decayPerSecond } = KRAKEN_TIERS[this.tier];
    this.counter = Math.max(0, this.counter - ((t - this.updatedAt) / 1000) * decayPerSecond);
    this.updatedAt = t;
  }

  async acquire(cost: number): Promise<void> {
    const { max, decayPerSecond } = KRAKEN_TIERS[this.tier];
    this.decay();
    const excess = this.counter + cost - max;
    if (excess > 0) {
      await this.sleep(Math.ceil((excess / decayPerSecond) * 1000));
      this.decay();
    }
    this.counter += cost;
  }

  penalize(): void {
    this.decay();
    this.counter = KRAKEN_TIERS[this.tier].max;
  }
}
