import { expect } from "vitest";
import { dec } from "@/domain/decimal";
import type { IncompleteReason, Metric } from "@/domain/metric";

/**
 * Exact decimal assertions. Values are compared with Decimal.equals — never
 * with floating-point tolerance.
 */
export function expectKnown(metric: Metric, expected: string): void {
  expect(metric.status, `expected known ${expected}, got ${JSON.stringify(metric)}`).toBe("known");
  if (metric.status !== "known") return;
  expect(
    metric.value.equals(dec(expected)),
    `expected ${expected}, got ${metric.value.toFixed()}`,
  ).toBe(true);
}

export function expectIncomplete(metric: Metric, ...reasons: IncompleteReason[]): void {
  expect(metric.status).toBe("incomplete");
  if (metric.status !== "incomplete") return;
  for (const r of reasons) expect(metric.reasons).toContain(r);
}

export function expectNotApplicable(metric: Metric): void {
  expect(metric.status).toBe("not_applicable");
}

export function expectDecimal(actual: { equals(x: unknown): boolean; toFixed(): string } | null, expected: string): void {
  expect(actual, `expected ${expected}, got null`).not.toBeNull();
  expect(actual!.equals(dec(expected)), `expected ${expected}, got ${actual!.toFixed()}`).toBe(true);
}
