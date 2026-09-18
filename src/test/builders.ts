import { type AccountingConfig, createAccountingConfig } from "@/domain/accounting/config";
import { type Decimal, dec } from "@/domain/decimal";
import { runLotEngine } from "@/domain/lots/engine";
import { deriveAssetFlows } from "@/domain/lots/flows";
import type { LotEngineResult, LotMatchInstruction, ManualValuation } from "@/domain/lots/types";
import { calculatePositionMetrics, type PositionMetrics } from "@/domain/pnl/position";
import { tradeKey, transferKey } from "@/domain/transactions/identity";
import type {
  NormalizedTrade,
  NormalizedTransfer,
  TradeSide,
  TransferKind,
} from "@/domain/transactions/types";

/** Test data builders. All amounts are strings — never floats. */

export const ACCOUNT = "acct-1";
export const PROVIDER = "test";
const T0 = Date.parse("2026-01-01T00:00:00Z");

/** Deterministic timestamps: day n after 2026-01-01. */
export const day = (n: number): Date => new Date(T0 + n * 86_400_000);

let seq = 0;
let clock = 0;
/** Default event times strictly increase in creation order. */
const tick = () => day(++clock);
const nextId = (prefix: string) => `${prefix}${String(++seq).padStart(4, "0")}`;

interface TradeOpts {
  base?: string;
  quote?: string;
  fee?: string;
  feeAsset?: string;
  at?: Date;
  id?: string;
  account?: string;
}

export function trade(side: TradeSide, qty: string, price: string, o: TradeOpts = {}): NormalizedTrade {
  const quote = o.quote ?? "USD";
  const quantity = dec(qty);
  const p = dec(price);
  return {
    provider: PROVIDER,
    providerAccountId: o.account ?? ACCOUNT,
    externalTradeId: o.id ?? nextId("T"),
    externalOrderId: null,
    baseAsset: o.base ?? "ADA",
    quoteAsset: quote,
    side,
    quantity,
    price: p,
    grossValue: quantity.times(p),
    fee: dec(o.fee ?? "0"),
    feeAsset: o.fee ? (o.feeAsset ?? quote) : null,
    executedAt: o.at ?? tick(),
    rawData: { test: true },
  };
}

export const buy = (qty: string, price: string, o?: TradeOpts) => trade("buy", qty, price, o);
export const sell = (qty: string, price: string, o?: TradeOpts) => trade("sell", qty, price, o);

interface TransferOpts {
  fee?: string;
  at?: Date;
  id?: string;
  account?: string;
  kind?: TransferKind;
}

export function transfer(direction: "in" | "out", asset: string, qty: string, o: TransferOpts = {}): NormalizedTransfer {
  return {
    provider: PROVIDER,
    providerAccountId: o.account ?? ACCOUNT,
    externalTransferId: o.id ?? nextId("X"),
    direction,
    kind: o.kind ?? (direction === "in" ? "deposit" : "withdrawal"),
    asset,
    quantity: dec(qty),
    fee: dec(o.fee ?? "0"),
    feeAsset: o.fee ? asset : null,
    occurredAt: o.at ?? tick(),
    txHash: null,
    rawData: { test: true },
  };
}

export const deposit = (asset: string, qty: string, o?: TransferOpts) => transfer("in", asset, qty, o);
export const withdrawal = (asset: string, qty: string, o?: TransferOpts) => transfer("out", asset, qty, o);

type Source = NormalizedTrade | NormalizedTransfer;

const keyOf = (s: Source) => ("externalTradeId" in s ? tradeKey(s) : transferKey(s));

/** Lot id / disposal id of the base leg of a trade, or of a transfer. */
export function flowId(s: Source, leg: "base" | "quote" = "base"): string {
  return "externalTradeId" in s ? `${keyOf(s)}:${leg}` : keyOf(s);
}

/** Match instruction: close `qty` of the lot created by `lot` with disposal `disposal`. */
export function match(disposal: Source, lot: Source, qty: string, id?: string): LotMatchInstruction {
  return { id: id ?? nextId("M"), disposalId: flowId(disposal), lotId: flowId(lot), quantity: dec(qty) };
}

export function valuation(target: Source, gross: string, fee = "0", leg: "base" | "quote" = "base"): ManualValuation {
  return { targetId: flowId(target, leg), gross: dec(gross), fee: dec(fee) };
}

export interface Scenario {
  readonly engine: LotEngineResult;
  position(asset?: string, price?: string | null): PositionMetrics;
}

export function scenario(params: {
  trades?: NormalizedTrade[];
  transfers?: NormalizedTransfer[];
  matches?: LotMatchInstruction[];
  valuations?: ManualValuation[];
  config?: AccountingConfig;
}): Scenario {
  const config = params.config ?? createAccountingConfig("USD");
  const flows = deriveAssetFlows(params.trades ?? [], params.transfers ?? [], config);
  const engine = runLotEngine({
    acquisitions: flows.acquisitions,
    disposals: flows.disposals,
    matches: params.matches ?? [],
    manualValuations: params.valuations ?? [],
  });
  return {
    engine,
    position: (asset = "ADA", price: string | null = null) =>
      calculatePositionMetrics(engine, asset, price === null ? null : dec(price)),
  };
}

/** Assert-friendly string of a Decimal (canonical, no exponent). */
export const s = (d: Decimal): string => d.toFixed();
