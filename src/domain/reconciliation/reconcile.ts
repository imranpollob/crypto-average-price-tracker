import { type AccountingConfig, isCash } from "../accounting/config";
import { type Decimal, ZERO } from "../decimal";
import type { LotEngineResult } from "../lots/types";
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

/** Net quantity per (account, asset) from lot-engine output. */
export function holdingsByAccount(engine: LotEngineResult): CalculatedHolding[] {
  const totals = new Map<string, CalculatedHolding>();
  const add = (providerAccountId: string, asset: AssetCode, delta: Decimal) => {
    const k = `${providerAccountId}\u0000${asset}`;
    const prev = totals.get(k)?.quantity ?? ZERO;
    totals.set(k, { providerAccountId, asset, quantity: prev.plus(delta) });
  };
  for (const l of engine.lots) add(l.providerAccountId, l.asset, l.originalQuantity);
  for (const d of engine.disposals) {
    add(d.disposal.providerAccountId, d.disposal.asset, d.disposal.quantity.negated());
  }
  return [...totals.values()];
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
  // Cash is not lot-tracked, so there is nothing to reconcile it against.
  for (const c of params.calculated) {
    if (isCash(params.config, c.asset)) continue;
    const r = row(c.providerAccountId, c.asset);
    r.calc = r.calc.plus(c.quantity);
  }
  for (const b of params.reported) {
    if (isCash(params.config, b.asset)) continue;
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
