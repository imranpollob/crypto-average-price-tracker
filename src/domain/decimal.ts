import DecimalJs from "decimal.js";

/**
 * Decimal-safe arithmetic for every financial value in the app.
 *
 * A dedicated Decimal constructor is cloned so global decimal.js settings
 * elsewhere can never change accounting behaviour.
 *
 * Exactness strategy:
 *  - Exchange inputs carry at most ~18 fractional digits, so products such as
 *    quantity × price have at most ~36.
 *  - The only inexact operation is division (proportional allocation, averages).
 *    Allocation results are quantized to ALLOCATION_SCALE decimal places.
 *  - With 100 significant digits, every addition, subtraction and multiplication
 *    of such values is exact, so `allocated + remaining === original` holds with
 *    strict equality — no epsilon comparisons anywhere.
 *
 * JavaScript `number` is rejected for anything non-integer: floats must never
 * enter the calculation path.
 */
export const Decimal = DecimalJs.clone({
  precision: 100,
  rounding: DecimalJs.ROUND_HALF_EVEN,
  toExpNeg: -100,
  toExpPos: 100,
});
export type Decimal = DecimalJs;

export type DecimalInput = Decimal | string | bigint | number;

const DECIMAL_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export class InvalidDecimalError extends Error {
  constructor(input: unknown) {
    super(`Invalid decimal value: ${JSON.stringify(String(input))}`);
    this.name = "InvalidDecimalError";
  }
}

/**
 * Strictly parse a decimal. Accepts decimal strings, bigints, existing Decimals
 * and *safe integers* only. Throws on NaN, Infinity, empty strings, floats.
 */
export function dec(input: DecimalInput): Decimal {
  if (DecimalJs.isDecimal(input)) {
    const d = input as DecimalJs;
    if (!d.isFinite()) throw new InvalidDecimalError(input);
    // decimal.js clones share one prototype, so `instanceof` cannot tell them
    // apart; each instance records its own constructor (and thus precision).
    return d.constructor === Decimal ? d : new Decimal(d.toString());
  }
  if (typeof input === "bigint") return new Decimal(input.toString());
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input)) {
      throw new InvalidDecimalError(input);
    }
    return new Decimal(input);
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!DECIMAL_PATTERN.test(trimmed)) throw new InvalidDecimalError(input);
    return new Decimal(trimmed);
  }
  throw new InvalidDecimalError(input);
}

/** Parse a value that may legitimately be absent. */
export function decOrNull(input: DecimalInput | null | undefined): Decimal | null {
  return input === null || input === undefined ? null : dec(input);
}

export const ZERO: Decimal = new Decimal(0);
export const ONE_HUNDRED: Decimal = new Decimal(100);

export function sum(values: Iterable<Decimal>): Decimal {
  let total = ZERO;
  for (const v of values) total = total.plus(v);
  return total;
}

/** Fractional digits kept for results of proportional allocation. */
export const ALLOCATION_SCALE = 36;

/**
 * `amount × part / whole`, quantized to ALLOCATION_SCALE. When `part === whole`
 * the full amount is returned untouched, so a final allocation always takes the
 * exact remainder and nothing is ever lost to rounding.
 */
export function allocateProportionally(amount: Decimal, part: Decimal, whole: Decimal): Decimal {
  if (whole.isZero()) throw new Error("Cannot allocate against a zero quantity");
  if (part.equals(whole)) return amount;
  return amount.times(part).dividedBy(whole).toDecimalPlaces(ALLOCATION_SCALE, Decimal.ROUND_HALF_EVEN);
}

export function min(a: Decimal, b: Decimal): Decimal {
  return a.lessThanOrEqualTo(b) ? a : b;
}

/**
 * Canonical storage form: plain notation, full precision, no exponent,
 * normalised "-0" to "0". Safe to round-trip through SQLite TEXT columns.
 */
export function toStorageString(value: Decimal): string {
  if (value.isZero()) return "0";
  return value.toFixed();
}

export function fromStorageString(value: string): Decimal {
  return dec(value);
}
