import DecimalJs from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  allocateProportionally,
  dec,
  fromStorageString,
  InvalidDecimalError,
  sum,
  toStorageString,
  ZERO,
} from "@/domain/decimal";
import { buy, match, scenario, sell } from "@/test/builders";
import { expectDecimal, expectKnown } from "@/test/expect-metric";

describe("decimal parsing is strict", () => {
  it.each(["", " ", "abc", "1,000", "NaN", "Infinity", "1.2.3", "0x10"])("rejects %j", (v) => {
    expect(() => dec(v)).toThrow(InvalidDecimalError);
  });

  it("rejects non-integer JavaScript numbers (no floats in the calculation path)", () => {
    expect(() => dec(0.1)).toThrow(InvalidDecimalError);
    expect(() => dec(Number.MAX_SAFE_INTEGER + 2)).toThrow(InvalidDecimalError);
    expect(dec(42).toFixed()).toBe("42");
  });

  it("accepts decimal strings, exponents and bigints", () => {
    expect(dec("0.00000001").toFixed()).toBe("0.00000001");
    expect(dec("1e-18").toFixed()).toBe("0.000000000000000001");
    expect(dec(12345678901234567890n).toFixed()).toBe("12345678901234567890");
  });

  it("re-hosts Decimals from other decimal.js configurations", () => {
    const foreign = new (DecimalJs.clone({ precision: 5 }))("1.23456789");
    const d = dec(foreign);
    expect(d.plus("0").toFixed()).toBe("1.23456789");
  });

  it("0.1 + 0.2 is exactly 0.3", () => {
    expect(dec("0.1").plus(dec("0.2")).equals(dec("0.3"))).toBe(true);
  });
});

describe("storage format", () => {
  it("round-trips without exponent or precision loss", () => {
    for (const v of ["0", "-0", "0.000000000000000001", "123456789012345678901234567890.123456789012345678", "-42.5"]) {
      const stored = toStorageString(dec(v));
      expect(stored).not.toMatch(/e/i);
      expect(fromStorageString(stored).equals(dec(v))).toBe(true);
    }
    expect(toStorageString(dec("-0"))).toBe("0");
  });
});

describe("proportional allocation", () => {
  it("returns the exact remainder when allocating everything", () => {
    const amount = dec("100").dividedBy(3);
    expect(allocateProportionally(amount, dec("7"), dec("7"))).toBe(amount);
  });

  it("refuses to allocate against zero", () => {
    expect(() => allocateProportionally(dec("1"), ZERO, ZERO)).toThrow();
  });

  it("sum() of nothing is zero", () => {
    expect(sum([]).isZero()).toBe(true);
  });
});

describe("#32 tiny crypto quantities", () => {
  it("1 satoshi bought and valued exactly", () => {
    const p = scenario({
      trades: [buy("0.00000001", "65000.12", { base: "BTC", fee: "0.00000026" })],
    }).position("BTC", "70000");
    expectKnown(p.costBasis, "0.0006502612"); // 0.0006500012 + 0.00000026 fee
    expectKnown(p.currentValue, "0.0007");
    expectKnown(p.unrealizedPnl, "0.0000497388");
  });

  it("dust amounts survive partial sells", () => {
    const b = buy("0.00000003", "60000", { base: "BTC" }); // cost 0.0018
    const x = sell("0.00000001", "70000", { base: "BTC" });
    const p = scenario({ trades: [b, x], matches: [match(x, b, "0.00000001")] }).position("BTC", "70000");
    expectKnown(p.realizedPnl, "0.0001"); // 0.0007 − 0.0006
    expectKnown(p.costBasis, "0.0012");
    expectDecimal(p.holdings, "0.00000002");
  });
});

describe("#33 high-precision prices", () => {
  it("meme-coin price with 18 decimals", () => {
    const p = scenario({
      trades: [buy("123456789.123456789", "0.000012345678901234", { base: "SHIB" })],
    }).position("SHIB", "0.000012345678901235");
    // cost = 123456789.123456789 × 0.000012345678901234
    expectKnown(p.costBasis, "1524.157876695555652797397777626");
    expectKnown(p.averageCost, "0.000012345678901234");
    // unrealized = qty × 1e-18
    expectKnown(p.unrealizedPnl, "0.000000000123456789123456789");
  });
});

describe("#34 very large balances", () => {
  it("trillions of units, exact partial allocation", () => {
    const b = buy("987654321987.654321", "0.00001234", { base: "PEPE", fee: "12.34" });
    const x1 = sell("329218107329.218107", "0.00002", { base: "PEPE" });
    const x2 = sell("658436214658.436214", "0.00002", { base: "PEPE" });
    const s = scenario({
      trades: [b, x1, x2],
      matches: [match(x1, b, "329218107329.218107"), match(x2, b, "658436214658.436214")],
    });
    const lot = s.engine.lots[0]!;
    // 987654321987.654321 × 0.00001234 + 12.34
    expectDecimal(lot.acquisitionCost, "12187666.67332765432114");
    expectDecimal(lot.remainingQuantity, "0");
    expectDecimal(lot.remainingCost, "0");
    const allocated = s.engine.allocations.reduce((a, m) => a.plus(m.allocatedAcquisitionCost!), ZERO);
    expectDecimal(allocated, "12187666.67332765432114");
    const p = s.position("PEPE", "0.00002");
    // proceeds 987654321987.654321 × 0.00002 = 19753086.43975308642
    expectKnown(p.realizedPnl, "7565419.76642543209886");
  });
});
