import type { Decimal } from "@/domain/decimal";
import type {
  AssetCode,
  AssetPair,
  NormalizedBalance,
  NormalizedLedgerEntry,
  NormalizedTrade,
  NormalizedTransfer,
  PriceQuote,
  ProviderType,
} from "@/domain/transactions/types";

/**
 * Provider (exchange / wallet) abstraction.
 *
 * An adapter's only job is to talk to its source and return normalized records.
 * Provider-specific formats, asset codes, pagination and rate limits never leave
 * the adapter. The sync service, lot engine and UI depend only on this file and
 * on domain/transactions/types.
 *
 * Adapters must:
 *  - be read-only (never place/cancel orders, never move funds);
 *  - never log or return credentials;
 *  - fully paginate within the requested window before returning;
 *  - return stable external ids, so repeated fetches are idempotent;
 *  - throw ProviderError (never return partial data) on failure.
 */

export type ProviderKind = "exchange" | "wallet";

export interface ProviderCapabilities {
  readonly trades: boolean;
  readonly ledger: boolean;
  readonly transfers: boolean;
  readonly balances: boolean;
  readonly marketData: boolean;
  readonly liveUpdates: boolean;
}

export interface SyncParams {
  /** Inclusive lower bound; null means "all available history". */
  readonly since: Date | null;
  /** Upper bound for the window (adapters may return slightly newer records). */
  readonly until: Date;
  readonly signal?: AbortSignal;
}

export type ProviderErrorCode =
  | "network"
  | "rate_limited"
  | "invalid_credentials"
  /** e.g. API-key 2FA (OTP), which the MVP does not support */
  | "unsupported_authentication"
  | "insufficient_permissions"
  | "excessive_permissions"
  | "invalid_response"
  | "invalid_request"
  | "provider_unavailable"
  | "unknown";

/** Adapter failure. `message` must be safe to show and log (no secrets). */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryable: boolean = code === "network" || code === "rate_limited" || code === "provider_unavailable",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ConnectionResult =
  | { readonly ok: true; readonly accountLabel: string | null; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly code: ProviderErrorCode; readonly message: string };

/** Account-data source: everything needed to rebuild the portfolio from history. */
export interface PortfolioProvider {
  readonly type: ProviderType;
  readonly providerAccountId: string;
  readonly capabilities: ProviderCapabilities;

  /** Validate credentials and that they are read-only. */
  testConnection(): Promise<ConnectionResult>;
  /** Spot trade executions in the window. [] if unsupported. */
  syncTrades(params: SyncParams): Promise<NormalizedTrade[]>;
  /** Raw ledger lines in the window, for audit/reconciliation. [] if unsupported. */
  syncLedgerEntries(params: SyncParams): Promise<NormalizedLedgerEntry[]>;
  /** Deposits, withdrawals, rewards, transfers in the window. */
  syncTransfers(params: SyncParams): Promise<NormalizedTransfer[]>;
  /** Current provider-reported balances. */
  getBalances(): Promise<NormalizedBalance[]>;
  /**
   * Optional: absolute per-asset reconciliation tolerance derived from the
   * provider's own smallest representable unit (e.g. decimal precision),
   * used to classify a negligible reconciliation difference instead of an
   * arbitrary global tolerance. Omitted entirely if unsupported.
   */
  getReconciliationTolerance?(): Promise<ReadonlyMap<AssetCode, { readonly tolerance: Decimal; readonly precision: number }>>;
}

/** Market-data source. May be the same object as a PortfolioProvider (e.g. Kraken). */
export interface MarketDataProvider {
  readonly source: ProviderType;
  getCurrentPrices(pairs: readonly AssetPair[]): Promise<PriceQuote[]>;
}

/** Real-time events. Freshness only — REST sync remains the source of correctness. */
export type LiveEvent =
  | { readonly type: "trade"; readonly trade: NormalizedTrade }
  | { readonly type: "price"; readonly quote: PriceQuote }
  | { readonly type: "connected" }
  /** After a reconnect, the app must run a REST reconciliation sync. */
  | { readonly type: "reconnected" }
  | { readonly type: "disconnected"; readonly reason: string };

export interface LiveFeed {
  start(onEvent: (event: LiveEvent) => void): Promise<void>;
  stop(): Promise<void>;
}

/** Describes a credential field for the connection form. Values never reach the client. */
export interface CredentialField {
  readonly key: string;
  readonly label: string;
  readonly secret: boolean;
}

export type ProviderCredentials = Readonly<Record<string, string>>;

/** What the user must configure at the provider, shown on the connection screen. */
export interface ProviderSetupGuide {
  readonly requiredPermissions: readonly string[];
  /** Allowed, not needed yet. */
  readonly optionalPermissions: readonly string[];
  /** Keys with any of these are refused. */
  readonly forbiddenPermissions: readonly string[];
  /** Always-shown security caveat (e.g. permissions cannot be verified). */
  readonly securityNote: string;
}

/** Registration entry for one provider implementation. */
export interface ProviderDefinition {
  readonly type: ProviderType;
  readonly displayName: string;
  readonly kind: ProviderKind;
  readonly credentialFields: readonly CredentialField[];
  readonly setup: ProviderSetupGuide;
  /** Provider-internal fee-credit assets (not portfolio assets), canonical codes. */
  readonly feeCreditAssets?: readonly AssetCode[];
  /** Throws InvalidCredentialsInputError when the credentials are malformed. */
  createProvider(providerAccountId: string, credentials: ProviderCredentials): PortfolioProvider;
  createMarketData?(): MarketDataProvider;
  createLiveFeed?(providerAccountId: string, credentials: ProviderCredentials): LiveFeed;
}

/** Credentials that are syntactically unusable (checked before any network call). */
export class InvalidCredentialsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCredentialsInputError";
  }
}
