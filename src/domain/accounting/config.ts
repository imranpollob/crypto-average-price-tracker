import type { AssetCode } from "../transactions/types";

export interface AccountingConfig {
  /** Currency all cost basis, proceeds and P/L are expressed in. Must be a cash asset. */
  readonly reportingCurrency: AssetCode;
  /**
   * Assets treated as cash: they are money, not positions, so they get no lots
   * and no cost basis. Everything else (including stablecoins) is lot-tracked.
   */
  readonly cashAssets: ReadonlySet<AssetCode>;
  /**
   * Provider-internal fee credits (e.g. an exchange's fee-credit token). They
   * are not portfolio assets: no lots, no market value, no reconciliation.
   * A fee paid with them costs the portfolio nothing (no asset or cash left it);
   * the usage stays visible on the trade's fee / fee asset.
   */
  readonly feeCreditAssets: ReadonlySet<AssetCode>;
}

export const DEFAULT_CASH_ASSETS: readonly AssetCode[] = [
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "CHF",
  "JPY",
];

export function createAccountingConfig(
  reportingCurrency: AssetCode = "USD",
  cashAssets: Iterable<AssetCode> = DEFAULT_CASH_ASSETS,
  feeCreditAssets: Iterable<AssetCode> = [],
): AccountingConfig {
  const cash = new Set(cashAssets);
  cash.add(reportingCurrency);
  const credits = new Set(feeCreditAssets);
  for (const c of credits) {
    if (cash.has(c)) throw new Error(`${c} cannot be both cash and a fee credit`);
  }
  return { reportingCurrency, cashAssets: cash, feeCreditAssets: credits };
}

export function isCash(config: AccountingConfig, asset: AssetCode): boolean {
  return config.cashAssets.has(asset);
}

export function isFeeCredit(config: AccountingConfig, asset: AssetCode): boolean {
  return config.feeCreditAssets.has(asset);
}

/** Portfolio positions: everything that is neither cash nor a fee credit. */
export function isTracked(config: AccountingConfig, asset: AssetCode): boolean {
  return !isCash(config, asset) && !isFeeCredit(config, asset);
}
