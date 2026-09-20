import "server-only";
import type { AutomaticMatchingMethod } from "@/domain/lots/automatic-matching";
import type { SyncState } from "@/domain/sync/status";
import type { AssetDetail } from "./lot-service";
import { lotAssetDetail, lotService } from "./lots";
import { type AssetPortfolioView, type PortfolioView, PortfolioService } from "./portfolio-service";
import { PriceService } from "./price-service";
import { accountIdFor, app, config, getProviderStatus, type ProviderStatus, registry } from "./provider-accounts";
import { SettingsService } from "./settings-service";
import { type RefreshOutcome, SyncCoordinator } from "./sync-coordinator";

/**
 * Server entry points for the portfolio screens. Account data and prices are
 * separate: account sync (startup + "Sync now") pulls private history; prices
 * refresh on their own from public market data.
 */

const PROVIDER = "kraken";
/** Prices older than this are refreshed when the dashboard is viewed or polled. */
export const PRICE_REFRESH_MS = 30_000;

interface PortfolioContext {
  readonly settings: SettingsService;
  readonly prices: PriceService;
  readonly portfolio: PortfolioService;
  readonly coordinator: SyncCoordinator;
}

const g = globalThis as unknown as { __portfolioContext?: PortfolioContext };

function ctx(): PortfolioContext {
  if (!g.__portfolioContext) {
    const { db, credentials, syncService } = app();
    const def = registry.get(PROVIDER);
    const prices = new PriceService(db, def.createMarketData?.() ?? null, config.reportingCurrency);
    const lots = lotService();
    const settings = new SettingsService(db);
    const portfolio = new PortfolioService(db, config, lots, prices, settings);
    const coordinator = new SyncCoordinator({
      syncService,
      lots,
      prices,
      heldAssets: (id) => portfolio.heldAssets(id),
      accounts: {
        accountId: () => accountIdFor(PROVIDER),
        provider: async (id) => {
          const creds = await credentials.load(id);
          return creds ? def.createProvider(id, creds) : null;
        },
      },
    });
    g.__portfolioContext = { settings, prices, portfolio, coordinator };
  }
  return g.__portfolioContext;
}

export interface AccountStatus {
  readonly provider: ProviderStatus;
  readonly state: SyncState;
  /** Account data refreshed during this app session (stale data is never presented as current). */
  readonly isCurrent: boolean;
  readonly syncing: boolean;
  readonly lastSuccessfulSyncAt: string | null;
  readonly lastError: string | null;
  readonly pricesUpdatedAt: string | null;
  readonly priceError: string | null;
  /** Changes whenever account data or prices change; the client refreshes the page on change. */
  readonly stamp: string;
}

async function accountStatus(): Promise<AccountStatus> {
  const { prices, coordinator } = ctx();
  const provider = await getProviderStatus(PROVIDER);
  const syncing = coordinator.isRunning() || (provider.connected && provider.hasCredentials && coordinator.startupPending());
  const pricesUpdatedAt = (await prices.updatedAt())?.toISOString() ?? null;
  const lastPrice = prices.lastRefresh();
  const state: SyncState = syncing ? (provider.lastSuccessfulSyncAt ? "syncing" : "initial_sync") : provider.state;
  return {
    provider,
    state,
    isCurrent: provider.isCurrent && !syncing,
    syncing,
    lastSuccessfulSyncAt: provider.lastSuccessfulSyncAt,
    lastError: provider.lastRun?.status === "failed" ? provider.lastRun.errorMessage : null,
    pricesUpdatedAt,
    priceError: lastPrice && !lastPrice.ok ? lastPrice.error : null,
    stamp: [provider.lastSuccessfulSyncAt, provider.lastRun?.startedAt, pricesUpdatedAt, syncing].join("|"),
  };
}

/** Starts the startup recovery sync (once per process) without waiting for it. */
function kickStartup(status: AccountStatus): void {
  const { coordinator } = ctx();
  if (status.provider.connected && status.provider.hasCredentials && coordinator.startupPending()) {
    void coordinator.startup();
  }
}

export interface Dashboard {
  readonly status: AccountStatus;
  readonly portfolio: PortfolioView | null;
}

export async function getDashboard(): Promise<Dashboard> {
  const status = await accountStatus();
  kickStartup(status);
  const id = await accountIdFor(PROVIDER);
  if (!id) return { status, portfolio: null };
  const { portfolio, prices } = ctx();
  const view = await portfolio.compute(id);
  // Show cached prices now; fetch fresh ones in the background.
  if (!status.syncing) void prices.refreshIfOlderThan(view.positions.map((p) => p.asset), PRICE_REFRESH_MS);
  return { status, portfolio: view };
}

export async function getAssetPage(asset: string): Promise<{ status: AccountStatus; view: AssetPortfolioView | null; lots: AssetDetail | null }> {
  const status = await accountStatus();
  kickStartup(status);
  const id = await accountIdFor(PROVIDER);
  if (!id) return { status, view: null, lots: null };
  const [view, lots] = await Promise.all([ctx().portfolio.asset(id, asset), lotAssetDetail(asset)]);
  return { status, view, lots };
}

/** For the client poller: refresh prices if due (never an account sync), then report the stamp. */
export async function pollStatus(): Promise<{ stamp: string; syncing: boolean }> {
  const before = await accountStatus();
  kickStartup(before);
  const id = await accountIdFor(PROVIDER);
  if (id && !before.syncing) {
    const { portfolio, prices } = ctx();
    await prices.refreshIfOlderThan(await portfolio.heldAssets(id), PRICE_REFRESH_MS);
  }
  const after = await accountStatus();
  return { stamp: after.stamp, syncing: after.syncing };
}

export async function getAccountStatus(): Promise<AccountStatus> {
  const status = await accountStatus();
  kickStartup(status);
  return status;
}

/** "Sync now": private sync + reconciliation → lot rebuild → prices. Joins a running refresh. */
export async function syncNow(): Promise<RefreshOutcome> {
  return ctx().coordinator.syncNow();
}

export async function getAutomaticLotMatchingMethod(): Promise<AutomaticMatchingMethod> {
  return ctx().settings.automaticLotMatchingMethod();
}

/**
 * Change the method used for unassigned quantity. Only derived figures change:
 * no sync, no change to imported history or to saved manual lot matches. The
 * portfolio is computed from the setting on every read, so it applies at once.
 */
export async function setAutomaticLotMatchingMethod(method: AutomaticMatchingMethod): Promise<void> {
  await ctx().settings.setAutomaticLotMatchingMethod(method);
}
