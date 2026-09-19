import { type AccountingConfig, isTracked } from "../accounting/config";
import { type Decimal, ZERO } from "../decimal";
import type { Acquisition, DataQualityFlag, Disposal, LotEngineResult } from "../lots/types";
import type { AssetCode, NormalizedBalance } from "../transactions/types";

/**
 * Compare holdings calculated from transaction history with the balances the
 * provider reports. Differences are surfaced, never "fixed" by editing history.
 */

export interface CalculatedHolding {
  readonly providerAccountId: string;
  readonly asset: AssetCode;
  readonly quantity: Decimal;
}

export type ReconciliationStatus = "reconciled" | "mismatch";

export interface ReconciliationRow {
  readonly providerAccountId: string;
  readonly asset: AssetCode;
  readonly calculated: Decimal;
  readonly reported: Decimal;
  /** reported − calculated: positive means the provider shows more than history explains. */
  readonly difference: Decimal;
  readonly status: ReconciliationStatus;
}

export interface ReconciliationReport {
  readonly rows: readonly ReconciliationRow[];
  readonly mismatches: readonly ReconciliationRow[];
  readonly reconciled: boolean;
}

type Movement = { readonly providerAccountId: string; readonly asset: AssetCode; readonly quantity: Decimal };

function netHoldings(inflows: readonly Movement[], outflows: readonly Movement[]): CalculatedHolding[] {
  const totals = new Map<string, CalculatedHolding>();
  const add = (m: Movement, delta: Decimal) => {
    const k = `${m.providerAccountId}\u0000${m.asset}`;
    const prev = totals.get(k)?.quantity ?? ZERO;
    totals.set(k, { providerAccountId: m.providerAccountId, asset: m.asset, quantity: prev.plus(delta) });
  };
  for (const m of inflows) add(m, m.quantity);
  for (const m of outflows) add(m, m.quantity.negated());
  return [...totals.values()];
}

/**
 * Net quantity per (account, asset) straight from asset flows. Independent of
 * lot matching, so it can be computed before (and fed into) the lot engine.
 */
export function holdingsFromFlows(
  acquisitions: readonly Acquisition[],
  disposals: readonly Disposal[],
): CalculatedHolding[] {
  return netHoldings(acquisitions, disposals);
}

/** Net quantity per (account, asset) from lot-engine output. */
export function holdingsByAccount(engine: LotEngineResult): CalculatedHolding[] {
  return netHoldings(
    engine.lots.map((l) => ({ providerAccountId: l.providerAccountId, asset: l.asset, quantity: l.originalQuantity })),
    engine.disposals.map((d) => d.disposal),
  );
}

/**
 * An unresolved mismatch means history does not explain the provider balance,
 * so every figure for that asset is unreliable until it is investigated.
 */
export function reconciliationFlags(report: ReconciliationReport): DataQualityFlag[] {
  return report.mismatches.map((r) => ({
    asset: r.asset,
    reason: "reconciliation_mismatch" as const,
    detail: `Calculated ${r.calculated.toFixed()} vs. provider ${r.reported.toFixed()} (difference ${r.difference.toFixed()})`,
    sourceKey: null,
  }));
}

export function reconcileBalances(params: {
  readonly calculated: readonly CalculatedHolding[];
  readonly reported: readonly NormalizedBalance[];
  readonly config: AccountingConfig;
  /** Absolute per-asset tolerance for provider dust rounding. Default: exact. */
  readonly tolerance?: ReadonlyMap<AssetCode, Decimal>;
}): ReconciliationReport {
  const rows = new Map<string, { account: string; asset: AssetCode; calc: Decimal; rep: Decimal }>();
  const row = (account: string, asset: AssetCode) => {
    const k = `${account}\u0000${asset}`;
    let r = rows.get(k);
    if (!r) {
      r = { account, asset, calc: ZERO, rep: ZERO };
      rows.set(k, r);
    }
    return r;
  };
  // Cash and fee credits are not lot-tracked, so there is nothing to reconcile them against.
  for (const c of params.calculated) {
    if (!isTracked(params.config, c.asset)) continue;
    const r = row(c.providerAccountId, c.asset);
    r.calc = r.calc.plus(c.quantity);
  }
  for (const b of params.reported) {
    if (!isTracked(params.config, b.asset)) continue;
    const r = row(b.providerAccountId, b.asset);
    r.rep = r.rep.plus(b.total);
  }

  const result: ReconciliationRow[] = [];
  for (const r of rows.values()) {
    if (r.calc.isZero() && r.rep.isZero()) continue;
    const difference = r.rep.minus(r.calc);
    const tol = params.tolerance?.get(r.asset) ?? ZERO;
    result.push({
      providerAccountId: r.account,
      asset: r.asset,
      calculated: r.calc,
      reported: r.rep,
      difference,
      status: difference.abs().lessThanOrEqualTo(tol) ? "reconciled" : "mismatch",
    });
  }
  result.sort((a, b) => a.asset.localeCompare(b.asset) || a.providerAccountId.localeCompare(b.providerAccountId));
  const mismatches = result.filter((r) => r.status === "mismatch");
  return { rows: result, mismatches, reconciled: mismatches.length === 0 };
}
