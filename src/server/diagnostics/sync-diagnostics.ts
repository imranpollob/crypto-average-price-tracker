import { type AccountingConfig, isFeeCredit, isTracked } from "@/domain/accounting/config";
import { dec } from "@/domain/decimal";
import type { Db } from "../db/client";

/**
 * Non-secret diagnostics of an account's imported history, for validating a
 * real sync. Built only from normalized records, sync runs and reconciliation
 * results — the credentials column is never read, and no raw provider payload
 * (which may contain account identifiers) is included.
 */
export interface SyncDiagnostics {
  readonly generatedAt: string;
  readonly providerName: string;
  readonly lastSuccessfulSyncAt: string | null;
  readonly lastRun: null | {
    readonly status: string;
    readonly mode: string;
    readonly syncFrom: string | null;
    readonly syncTo: string;
    readonly errorCategory: string | null;
  };
  readonly records: {
    readonly trades: number;
    readonly exchangeTrades: number;
    /** Trades synthesized from linked ledger records (instant buy/sell/convert). */
    readonly ledgerDerivedTrades: number;
    readonly ledgerEntries: number;
    readonly transfers: number;
  };
  readonly earliestTransaction: string | null;
  readonly latestTransaction: string | null;
  readonly fees: {
    readonly zeroFee: number;
    /** Fee in the trade's base or quote asset. */
    readonly normal: number;
    /** Fee in a tracked asset that is neither base nor quote. */
    readonly thirdAsset: number;
    /** Fee paid with a fee credit (e.g. KFEE). */
    readonly feeCredit: number;
    /** Fee taken from the trade record because ledger evidence was unavailable. */
    readonly fromTradeRecord: number;
    /** Trade record reports a fee but the ledger shows none charged. */
    readonly reportedButNotCharged: number;
  };
  readonly review: {
    readonly total: number;
    /** Unsupported ledger activity on tracked assets, by provider type/subtype. */
    readonly byLedgerType: ReadonlyArray<{ readonly type: string; readonly count: number }>;
  };
  readonly ledgerTypes: ReadonlyArray<{ readonly type: string; readonly count: number }>;
  readonly reconciliation: ReadonlyArray<{
    readonly asset: string;
    readonly calculated: string;
    readonly reported: string;
    readonly difference: string;
    readonly status: string;
  }>;
  /** Provider balances not treated as portfolio assets (fee credits). */
  readonly excludedBalances: ReadonlyArray<{ readonly asset: string; readonly total: string; readonly reason: string }>;
}

const label = (type: string, subtype: string | null) => (subtype ? `${type}/${subtype}` : type);

function countBy(values: readonly string[]): Array<{ type: string; count: number }> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

export async function buildSyncDiagnostics(params: {
  readonly db: Db;
  readonly providerAccountId: string;
  readonly providerName: string;
  readonly config: AccountingConfig;
  readonly now?: Date;
}): Promise<SyncDiagnostics> {
  const { db, providerAccountId: id, config } = params;
  const account = await db.providerAccount.findUniqueOrThrow({
    where: { id },
    select: { lastSuccessfulSyncAt: true }, // never select credentials
  });
  const [lastRun, lastSuccess, trades, ledger, transferTimes, transferCount] = await Promise.all([
    db.syncRun.findFirst({ where: { providerAccountId: id }, orderBy: { startedAt: "desc" } }),
    db.syncRun.findFirst({
      where: { providerAccountId: id, status: "succeeded" },
      orderBy: { startedAt: "desc" },
      include: { reconciliations: { orderBy: { asset: "asc" } }, balances: true },
    }),
    db.trade.findMany({
      where: { providerAccountId: id },
      select: { baseAsset: true, quoteAsset: true, fee: true, feeAsset: true, feeSource: true, origin: true, executedAt: true },
    }),
    db.ledgerEntry.findMany({
      where: { providerAccountId: id },
      select: { entryType: true, providerEntryType: true, providerSubtype: true, asset: true, amount: true, fee: true, occurredAt: true },
    }),
    db.transfer.aggregate({ where: { providerAccountId: id }, _min: { occurredAt: true }, _max: { occurredAt: true } }),
    db.transfer.count({ where: { providerAccountId: id } }),
  ]);

  const fees = { zeroFee: 0, normal: 0, thirdAsset: 0, feeCredit: 0, fromTradeRecord: 0, reportedButNotCharged: 0 };
  for (const t of trades) {
    if (t.feeSource === "trade_record") fees.fromTradeRecord++;
    if (t.feeSource === "ledger_uncharged") fees.reportedButNotCharged++;
    if (dec(t.fee).isZero() || !t.feeAsset) fees.zeroFee++;
    else if (isFeeCredit(config, t.feeAsset)) fees.feeCredit++;
    else if (t.feeAsset === t.baseAsset || t.feeAsset === t.quoteAsset) fees.normal++;
    else fees.thirdAsset++;
  }

  const unsupported = ledger.filter(
    (e) => e.entryType === "other" && isTracked(config, e.asset) && !(dec(e.amount).isZero() && dec(e.fee).isZero()),
  );

  const times = [
    ...trades.map((t) => t.executedAt.getTime()),
    ...ledger.map((e) => e.occurredAt.getTime()),
    ...[transferTimes._min.occurredAt, transferTimes._max.occurredAt].filter((d): d is Date => d !== null).map((d) => d.getTime()),
  ];
  const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());

  return {
    generatedAt: (params.now ?? new Date()).toISOString(),
    providerName: params.providerName,
    lastSuccessfulSyncAt: account.lastSuccessfulSyncAt?.toISOString() ?? null,
    lastRun: lastRun && {
      status: lastRun.status,
      mode: lastRun.mode,
      syncFrom: lastRun.syncFrom?.toISOString() ?? null,
      syncTo: lastRun.syncTo.toISOString(),
      errorCategory: lastRun.errorCategory,
    },
    records: {
      trades: trades.length,
      exchangeTrades: trades.filter((t) => t.origin === "exchange").length,
      ledgerDerivedTrades: trades.filter((t) => t.origin === "ledger").length,
      ledgerEntries: ledger.length,
      transfers: transferCount,
    },
    earliestTransaction: iso(times.length ? Math.min(...times) : undefined),
    latestTransaction: iso(times.length ? Math.max(...times) : undefined),
    fees,
    review: {
      total: unsupported.length,
      byLedgerType: countBy(unsupported.map((e) => label(e.providerEntryType, e.providerSubtype))),
    },
    ledgerTypes: countBy(ledger.map((e) => label(e.providerEntryType, e.providerSubtype))),
    reconciliation: (lastSuccess?.reconciliations ?? []).map((r) => ({
      asset: r.asset,
      calculated: r.calculated,
      reported: r.reported,
      difference: r.difference,
      status: r.status,
    })),
    excludedBalances: (lastSuccess?.balances ?? [])
      .filter((b) => isFeeCredit(config, b.asset))
      .map((b) => ({ asset: b.asset, total: b.total, reason: "fee credit (not a portfolio asset)" })),
  };
}

/** Plain-text version for copying into a support/validation conversation. Contains no secrets. */
export function diagnosticsText(d: SyncDiagnostics): string {
  const lines = [
    `${d.providerName} sync diagnostics (generated ${d.generatedAt})`,
    `Last successful sync: ${d.lastSuccessfulSyncAt ?? "never"}`,
    d.lastRun
      ? `Last run: ${d.lastRun.status} (${d.lastRun.mode}), range ${d.lastRun.syncFrom ?? "full history"} → ${d.lastRun.syncTo}${d.lastRun.errorCategory ? `, error: ${d.lastRun.errorCategory}` : ""}`
      : "Last run: none",
    `Records: ${d.records.trades} trades (${d.records.exchangeTrades} exchange, ${d.records.ledgerDerivedTrades} instant buy/sell/convert), ${d.records.ledgerEntries} ledger entries, ${d.records.transfers} transfers`,
    `History span: ${d.earliestTransaction ?? "—"} → ${d.latestTransaction ?? "—"}`,
    `Fees: ${d.fees.normal} normal, ${d.fees.thirdAsset} third-asset, ${d.fees.feeCredit} paid with fee credits, ${d.fees.zeroFee} zero; ${d.fees.fromTradeRecord} from trade record (no ledger evidence), ${d.fees.reportedButNotCharged} reported but not charged in ledger`,
    `Review required: ${d.review.total}${d.review.byLedgerType.length ? ` (${d.review.byLedgerType.map((t) => `${t.type}: ${t.count}`).join(", ")})` : ""}`,
    `Ledger types: ${d.ledgerTypes.map((t) => `${t.type}: ${t.count}`).join(", ") || "—"}`,
    "Reconciliation (asset: calculated | provider | difference | status):",
    ...(d.reconciliation.length
      ? d.reconciliation.map((r) => `  ${r.asset}: ${r.calculated} | ${r.reported} | ${r.difference} | ${r.status}`)
      : ["  —"]),
    ...(d.excludedBalances.length
      ? ["Excluded balances:", ...d.excludedBalances.map((b) => `  ${b.asset}: ${b.total} (${b.reason})`)]
      : []),
  ];
  return lines.join("\n");
}
