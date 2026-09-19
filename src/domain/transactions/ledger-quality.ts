import { type AccountingConfig, isTracked } from "../accounting/config";
import type { DataQualityFlag } from "../lots/types";
import { ledgerKey } from "./identity";
import type { NormalizedLedgerEntry } from "./types";

/**
 * Ledger activity the engine cannot account for (normalized as "other") makes
 * the affected asset's figures unreliable. It is imported and kept, but never
 * turned into a guessed transaction — it is flagged for review instead.
 */
export function ledgerDataQualityFlags(
  entries: readonly NormalizedLedgerEntry[],
  config: AccountingConfig,
): DataQualityFlag[] {
  const flags: DataQualityFlag[] = [];
  for (const e of entries) {
    if (e.entryType !== "other" || !isTracked(config, e.asset)) continue;
    if (e.amount.isZero() && e.fee.isZero()) continue;
    const label = e.providerSubtype ? `${e.providerEntryType}/${e.providerSubtype}` : e.providerEntryType;
    flags.push({
      asset: e.asset,
      reason: "unsupported_activity",
      detail: `Unsupported ${e.provider} ledger activity "${label}" (${e.amount.toFixed()} ${e.asset})`,
      sourceKey: ledgerKey(e),
    });
  }
  return flags;
}
