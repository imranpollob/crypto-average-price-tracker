import { describe, expect, it } from "vitest";
import { Decimal, dec, min, ZERO } from "@/domain/decimal";
import { economicTotalPnl } from "@/domain/pnl/position";
import type { NormalizedTrade } from "@/domain/transactions/types";
import { buy, day, match, scenario, sell } from "@/test/builders";
import { expectKnown } from "@/test/expect-metric";
import type { LotMatchInstruction } from "@/domain/lots/types";

/**
 * #38 Economic total-P/L invariant (spec §15).
 *
 * Lot assignment may move P/L between realized and unrealized, and change the
 * remaining average cost and cost basis — but never the total, for the same
 * history and the same current price. All comparisons are exact.
 */

describe("#38 total P/L is independent of lot matching", () => {
  it("spec example: every possible assignment of the $13 sale gives total −$400", () => {
    const b20 = buy("100", "20");
    const b10 = buy("100", "10");
    const x = sell("100", "13");
    const assignments = [
      [match(x, b10, "100")],
      [match(x, b20, "100")],
      [match(x, b20, "50"), match(x, b10, "50")],
      [match(x, b20, "1"), match(x, b10, "99")],
      [match(x, b20, "33.333333333333"), match(x, b10, "66.666666666667")],
    ];
    const results = assignments.map((matches) => scenario({ trades: [b20, b10, x], matches }).position("ADA", "13"));
    for (const p of results) expectKnown(p.totalPnl, "-400");
    // …while realized/unrealized genuinely differ between assignments.
    const realized = results.map((p) => (p.realizedPnl.status === "known" ? p.realizedPnl.value.toFixed() : "?"));
    expect(new Set(realized).size).toBe(assignments.length);
  });

  it("matched total equals the matching-independent economic formula", () => {
    const b20 = buy("100", "20", { fee: "3" });
    const b10 = buy("100", "10", { fee: "1.5" });
    const x = sell("150", "13", { fee: "2.25" });
    const s = scenario({ trades: [b20, b10, x], matches: [match(x, b10, "100"), match(x, b20, "50")] });
    const p = s.position("ADA", "13");
    expect(p.totalPnl.status).toBe("known");
    const eco = economicTotalPnl(s.engine, "ADA", p.currentValue);
    expect(eco.status).toBe("known");
    if (p.totalPnl.status === "known" && eco.status === "known") {
      expect(p.totalPnl.value.equals(eco.value)).toBe(true);
    }
  });

  it("property: random histories, fees and assignments — total never changes (exact)", () => {
    const rand = mulberry32(0xc0ffee);
    let checkedHistories = 0;

    for (let h = 0; h < 250; h++) {
      const { trades, sells } = randomHistory(rand);
      if (sells.length === 0) continue;
      const price = randomDecimal(rand, 1, 10_000_000, 6);

      const totals: Decimal[] = [];
      for (let variant = 0; variant < 4; variant++) {
        const matches = randomMatching(rand, trades);
        const s = scenario({ trades, matches });
        const p = s.position("ADA", price.toFixed());
        expect(p.reviewRequired, `history ${h} variant ${variant}`).toBe(false);
        expect(p.totalPnl.status).toBe("known");
        expect(p.realizedPnl.status).toBe("known");
        expect(p.unrealizedPnl.status).toBe("known");
        if (p.totalPnl.status !== "known" || p.realizedPnl.status !== "known" || p.unrealizedPnl.status !== "known") {
          continue;
        }
        // realized + unrealized = economic total, exactly
        const eco = economicTotalPnl(s.engine, "ADA", p.currentValue);
        expect(eco.status === "known" && eco.value.equals(p.totalPnl.value)).toBe(true);
        // cost conservation, exactly
        const lotCost = s.engine.lots.reduce((acc, l) => acc.plus(l.acquisitionCost!), ZERO);
        const allocated = s.engine.allocations.reduce((acc, a) => acc.plus(a.allocatedAcquisitionCost!), ZERO);
        const remaining = s.engine.lots.reduce((acc, l) => acc.plus(l.remainingCost!), ZERO);
        expect(allocated.plus(remaining).equals(lotCost)).toBe(true);

        totals.push(p.totalPnl.value);
      }
      for (const t of totals) {
        expect(t.equals(totals[0]!), `history ${h}: ${t.toFixed()} ≠ ${totals[0]!.toFixed()}`).toBe(true);
      }
      checkedHistories++;
    }
    expect(checkedHistories).toBeGreaterThan(200);
  });
});

// --- deterministic random generation ----------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rand: () => number, lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

/** Random decimal: an integer in [lo, hi] scaled down by up to `maxScale` digits. Built from strings. */
function randomDecimal(rand: () => number, lo: number, hi: number, maxScale: number): Decimal {
  const scale = randInt(rand, 0, maxScale);
  return dec(String(randInt(rand, lo, hi))).dividedBy(dec(`1e${scale}`));
}

function randomHistory(rand: () => number): { trades: NormalizedTrade[]; sells: NormalizedTrade[] } {
  const trades: NormalizedTrade[] = [];
  const sells: NormalizedTrade[] = [];
  let holdings = ZERO;
  const events = randInt(rand, 2, 12);
  for (let i = 0; i < events; i++) {
    const at = day(i + 1);
    const fee = rand() < 0.5 ? undefined : dec(String(randInt(rand, 1, 5000))).dividedBy(100).toFixed();
    if (holdings.isZero() || rand() < 0.55) {
      const qty = randomDecimal(rand, 1, 1_000_000, 8);
      const px = randomDecimal(rand, 1, 10_000_000, 6);
      trades.push(buy(qty.toFixed(), px.toFixed(), { at, fee }));
      holdings = holdings.plus(qty);
    } else {
      const fraction = dec(String(randInt(rand, 1, 1000))).dividedBy(1000);
      const qty = holdings.times(fraction).toDecimalPlaces(8, Decimal.ROUND_DOWN);
      if (qty.isZero()) continue;
      const px = randomDecimal(rand, 1, 10_000_000, 6);
      const t = sell(qty.toFixed(), px.toFixed(), { at, fee });
      trades.push(t);
      sells.push(t);
      holdings = holdings.minus(qty);
    }
  }
  return { trades, sells };
}

/** A random but valid complete assignment of every sell to earlier lots. */
function randomMatching(rand: () => number, trades: NormalizedTrade[]): LotMatchInstruction[] {
  const remaining = new Map<NormalizedTrade, Decimal>();
  const matches: LotMatchInstruction[] = [];
  let n = 0;
  for (const t of trades) {
    if (t.side === "buy") {
      remaining.set(t, t.quantity);
      continue;
    }
    let left = t.quantity;
    const open = [...remaining.entries()].filter(([, q]) => q.greaterThan(0));
    shuffle(rand, open);
    for (const [lot, avail] of open) {
      if (left.isZero()) break;
      // take a random chunk, or everything available
      const chunk = rand() < 0.5 ? avail : avail.times(dec(String(randInt(rand, 1, 999))).dividedBy(1000)).toDecimalPlaces(8, Decimal.ROUND_DOWN);
      const take = min(min(chunk, avail), left);
      if (take.isZero()) continue;
      matches.push(match(t, lot, take.toFixed(), `m${String(++n).padStart(4, "0")}`));
      remaining.set(lot, avail.minus(take));
      left = left.minus(take);
    }
    // any rounding leftover: sweep through lots in order
    for (const [lot] of open) {
      if (left.isZero()) break;
      const avail = remaining.get(lot)!;
      const take = min(avail, left);
      if (take.isZero()) continue;
      matches.push(match(t, lot, take.toFixed(), `m${String(++n).padStart(4, "0")}`));
      remaining.set(lot, avail.minus(take));
      left = left.minus(take);
    }
    if (!left.isZero()) throw new Error("generator produced an unmatchable sell");
  }
  return matches;
}

function shuffle<T>(rand: () => number, items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}
