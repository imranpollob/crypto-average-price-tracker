import { describe, expect, it } from "vitest";
import { createAccountingConfig } from "@/domain/accounting/config";
import { dec } from "@/domain/decimal";
import { holdingsByAccount, reconcileBalances } from "@/domain/reconciliation/reconcile";
import type { NormalizedBalance } from "@/domain/transactions/types";
import { ACCOUNT, buy, deposit, PROVIDER, scenario, sell } from "@/test/builders";
import { expectDecimal } from "@/test/expect-metric";

const config = createAccountingConfig("USD");

const balance = (asset: string, total: string, account = ACCOUNT): NormalizedBalance => ({
  provider: PROVIDER,
  providerAccountId: account,
  asset,
  total: dec(total),
  available: null,
  asOf: new Date("2026-09-24T00:00:00Z"),
  rawData: {},
});

// 10,000 bought, 1,750 sold → 8,250 ADA
const history = scenario({ trades: [buy("10000", "0.1"), sell("1750", "0.2")] });

describe("#28 balance reconciliation success", () => {
  it("calculated equals reported", () => {
    const report = reconcileBalances({
      calculated: holdingsByAccount(history.engine),
      reported: [balance("ADA", "8250"), balance("USD", "1234.56")],
      config,
    });
    expect(report.reconciled).toBe(true);
    expect(report.rows).toHaveLength(1); // cash (USD) is not lot-tracked
    expect(report.rows[0]!.status).toBe("reconciled");
    expectDecimal(report.rows[0]!.difference, "0");
  });

  it("reconciliation does not depend on lot matching (holdings come from history)", () => {
    // the sale above is unmatched, yet holdings are known
    expectDecimal(holdingsByAccount(history.engine)[0]!.quantity, "8250");
  });
});

describe("#29 balance mismatch", () => {
  it("reports the signed difference without touching history", () => {
    const tradesBefore = history.engine.lots.length;
    const report = reconcileBalances({
      calculated: holdingsByAccount(history.engine),
      reported: [balance("ADA", "9250")],
      config,
    });
    expect(report.reconciled).toBe(false);
    const row = report.mismatches[0]!;
    expectDecimal(row.calculated, "8250");
    expectDecimal(row.reported, "9250");
    expectDecimal(row.difference, "1000");
    expect(history.engine.lots.length).toBe(tradesBefore);
  });

  it("an asset missing on either side is a mismatch", () => {
    const report = reconcileBalances({
      calculated: holdingsByAccount(history.engine),
      reported: [balance("DOT", "3")],
      config,
    });
    expect(report.mismatches.map((r) => `${r.asset}:${r.difference.toFixed()}`)).toEqual(["ADA:-8250", "DOT:3"]);
  });

  it("a deposit explains a difference once imported", () => {
    const withDeposit = scenario({ trades: [buy("10000", "0.1"), sell("1750", "0.2")], transfers: [deposit("ADA", "1000")] });
    const report = reconcileBalances({
      calculated: holdingsByAccount(withDeposit.engine),
      reported: [balance("ADA", "9250")],
      config,
    });
    expect(report.reconciled).toBe(true);
  });

  it("supports an explicit dust tolerance, exact by default", () => {
    const calc = holdingsByAccount(history.engine);
    const reported = [balance("ADA", "8250.00000001")];
    expect(reconcileBalances({ calculated: calc, reported, config }).reconciled).toBe(false);
    expect(
      reconcileBalances({ calculated: calc, reported, config, tolerance: new Map([["ADA", dec("0.0000001")]]) }).reconciled,
    ).toBe(true);
  });

  it("reconciles per account", () => {
    const two = scenario({ trades: [buy("5", "1", { account: "a" }), buy("7", "1", { account: "b" })] });
    const report = reconcileBalances({
      calculated: holdingsByAccount(two.engine),
      reported: [balance("ADA", "5", "a"), balance("ADA", "5", "b")],
      config,
    });
    expect(report.mismatches.map((r) => r.providerAccountId)).toEqual(["b"]);
  });
});
