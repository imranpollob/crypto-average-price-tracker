import type { Decimal } from "../decimal";
import type { AssetCode, PriceQuote } from "../transactions/types";

/**
 * Pick the latest direct quote of each asset in the reporting currency.
 * No cross rates are derived: an ADA/EUR quote is not used for a USD report.
 */
export function pricesInReportingCurrency(
  quotes: readonly PriceQuote[],
  reportingCurrency: AssetCode,
): Map<AssetCode, Decimal> {
  const latest = new Map<AssetCode, PriceQuote>();
  for (const q of quotes) {
    if (q.quoteAsset !== reportingCurrency) continue;
    if (!q.price.greaterThan(0)) continue;
    const prev = latest.get(q.baseAsset);
    if (!prev || q.asOf.getTime() > prev.asOf.getTime()) latest.set(q.baseAsset, q);
  }
  return new Map([...latest].map(([asset, q]) => [asset, q.price]));
}
