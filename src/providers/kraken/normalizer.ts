import { ALLOCATION_SCALE, type Decimal, dec, InvalidDecimalError, ZERO } from "@/domain/decimal";
import type {
  AssetCode,
  FeeSource,
  LedgerEntryType,
  NormalizedBalance,
  NormalizedLedgerEntry,
  NormalizedTrade,
  NormalizedTransfer,
  TransferKind,
} from "@/domain/transactions/types";
import { ProviderError } from "../types";
import type { KrakenAssetMapper } from "./mapper";
import type { KrakenBalanceResult, KrakenLedgerRow, KrakenTradeRow } from "./types";

/**
 * Kraken rows → normalized records. Pure functions; every amount goes through
 * the strict decimal parser, every asset through the mapper.
 */

export const PROVIDER_TYPE = "kraken";

function invalid(what: string): ProviderError {
  return new ProviderError("invalid_response", `Kraken returned an invalid ${what}`, false);
}

function decimalField(value: unknown, what: string): Decimal {
  if (typeof value !== "string") throw invalid(what);
  try {
    return dec(value);
  } catch (e) {
    if (e instanceof InvalidDecimalError) throw invalid(what);
    throw e;
  }
}

function stringField(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) throw invalid(what);
  return value;
}

/** Kraken "1688669448.4402" (seconds) → Date, via decimal arithmetic (no floats). */
export function krakenTime(value: unknown, what = "timestamp"): Date {
  const seconds = decimalField(value, what);
  if (seconds.isNegative()) throw invalid(what);
  const ms = seconds.times(1000).toDecimalPlaces(0, 6 /* ROUND_HALF_EVEN */);
  return new Date(Number(ms.toFixed()));
}

/** Seconds (floor) for Kraken start/end parameters. */
export function toKrakenSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

// --- Trades ------------------------------------------------------------------

type LedgerLine = readonly [string, KrakenLedgerRow];

export interface FeeCreditUsage {
  readonly amount: Decimal;
  readonly asset: AssetCode;
  readonly ledgerIds: readonly string[];
}

export type LedgerFeeEvidence =
  /** A fee was charged in exactly one real asset (plus possibly fee credits). */
  | { readonly kind: "charged"; readonly fee: Decimal; readonly feeAsset: AssetCode; readonly ledgerIds: readonly string[]; readonly credit: FeeCreditUsage | null }
  /** The whole fee was covered by fee credits: no real asset or cash paid it. */
  | { readonly kind: "credit_only"; readonly credit: FeeCreditUsage }
  /** The trade's ledger lines (both assets present) show no fee at all. */
  | { readonly kind: "none" }
  /** Fees in several real assets, or incomplete lines: the ledger cannot tell. */
  | { readonly kind: "inconclusive" };

/**
 * What the account ledger says about a trade's fee (lines with refid = txid).
 * TradesHistory only reports the fee converted to quote currency; the ledger
 * shows the balance changes that actually happened, including fee-credit use.
 */
export function feeFromLedger(
  lines: readonly LedgerLine[],
  ctx: { mapper: KrakenAssetMapper; feeCreditAssets: ReadonlySet<AssetCode> },
  pair: { base: AssetCode; quote: AssetCode },
): LedgerFeeEvidence {
  if (lines.length === 0) return { kind: "inconclusive" };
  const real = new Map<AssetCode, { fee: Decimal; ids: string[] }>();
  type CreditAcc = { amount: Decimal; asset: AssetCode; ids: string[] };
  let credit = null as CreditAcc | null;
  const assetsSeen = new Set<AssetCode>();
  for (const [id, row] of lines) {
    const asset = ctx.mapper.canonicalAsset(row.asset);
    const fee = decimalField(row.fee, `ledger fee (${id})`);
    const amount = decimalField(row.amount, `ledger amount (${id})`);
    assetsSeen.add(asset);
    if (ctx.feeCreditAssets.has(asset)) {
      // Credit consumption shows as a debit and/or a fee on the credit line.
      const used = (amount.isNegative() ? amount.abs() : ZERO).plus(fee);
      if (used.isZero()) continue;
      if (credit && credit.asset !== asset) return { kind: "inconclusive" };
      credit = { amount: (credit?.amount ?? ZERO).plus(used), asset, ids: [...(credit?.ids ?? []), id] };
      continue;
    }
    if (fee.isZero()) continue;
    const prev = real.get(asset) ?? { fee: ZERO, ids: [] };
    real.set(asset, { fee: prev.fee.plus(fee), ids: [...prev.ids, id] });
  }
  const creditUsage = credit ? { amount: credit.amount, asset: credit.asset, ledgerIds: credit.ids } : null;
  if (real.size > 1) return { kind: "inconclusive" };
  if (real.size === 1) {
    const [feeAsset, v] = [...real][0]!;
    return { kind: "charged", fee: v.fee, feeAsset, ledgerIds: v.ids, credit: creditUsage };
  }
  if (creditUsage) return { kind: "credit_only", credit: creditUsage };
  // "No fee" is only conclusive when both legs of the trade are present.
  return assetsSeen.has(pair.base) && assetsSeen.has(pair.quote) ? { kind: "none" } : { kind: "inconclusive" };
}

export type SkippedTrade = { readonly txid: string; readonly reason: "margin" };

export interface NormalizeContext {
  readonly mapper: KrakenAssetMapper;
  readonly providerAccountId: string;
  /** Canonical codes of Kraken fee credits (KFEE). */
  readonly feeCreditAssets: ReadonlySet<AssetCode>;
}

export function normalizeTrades(
  params: NormalizeContext & {
    readonly rows: ReadonlyMap<string, KrakenTradeRow>;
    readonly ledgerByRefid: ReadonlyMap<string, readonly LedgerLine[]>;
  },
): { trades: NormalizedTrade[]; skipped: SkippedTrade[] } {
  const trades: NormalizedTrade[] = [];
  const skipped: SkippedTrade[] = [];
  for (const [txid, row] of params.rows) {
    stringField(txid, "trade id");
    if (!row || typeof row !== "object") throw invalid(`trade (${txid})`);

    // Margin trades are out of scope; their margin/rollover ledger lines are
    // imported as unsupported activity and flagged for review.
    const margin = row.margin === undefined ? ZERO : decimalField(row.margin, `trade margin (${txid})`);
    if (!margin.isZero()) {
      skipped.push({ txid, reason: "margin" });
      continue;
    }

    const side = row.type;
    if (side !== "buy" && side !== "sell") throw invalid(`trade side (${txid})`);
    const pair = params.mapper.resolvePair(stringField(row.pair, `trade pair (${txid})`));
    const quantity = decimalField(row.vol, `trade volume (${txid})`);
    const price = decimalField(row.price, `trade price (${txid})`);
    const grossValue = decimalField(row.cost, `trade cost (${txid})`);
    const reportedFee = decimalField(row.fee, `trade fee (${txid})`);

    const evidence = feeFromLedger(params.ledgerByRefid.get(txid) ?? [], params, pair);
    let fee: Decimal;
    let feeAsset: AssetCode | null;
    let feeSource: FeeSource;
    let feeLedgerIds: readonly string[] = [];
    let feeCredit: FeeCreditUsage | null = null;
    switch (evidence.kind) {
      case "charged":
        ({ fee, feeAsset } = evidence);
        feeLedgerIds = evidence.ledgerIds;
        feeCredit = evidence.credit;
        feeSource = "ledger";
        break;
      case "credit_only":
        // Represent the credit usage explicitly; it costs the portfolio nothing.
        fee = evidence.credit.amount;
        feeAsset = evidence.credit.asset;
        feeLedgerIds = evidence.credit.ledgerIds;
        feeCredit = evidence.credit;
        feeSource = "fee_credit";
        break;
      case "none":
        // The balance changes show no fee: nothing left the portfolio for it.
        fee = ZERO;
        feeAsset = null;
        feeSource = reportedFee.isZero() ? "ledger" : "ledger_uncharged";
        break;
      case "inconclusive":
        // No usable ledger evidence: Kraken's quote-currency fee.
        fee = reportedFee;
        feeAsset = reportedFee.isZero() ? null : pair.quote;
        feeSource = "trade_record";
        break;
    }

    trades.push({
      provider: PROVIDER_TYPE,
      providerAccountId: params.providerAccountId,
      externalTradeId: txid,
      externalOrderId: typeof row.ordertxid === "string" && row.ordertxid ? row.ordertxid : null,
      baseAsset: pair.base,
      quoteAsset: pair.quote,
      side,
      quantity,
      price,
      grossValue,
      fee,
      feeAsset,
      executedAt: krakenTime(row.time, `trade time (${txid})`),
      origin: "exchange",
      feeSource,
      rawData: {
        txid,
        trade: row,
        feeLedgerIds,
        ...(feeCredit ? { feeCreditUsed: { amount: feeCredit.amount.toFixed(), asset: feeCredit.asset, ledgerIds: feeCredit.ledgerIds } } : {}),
        ...(feeSource === "ledger_uncharged" ? { reportedFeeNotCharged: row.fee } : {}),
      },
    });
  }
  return { trades, skipped };
}

// --- Instant Buy / Sell / Convert (ledger spend + receive) -------------------

export type InstantLinkProblem =
  | "missing_counterpart"
  | "multiple_spend_or_receive"
  | "unexpected_lines"
  | "same_asset"
  | "wrong_sign"
  | "fees_on_both_sides"
  | "fee_credit_involved";

export interface UnlinkedInstant {
  readonly refid: string;
  readonly ledgerIds: readonly string[];
  readonly problem: InstantLinkProblem;
}

/**
 * Kraken records Buy Crypto / Kraken app transactions only in the ledger, as a
 * `spend` line (asset debited) and a `receive` line (asset credited) that share
 * a `refid`. A trade is synthesized ONLY when that link is unambiguous:
 *
 *   - the refid group has exactly one spend and exactly one receive line and
 *     no other lines;
 *   - spend amount < 0, receive amount > 0, and the two assets differ;
 *   - at most one side carries a fee (a single fee asset).
 *
 * Nothing is ever paired by timestamp, amount or asset plausibility. Anything
 * else is left as unsupported ledger activity (review required).
 *
 * Amounts follow Kraken's ledger convention (balance change = amount − fee):
 * the fee is separate from the amount, so value given up = |spend| + spend fee
 * and quantity kept = receive − receive fee. No fee is counted twice. A spread
 * embedded in the quoted price is part of the amounts and is not separated.
 *
 * Orientation: when the received asset is fiat the result is a SELL of the
 * spent asset; otherwise a BUY of the received asset.
 */
export function linkInstantTrades(
  params: NormalizeContext & {
    readonly rows: ReadonlyMap<string, KrakenLedgerRow>;
    readonly fiatAssets: ReadonlySet<AssetCode>;
  },
): { trades: NormalizedTrade[]; linkedLedgerIds: Set<string>; unlinked: UnlinkedInstant[] } {
  const groups = new Map<string, LedgerLine[]>();
  for (const [id, row] of params.rows) {
    if (row?.type !== "spend" && row?.type !== "receive") continue;
    const refid = typeof row.refid === "string" ? row.refid : "";
    if (!refid) continue;
    groups.set(refid, [...(groups.get(refid) ?? []), [id, row]]);
  }
  // A refid group also contains any other ledger lines sharing the refid.
  for (const [id, row] of params.rows) {
    if (row?.type === "spend" || row?.type === "receive") continue;
    const g = typeof row?.refid === "string" ? groups.get(row.refid) : undefined;
    if (g) g.push([id, row]);
  }

  const trades: NormalizedTrade[] = [];
  const linkedLedgerIds = new Set<string>();
  const unlinked: UnlinkedInstant[] = [];

  for (const [refid, lines] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const ids = lines.map(([id]) => id).sort();
    const fail = (problem: InstantLinkProblem) => unlinked.push({ refid, ledgerIds: ids, problem });
    const spends = lines.filter(([, r]) => r.type === "spend");
    const receives = lines.filter(([, r]) => r.type === "receive");
    if (spends.length === 0 || receives.length === 0) {
      fail("missing_counterpart");
      continue;
    }
    if (spends.length > 1 || receives.length > 1) {
      fail("multiple_spend_or_receive");
      continue;
    }
    if (lines.length !== 2) {
      fail("unexpected_lines");
      continue;
    }
    const [spendId, spend] = spends[0]!;
    const [receiveId, receive] = receives[0]!;
    const spentAsset = params.mapper.canonicalAsset(stringField(spend.asset, `ledger asset (${spendId})`));
    const receivedAsset = params.mapper.canonicalAsset(stringField(receive.asset, `ledger asset (${receiveId})`));
    const spendAmount = decimalField(spend.amount, `ledger amount (${spendId})`);
    const receiveAmount = decimalField(receive.amount, `ledger amount (${receiveId})`);
    const spendFee = decimalField(spend.fee, `ledger fee (${spendId})`);
    const receiveFee = decimalField(receive.fee, `ledger fee (${receiveId})`);
    if (spentAsset === receivedAsset) {
      fail("same_asset");
      continue;
    }
    if (params.feeCreditAssets.has(spentAsset) || params.feeCreditAssets.has(receivedAsset)) {
      fail("fee_credit_involved");
      continue;
    }
    if (!spendAmount.isNegative() || !receiveAmount.greaterThan(0) || spendFee.isNegative() || receiveFee.isNegative()) {
      fail("wrong_sign");
      continue;
    }
    if (!spendFee.isZero() && !receiveFee.isZero()) {
      fail("fees_on_both_sides");
      continue;
    }

    const spent = spendAmount.abs();
    const sell = params.fiatAssets.has(receivedAsset);
    // SELL: base = spent asset, quote = received; BUY: base = received, quote = spent.
    const [base, quote, quantity, grossValue] = sell
      ? [spentAsset, receivedAsset, spent, receiveAmount]
      : [receivedAsset, spentAsset, receiveAmount, spent];
    const fee = spendFee.isZero() ? receiveFee : spendFee;
    const feeAsset = fee.isZero() ? null : spendFee.isZero() ? receivedAsset : spentAsset;
    const at = krakenTime(spend.time, `ledger time (${spendId})`);
    const receivedAt = krakenTime(receive.time, `ledger time (${receiveId})`);

    trades.push({
      provider: PROVIDER_TYPE,
      providerAccountId: params.providerAccountId,
      // Deterministic, derived from Kraken's own ledger ids (no invented trade id).
      externalTradeId: `ledger:${spendId}+${receiveId}`,
      externalOrderId: refid,
      baseAsset: base,
      quoteAsset: quote,
      side: sell ? "sell" : "buy",
      quantity,
      // Effective execution price (explicit fee excluded, embedded spread included).
      price: grossValue.dividedBy(quantity).toDecimalPlaces(ALLOCATION_SCALE, 6 /* ROUND_HALF_EVEN */),
      grossValue,
      fee,
      feeAsset,
      executedAt: receivedAt.getTime() > at.getTime() ? receivedAt : at,
      origin: "ledger",
      feeSource: "ledger",
      rawData: {
        source: "ledger_spend_receive",
        refid,
        spend: { id: spendId, ledger: spend },
        receive: { id: receiveId, ledger: receive },
      },
    });
    linkedLedgerIds.add(spendId);
    linkedLedgerIds.add(receiveId);
  }
  return { trades, linkedLedgerIds, unlinked };
}

// --- Ledger ------------------------------------------------------------------

/** Moves between buckets of the same asset inside the account (spot ↔ staking/earn). */
const INTERNAL_SUBTYPES = new Set([
  "spottostaking",
  "stakingfromspot",
  "spotfromstaking",
  "stakingtospot",
  "allocation",
  "deallocation",
  "migration",
  "autoallocation",
]);

type Classification =
  | { readonly entryType: LedgerEntryType; readonly movement: "none" | "internal" }
  | { readonly entryType: LedgerEntryType; readonly movement: "transfer"; readonly kind: TransferKind };

/** Kraken ledger type/subtype → normalized category and whether it moves assets in/out. */
export function classifyLedger(type: string, subtype: string, amount: Decimal): Classification {
  const sub = subtype.toLowerCase();
  const positive = amount.greaterThan(0);
  const negative = amount.isNegative();
  switch (type) {
    case "trade":
      // Already represented by TradesHistory — never counted twice.
      return { entryType: "trade", movement: "none" };
    case "deposit":
      return positive ? { entryType: "deposit", movement: "transfer", kind: "deposit" } : { entryType: "other", movement: "none" };
    case "withdrawal":
      return negative ? { entryType: "withdrawal", movement: "transfer", kind: "withdrawal" } : { entryType: "other", movement: "none" };
    case "transfer":
      if (INTERNAL_SUBTYPES.has(sub)) return { entryType: "transfer", movement: "internal" };
      return amount.isZero() ? { entryType: "transfer", movement: "none" } : { entryType: "transfer", movement: "transfer", kind: "transfer" };
    case "staking":
    case "reward":
    case "dividend":
      if (INTERNAL_SUBTYPES.has(sub)) return { entryType: "transfer", movement: "internal" };
      return positive ? { entryType: "reward", movement: "transfer", kind: "reward" } : { entryType: "other", movement: "none" };
    case "earn":
      // Not in the documented enum but present in real ledgers.
      if (INTERNAL_SUBTYPES.has(sub)) return { entryType: "transfer", movement: "internal" };
      if (sub === "reward" && positive) return { entryType: "reward", movement: "transfer", kind: "reward" };
      return { entryType: "other", movement: "none" };
    case "adjustment":
    case "credit":
      return amount.isZero() ? { entryType: "adjustment", movement: "none" } : { entryType: "adjustment", movement: "transfer", kind: "adjustment" };
    default:
      // margin, rollover, spend, receive, settled, sale, conversion, nft*, custodytransfer, none, unknown…
      return { entryType: "other", movement: "none" };
  }
}

export function normalizeLedger(params: {
  readonly rows: ReadonlyMap<string, KrakenLedgerRow>;
  readonly mapper: KrakenAssetMapper;
  readonly providerAccountId: string;
  /** spend/receive lines already represented by a synthesized trade. */
  readonly linkedLedgerIds?: ReadonlySet<string>;
}): { entries: NormalizedLedgerEntry[]; transfers: NormalizedTransfer[] } {
  const entries: NormalizedLedgerEntry[] = [];
  const transfers: NormalizedTransfer[] = [];
  for (const [id, row] of params.rows) {
    stringField(id, "ledger id");
    if (!row || typeof row !== "object") throw invalid(`ledger entry (${id})`);
    const type = typeof row.type === "string" ? row.type : "";
    const subtype = typeof row.subtype === "string" ? row.subtype : "";
    const asset = params.mapper.canonicalAsset(stringField(row.asset, `ledger asset (${id})`));
    const amount = decimalField(row.amount, `ledger amount (${id})`);
    const fee = decimalField(row.fee, `ledger fee (${id})`);
    if (fee.isNegative()) throw invalid(`ledger fee (${id})`);
    const balanceAfter = row.balance === undefined ? null : decimalField(row.balance, `ledger balance (${id})`);
    const occurredAt = krakenTime(row.time, `ledger time (${id})`);
    const c: Classification = params.linkedLedgerIds?.has(id)
      ? { entryType: "trade", movement: "none" }
      : classifyLedger(type, subtype, amount);

    entries.push({
      provider: PROVIDER_TYPE,
      providerAccountId: params.providerAccountId,
      externalLedgerId: id,
      externalReferenceId: typeof row.refid === "string" && row.refid ? row.refid : null,
      entryType: c.entryType,
      providerEntryType: type || "none",
      providerSubtype: subtype || null,
      asset,
      amount,
      fee,
      balanceAfter,
      occurredAt,
      rawData: { id, ledger: row },
    });

    if (c.movement === "transfer") {
      transfers.push({
        provider: PROVIDER_TYPE,
        providerAccountId: params.providerAccountId,
        externalTransferId: id,
        direction: amount.isNegative() ? "out" : "in",
        kind: c.kind,
        asset,
        // Kraken: balance change = amount − fee; our convention: quantity gross, fee separate.
        quantity: amount.abs(),
        fee,
        feeAsset: fee.isZero() ? null : asset,
        occurredAt,
        txHash: null,
        rawData: { id, ledger: row },
      });
    }
  }
  return { entries, transfers };
}

// --- Balances ----------------------------------------------------------------

/** Balances summed per canonical asset (ADA + ADA.S → ADA); components kept in rawData. */
export function normalizeBalances(params: {
  readonly result: KrakenBalanceResult;
  readonly mapper: KrakenAssetMapper;
  readonly providerAccountId: string;
  readonly asOf: Date;
}): NormalizedBalance[] {
  if (!params.result || typeof params.result !== "object") throw invalid("balance response");
  const totals = new Map<AssetCode, { total: Decimal; components: Record<string, string> }>();
  for (const [krakenAsset, value] of Object.entries(params.result)) {
    const amount = decimalField(value, `balance (${krakenAsset.slice(0, 20)})`);
    const asset = params.mapper.canonicalAsset(krakenAsset);
    const prev = totals.get(asset) ?? { total: ZERO, components: {} };
    totals.set(asset, {
      total: prev.total.plus(amount),
      components: { ...prev.components, [krakenAsset]: value },
    });
  }
  return [...totals].map(([asset, v]) => ({
    provider: PROVIDER_TYPE,
    providerAccountId: params.providerAccountId,
    asset,
    total: v.total,
    available: null,
    asOf: params.asOf,
    rawData: { components: v.components },
  }));
}
