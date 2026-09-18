import type { AssetCode } from "../transactions/types";

export interface AccountingConfig {
  /** Currency all cost basis, proceeds and P/L are expressed in. Must be a cash asset. */
  readonly reportingCurrency: AssetCode;
  /**
   * Assets treated as cash: they are money, not positions, so they get no lots
   * and no cost basis. Everything else (including stablecoins) is lot-tracked.
   */
  readonly cashAssets: ReadonlySet<AssetCode>;
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
): AccountingConfig {
  const cash = new Set(cashAssets);
  cash.add(reportingCurrency);
  return { reportingCurrency, cashAssets: cash };
}

export function isCash(config: AccountingConfig, asset: AssetCode): boolean {
  return config.cashAssets.has(asset);
}
