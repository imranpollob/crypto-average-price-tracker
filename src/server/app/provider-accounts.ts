import "server-only";
import { SyncService, type SyncResult } from "@/application/sync/sync-service";
import { createAccountingConfig, DEFAULT_CASH_ASSETS } from "@/domain/accounting/config";
import { deriveSyncStatus, type SyncState } from "@/domain/sync/status";
import { ledgerDataQualityFlags } from "@/domain/transactions/ledger-quality";
import { safeErrorMessage } from "@/lib/redact";
import { createDefaultRegistry } from "@/providers";
import {
  InvalidCredentialsInputError,
  type ProviderCredentials,
  type ProviderDefinition,
  type ProviderErrorCode,
  type ProviderSetupGuide,
} from "@/providers/types";
import { CredentialCipher, loadOrCreateKey } from "../credentials/cipher";
import { CredentialStore } from "../credentials/credential-store";
import { type Db, getDb } from "../db/client";
import { HistoryRepository } from "../db/history-repository";
import { PrismaSyncStore } from "../db/prisma-sync-store";
import { buildSyncDiagnostics, diagnosticsText, type SyncDiagnostics } from "../diagnostics/sync-diagnostics";

/**
 * Server-side application service for connected provider accounts. Provider
 * specifics come from the registry (e.g. src/providers/kraken); this module
 * only orchestrates. Plaintext credentials exist here only in memory while a
 * provider is built; nothing returned from this module contains them.
 */

const registry = createDefaultRegistry();
/** Reporting in USD; fee-credit assets declared by providers are not portfolio assets. */
const config = createAccountingConfig(
  "USD",
  DEFAULT_CASH_ASSETS,
  registry.list().flatMap((d) => d.feeCreditAssets ?? []),
);

function definition(providerType: string): ProviderDefinition {
  return registry.get(providerType);
}

interface AppContext {
  readonly db: Db;
  readonly repo: HistoryRepository;
  readonly credentials: CredentialStore;
  readonly syncService: SyncService;
  readonly startedAt: Date;
}

const g = globalThis as unknown as { __portfolioApp?: AppContext };

function app(): AppContext {
  if (!g.__portfolioApp) {
    const db = getDb();
    const key = loadOrCreateKey({ env: process.env["APP_ENCRYPTION_KEY"], keyFile: "./data/master.key" });
    g.__portfolioApp = {
      db,
      repo: new HistoryRepository(db),
      credentials: new CredentialStore(db, new CredentialCipher(key)),
      syncService: new SyncService({ store: new PrismaSyncStore(db), config }),
      startedAt: new Date(),
    };
  }
  return g.__portfolioApp;
}

export type ConnectionUiState =
  | "connected"
  | "invalid_credentials"
  | "missing_permission"
  | "provider_unavailable"
  | "rate_limited"
  | "dangerous_permissions"
  | "unsupported_2fa"
  | "invalid_input"
  | "failed";

export interface ConnectResult {
  readonly state: ConnectionUiState;
  readonly message: string;
  readonly warnings: readonly string[];
}

function uiState(code: ProviderErrorCode): ConnectionUiState {
  switch (code) {
    case "invalid_credentials":
      return "invalid_credentials";
    case "insufficient_permissions":
      return "missing_permission";
    case "excessive_permissions":
      return "dangerous_permissions";
    case "unsupported_authentication":
      return "unsupported_2fa";
    case "network":
    case "provider_unavailable":
      return "provider_unavailable";
    case "rate_limited":
      return "rate_limited";
    default:
      return "failed";
  }
}

/** MVP: one account per provider type. */
async function accountIdFor(providerType: string): Promise<string | null> {
  const account = await app().db.providerAccount.findFirst({
    where: { provider: { type: providerType } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return account?.id ?? null;
}

/** Validate credentials against the provider; store them (encrypted) only if they work. */
export async function connectProvider(providerType: string, input: ProviderCredentials): Promise<ConnectResult> {
  const def = definition(providerType);
  const creds = Object.fromEntries(def.credentialFields.map((f) => [f.key, (input[f.key] ?? "").trim()]));
  try {
    const probe = def.createProvider("connection-test", creds);
    const result = await probe.testConnection();
    if (!result.ok) return { state: uiState(result.code), message: result.message, warnings: [] };

    const { repo, credentials } = app();
    await repo.ensureProvider(def.type, def.kind, def.displayName);
    const accountId = (await accountIdFor(def.type)) ?? (await repo.createAccount(def.type, def.displayName));
    await credentials.save(accountId, creds);
    return { state: "connected", message: `Connected to ${def.displayName} with read-only access.`, warnings: result.warnings };
  } catch (error) {
    if (error instanceof InvalidCredentialsInputError) {
      return { state: "invalid_input", message: error.message, warnings: [] };
    }
    return { state: "failed", message: safeErrorMessage(error), warnings: [] };
  }
}

export interface SyncSummary {
  readonly ok: boolean;
  readonly message: string;
}

export async function syncProvider(providerType: string): Promise<SyncSummary> {
  const def = definition(providerType);
  const accountId = await accountIdFor(def.type);
  if (!accountId) return { ok: false, message: `${def.displayName} is not connected.` };
  const { credentials, syncService } = app();
  let result: SyncResult;
  try {
    const creds = await credentials.load(accountId);
    if (!creds) return { ok: false, message: `No ${def.displayName} credentials are stored. Connect again.` };
    result = await syncService.sync(def.createProvider(accountId, creds), "manual");
  } catch (error) {
    return { ok: false, message: safeErrorMessage(error) };
  }
  if (!result.ok) return { ok: false, message: result.errorMessage };
  const mismatches = result.reconciliation.filter((r) => r.status === "mismatch" || r.status === "review_required").length;
  return {
    ok: true,
    message:
      `Imported ${result.counts.trades.inserted} new trades, ${result.counts.ledgerEntries.inserted} ledger entries.` +
      (mismatches > 0 ? ` ${mismatches} balance mismatch(es).` : " Balances reconciled."),
  };
}

export interface ProviderStatus {
  readonly providerName: string;
  readonly setup: ProviderSetupGuide;
  readonly connected: boolean;
  readonly hasCredentials: boolean;
  readonly state: SyncState;
  readonly isCurrent: boolean;
  readonly lastSuccessfulSyncAt: string | null;
  readonly lastRun: null | {
    readonly status: string;
    readonly mode: string;
    readonly startedAt: string;
    readonly finishedAt: string | null;
    readonly syncFrom: string | null;
    readonly syncTo: string;
    readonly trades: { received: number; inserted: number };
    readonly ledger: { received: number; inserted: number };
    readonly transfers: { received: number; inserted: number };
    readonly balancesRetrieved: number;
    readonly errorCategory: string | null;
    readonly errorMessage: string | null;
  };
  readonly totals: { trades: number; ledgerEntries: number; transfers: number };
  readonly reconciliation: ReadonlyArray<{
    asset: string;
    calculated: string;
    reported: string;
    difference: string;
    status: string;
  }>;
  readonly review: ReadonlyArray<{ asset: string; detail: string }>;
}

/** Everything the status screen needs — plain serializable data, no secrets. */
export async function getProviderStatus(providerType: string): Promise<ProviderStatus> {
  const def = definition(providerType);
  const { db, repo, syncService, startedAt } = app();
  const accountId = await accountIdFor(def.type);
  const empty = {
    providerName: def.displayName,
    setup: def.setup,
    connected: false,
    hasCredentials: false,
    state: "not_connected" as SyncState,
    isCurrent: false,
    lastSuccessfulSyncAt: null,
    lastRun: null,
    totals: { trades: 0, ledgerEntries: 0, transfers: 0 },
    reconciliation: [],
    review: [],
  };
  if (!accountId) return empty;

  const account = await db.providerAccount.findUniqueOrThrow({ where: { id: accountId } });
  const [lastRun, lastSuccessRun, trades, ledgerEntries, transfers] = await Promise.all([
    db.syncRun.findFirst({ where: { providerAccountId: accountId }, orderBy: { startedAt: "desc" } }),
    db.syncRun.findFirst({
      where: { providerAccountId: accountId, status: "succeeded" },
      orderBy: { startedAt: "desc" },
      include: { reconciliations: { orderBy: { asset: "asc" } } },
    }),
    db.trade.count({ where: { providerAccountId: accountId } }),
    db.ledgerEntry.count({ where: { providerAccountId: accountId } }),
    db.transfer.count({ where: { providerAccountId: accountId } }),
  ]);
  const reconciliation = (lastSuccessRun?.reconciliations ?? []).map((r) => ({
    asset: r.asset,
    calculated: r.calculated,
    reported: r.reported,
    difference: r.difference,
    status: r.status,
  }));
  const review = ledgerDataQualityFlags(await repo.loadLedgerEntries(accountId), config).map((f) => ({
    asset: f.asset,
    detail: f.detail,
  }));

  const status = deriveSyncStatus({
    connected: account.encryptedCredentials !== null,
    running: syncService.isRunning(accountId),
    lastSuccessfulSyncAt: account.lastSuccessfulSyncAt,
    appStartedAt: startedAt,
    lastRunFailed: lastRun?.status === "failed",
    lastFailureWasNetwork: lastRun?.errorCategory === "network",
    balanceMismatch: reconciliation.some((r) => r.status === "mismatch" || r.status === "review_required"),
    reviewRequired: review.length > 0,
  });

  return {
    providerName: def.displayName,
    setup: def.setup,
    connected: true,
    hasCredentials: account.encryptedCredentials !== null,
    state: status.state,
    isCurrent: status.isCurrent,
    lastSuccessfulSyncAt: account.lastSuccessfulSyncAt?.toISOString() ?? null,
    lastRun: lastRun && {
      status: lastRun.status,
      mode: lastRun.mode,
      startedAt: lastRun.startedAt.toISOString(),
      finishedAt: lastRun.finishedAt?.toISOString() ?? null,
      syncFrom: lastRun.syncFrom?.toISOString() ?? null,
      syncTo: lastRun.syncTo.toISOString(),
      trades: { received: lastRun.tradesReceived, inserted: lastRun.tradesInserted },
      ledger: { received: lastRun.ledgerReceived, inserted: lastRun.ledgerInserted },
      transfers: { received: lastRun.transfersReceived, inserted: lastRun.transfersInserted },
      balancesRetrieved: lastRun.balancesRetrieved,
      errorCategory: lastRun.errorCategory,
      errorMessage: lastRun.errorMessage,
    },
    totals: { trades, ledgerEntries, transfers },
    reconciliation,
    review,
  };
}

/** Non-secret post-sync diagnostics for real-account validation. */
export async function getProviderDiagnostics(
  providerType: string,
): Promise<{ diagnostics: SyncDiagnostics; text: string } | null> {
  const def = definition(providerType);
  const accountId = await accountIdFor(def.type);
  if (!accountId) return null;
  const diagnostics = await buildSyncDiagnostics({ db: app().db, providerAccountId: accountId, providerName: def.displayName, config });
  return { diagnostics, text: diagnosticsText(diagnostics) };
}
