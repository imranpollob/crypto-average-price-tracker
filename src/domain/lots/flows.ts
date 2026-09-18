import { type AccountingConfig, isCash } from "../accounting/config";
import { type Decimal, ZERO } from "../decimal";
import { tradeKey, transferKey } from "../transactions/identity";
import type { AssetCode, NormalizedTrade, NormalizedTransfer } from "../transactions/types";
import type { Acquisition, Disposal, Valuation } from "./types";

/**
 * Translate normalized trades and transfers into per-asset acquisitions and
 * disposals.
 *
 * Fee rules (reporting currency R, trade base B, quote Q, fee asset F):
 *  - BUY,  F = Q: cost = gross + fee                         (acquisition cost = gross buy value + buy fee)
 *  - BUY,  F = B: units received = qty − fee; the withheld units are the fee:
 *                 cost.gross = (qty − fee) × price, cost.fee = fee × price
 *  - SELL, F = Q: proceeds = gross − fee                     (net sale proceeds = gross − sell fee)
 *  - SELL, F = B: units leaving = qty + fee; the extra units are the fee:
 *                 proceeds.gross = (qty + fee) × price, proceeds.fee = fee × price
 * Values are only "known" when denominated in R. Otherwise they are marked
 * unknown and must be supplied manually — no FX rate is ever guessed.
 */

export interface DerivedFlows {
  readonly acquisitions: Acquisition[];
  readonly disposals: Disposal[];
  readonly warnings: FlowWarning[];
}

export interface FlowWarning {
  readonly sourceKey: string;
  readonly code: "cash_only_trade" | "non_positive_quantity" | "fee_exceeds_quantity";
}

type Amount = { readonly amount: Decimal; readonly asset: AssetCode };

function valueInReporting(config: AccountingConfig, a: Amount): Decimal | null {
  if (a.amount.isZero()) return ZERO;
  return a.asset === config.reportingCurrency ? a.amount : null;
}

function valuation(
  config: AccountingConfig,
  gross: Amount,
  fee: Amount | null,
): Valuation {
  const g = valueInReporting(config, gross);
  if (g === null) return { status: "unknown", reason: "non_reporting_currency" };
  if (fee === null) return { status: "known", gross: g, fee: ZERO };
  const f = valueInReporting(config, fee);
  // Gross is in the reporting currency here, so an unconvertible fee is in a third asset.
  if (f === null) return { status: "unknown", reason: "fee_in_other_asset" };
  return { status: "known", gross: g, fee: f };
}

function tradeFlows(t: NormalizedTrade, config: AccountingConfig, out: DerivedFlows): void {
  const key = tradeKey(t);
  const base = t.baseAsset;
  const quote = t.quoteAsset;
  const baseTracked = !isCash(config, base);
  const quoteTracked = !isCash(config, quote);

  if (!baseTracked && !quoteTracked) {
    out.warnings.push({ sourceKey: key, code: "cash_only_trade" });
    return;
  }
  if (!t.quantity.greaterThan(0)) {
    out.warnings.push({ sourceKey: key, code: "non_positive_quantity" });
    return;
  }

  const fee = t.fee;
  const feeAsset = fee.isZero() ? null : t.feeAsset;
  const feeInBase = feeAsset === base;
  const feeInQuote = feeAsset === quote;
  // Fee charged in base units, expressed in quote at the execution price.
  const baseFeeInQuote = feeInBase ? fee.times(t.price) : ZERO;
  const common = {
    provider: t.provider,
    providerAccountId: t.providerAccountId,
    sourceType: "trade" as const,
    sourceKey: key,
  };

  if (t.side === "buy") {
    if (baseTracked) {
      const received = feeInBase ? t.quantity.minus(fee) : t.quantity;
      if (!received.greaterThan(0)) {
        out.warnings.push({ sourceKey: key, code: "fee_exceeds_quantity" });
      } else {
        const cost = feeInBase
          ? valuation(
              config,
              { amount: t.grossValue.minus(baseFeeInQuote), asset: quote },
              { amount: baseFeeInQuote, asset: quote },
            )
          : valuation(
              config,
              { amount: t.grossValue, asset: quote },
              feeAsset ? { amount: fee, asset: feeAsset } : null,
            );
        out.acquisitions.push({
          ...common,
          id: `${key}:base`,
          origin: "buy",
          asset: base,
          quantity: received,
          unitPrice: t.price,
          priceAsset: quote,
          cost,
          acquiredAt: t.executedAt,
        });
      }
    }
    if (quoteTracked) {
      // Paying with a crypto asset disposes of it. Its proceeds are the value of
      // what was received, known only if the base is the reporting currency.
      const paid = feeInQuote ? t.grossValue.plus(fee) : t.grossValue;
      const receivedBase = feeInBase ? t.quantity.minus(fee) : t.quantity;
      out.disposals.push({
        ...common,
        id: `${key}:quote`,
        kind: "sale",
        origin: "trade_payment",
        asset: quote,
        quantity: paid,
        unitPrice: null,
        priceAsset: null,
        proceeds: valuation(config, { amount: receivedBase, asset: base }, null),
        disposedAt: t.executedAt,
      });
    }
    return;
  }

  // SELL
  if (baseTracked) {
    const leaving = feeInBase ? t.quantity.plus(fee) : t.quantity;
    const proceeds = feeInBase
      ? valuation(
          config,
          { amount: t.grossValue.plus(baseFeeInQuote), asset: quote },
          { amount: baseFeeInQuote, asset: quote },
        )
      : valuation(
          config,
          { amount: t.grossValue, asset: quote },
          feeAsset ? { amount: fee, asset: feeAsset } : null,
        );
    out.disposals.push({
      ...common,
      id: `${key}:base`,
      kind: "sale",
      origin: "sell",
      asset: base,
      quantity: leaving,
      unitPrice: t.price,
      priceAsset: quote,
      proceeds,
      disposedAt: t.executedAt,
    });
  }
  if (quoteTracked) {
    const received = feeInQuote ? t.grossValue.minus(fee) : t.grossValue;
    if (!received.greaterThan(0)) {
      out.warnings.push({ sourceKey: key, code: "fee_exceeds_quantity" });
    } else {
      // Receiving a crypto asset from a sale acquires it; its cost is the value
      // of what was given up, known only if the base is the reporting currency.
      const given = feeInBase ? t.quantity.plus(fee) : t.quantity;
      out.acquisitions.push({
        ...common,
        id: `${key}:quote`,
        origin: "trade_proceeds",
        asset: quote,
        quantity: received,
        unitPrice: null,
        priceAsset: null,
        cost: valuation(config, { amount: given, asset: base }, null),
        acquiredAt: t.executedAt,
      });
    }
  }
}

function transferFlows(t: NormalizedTransfer, config: AccountingConfig, out: DerivedFlows): void {
  if (isCash(config, t.asset)) return;
  const key = transferKey(t);
  const feeInAsset = !t.fee.isZero() && t.feeAsset === t.asset ? t.fee : ZERO;
  const common = {
    provider: t.provider,
    providerAccountId: t.providerAccountId,
    sourceType: "transfer" as const,
    sourceKey: key,
    asset: t.asset,
    unitPrice: null,
    priceAsset: null,
  };

  if (t.direction === "in") {
    const received = t.quantity.minus(feeInAsset);
    if (!received.greaterThan(0)) {
      out.warnings.push({ sourceKey: key, code: "non_positive_quantity" });
      return;
    }
    // A deposit is NOT a buy: its cost basis is unknown until the user sets it.
    out.acquisitions.push({
      ...common,
      id: key,
      origin: t.kind,
      quantity: received,
      cost: { status: "unknown", reason: "no_acquisition_price" },
      acquiredAt: t.occurredAt,
    });
    return;
  }

  const leaving = t.quantity.plus(feeInAsset);
  if (!leaving.greaterThan(0)) {
    out.warnings.push({ sourceKey: key, code: "non_positive_quantity" });
    return;
  }
  // A withdrawal is NOT a sale: no proceeds, no realized P/L.
  out.disposals.push({
    ...common,
    id: key,
    kind: "transfer_out",
    origin: t.kind,
    quantity: leaving,
    proceeds: null,
    disposedAt: t.occurredAt,
  });
}

export function deriveAssetFlows(
  trades: readonly NormalizedTrade[],
  transfers: readonly NormalizedTransfer[],
  config: AccountingConfig,
): DerivedFlows {
  const out: DerivedFlows = { acquisitions: [], disposals: [], warnings: [] };
  for (const t of trades) tradeFlows(t, config, out);
  for (const t of transfers) transferFlows(t, config, out);
  return out;
}
