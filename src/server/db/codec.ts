import { type Decimal, dec, toStorageString } from "@/domain/decimal";
import type {
  FeeSource,
  LedgerEntryType,
  NormalizedBalance,
  NormalizedLedgerEntry,
  NormalizedTrade,
  NormalizedTransfer,
  TradeOrigin,
  TradeSide,
  TransferDirection,
  TransferKind,
} from "@/domain/transactions/types";
import type {
  BalanceSnapshot,
  LedgerEntry,
  Trade,
  Transfer,
} from "@/generated/prisma/client";

/**
 * Conversion between normalized domain records and database rows.
 * Decimals are stored as canonical TEXT and parsed strictly on the way back,
 * so a corrupted value fails loudly instead of becoming a wrong number.
 */

export const d2s = (d: Decimal): string => toStorageString(d);
export const d2sOrNull = (d: Decimal | null): string | null => (d === null ? null : toStorageString(d));
export const s2d = (s: string): Decimal => dec(s);
export const s2dOrNull = (s: string | null): Decimal | null => (s === null ? null : dec(s));

export function toRawJson(raw: unknown): string {
  return JSON.stringify(raw ?? null, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

function parseRaw(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return { unparseable: json };
  }
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Corrupt row: unexpected ${field} "${value}"`);
  }
  return value as T;
}

export function tradeToRow(t: NormalizedTrade) {
  return {
    providerAccountId: t.providerAccountId,
    externalTradeId: t.externalTradeId,
    externalOrderId: t.externalOrderId,
    baseAsset: t.baseAsset,
    quoteAsset: t.quoteAsset,
    side: t.side,
    quantity: d2s(t.quantity),
    price: d2s(t.price),
    grossValue: d2s(t.grossValue),
    fee: d2s(t.fee),
    feeAsset: t.feeAsset,
    executedAt: t.executedAt,
    origin: t.origin ?? "exchange",
    feeSource: t.feeSource ?? null,
    rawJson: toRawJson(t.rawData),
  };
}

export function rowToTrade(row: Trade, provider: string): NormalizedTrade {
  return {
    provider,
    providerAccountId: row.providerAccountId,
    externalTradeId: row.externalTradeId,
    externalOrderId: row.externalOrderId,
    baseAsset: row.baseAsset,
    quoteAsset: row.quoteAsset,
    side: oneOf<TradeSide>(row.side, ["buy", "sell"], "side"),
    quantity: s2d(row.quantity),
    price: s2d(row.price),
    grossValue: s2d(row.grossValue),
    fee: s2d(row.fee),
    feeAsset: row.feeAsset,
    executedAt: row.executedAt,
    origin: oneOf<TradeOrigin>(row.origin, ["exchange", "ledger"], "trade origin"),
    ...(row.feeSource ? { feeSource: oneOf<FeeSource>(row.feeSource, ["ledger", "fee_credit", "trade_record", "ledger_uncharged"], "fee source") } : {}),
    rawData: parseRaw(row.rawJson),
  };
}

export function transferToRow(t: NormalizedTransfer) {
  return {
    providerAccountId: t.providerAccountId,
    externalTransferId: t.externalTransferId,
    direction: t.direction,
    kind: t.kind,
    asset: t.asset,
    quantity: d2s(t.quantity),
    fee: d2s(t.fee),
    feeAsset: t.feeAsset,
    occurredAt: t.occurredAt,
    txHash: t.txHash,
    rawJson: toRawJson(t.rawData),
  };
}

export function rowToTransfer(row: Transfer, provider: string): NormalizedTransfer {
  return {
    provider,
    providerAccountId: row.providerAccountId,
    externalTransferId: row.externalTransferId,
    direction: oneOf<TransferDirection>(row.direction, ["in", "out"], "direction"),
    kind: oneOf<TransferKind>(row.kind, ["deposit", "withdrawal", "transfer", "reward", "adjustment"], "kind"),
    asset: row.asset,
    quantity: s2d(row.quantity),
    fee: s2d(row.fee),
    feeAsset: row.feeAsset,
    occurredAt: row.occurredAt,
    txHash: row.txHash,
    rawData: parseRaw(row.rawJson),
  };
}

export function ledgerToRow(e: NormalizedLedgerEntry) {
  return {
    providerAccountId: e.providerAccountId,
    externalLedgerId: e.externalLedgerId,
    externalReferenceId: e.externalReferenceId,
    entryType: e.entryType,
    providerEntryType: e.providerEntryType,
    providerSubtype: e.providerSubtype,
    asset: e.asset,
    amount: d2s(e.amount),
    fee: d2s(e.fee),
    balanceAfter: d2sOrNull(e.balanceAfter),
    occurredAt: e.occurredAt,
    rawJson: toRawJson(e.rawData),
  };
}

export function rowToLedger(row: LedgerEntry, provider: string): NormalizedLedgerEntry {
  return {
    provider,
    providerAccountId: row.providerAccountId,
    externalLedgerId: row.externalLedgerId,
    externalReferenceId: row.externalReferenceId,
    entryType: oneOf<LedgerEntryType>(
      row.entryType,
      ["trade", "deposit", "withdrawal", "transfer", "reward", "fee", "adjustment", "other"],
      "entry type",
    ),
    providerEntryType: row.providerEntryType,
    providerSubtype: row.providerSubtype,
    asset: row.asset,
    amount: s2d(row.amount),
    fee: s2d(row.fee),
    balanceAfter: s2dOrNull(row.balanceAfter),
    occurredAt: row.occurredAt,
    rawData: parseRaw(row.rawJson),
  };
}

export function balanceToRow(b: NormalizedBalance, syncRunId: string | null) {
  return {
    providerAccountId: b.providerAccountId,
    syncRunId,
    asset: b.asset,
    total: d2s(b.total),
    available: d2sOrNull(b.available),
    asOf: b.asOf,
    rawJson: toRawJson(b.rawData),
  };
}

export function rowToBalance(row: BalanceSnapshot, provider: string): NormalizedBalance {
  return {
    provider,
    providerAccountId: row.providerAccountId,
    asset: row.asset,
    total: s2d(row.total),
    available: s2dOrNull(row.available),
    asOf: row.asOf,
    rawData: parseRaw(row.rawJson),
  };
}
