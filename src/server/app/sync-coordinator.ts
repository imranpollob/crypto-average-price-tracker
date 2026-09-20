import type { SyncResult, SyncService } from "@/application/sync/sync-service";
import type { AssetCode } from "@/domain/transactions/types";
import type { PortfolioProvider } from "@/providers/types";
import type { LotService } from "./lot-service";
import type { PriceRefreshOutcome, PriceService } from "./price-service";

/**
 * Account refresh = private REST sync (with reconciliation) → lot rebuild →
 * price refresh. Runs once automatically per app process (startup recovery)
 * and on "Sync now". Only one runs at a time: a second request joins the
 * running one. Price refreshes on their own never go through here.
 */

export interface AccountSource {
  /** The connected account (MVP: one), or null. */
  accountId(): Promise<string | null>;
  /** A provider for it, or null when no credentials are stored. */
  provider(accountId: string): Promise<PortfolioProvider | null>;
}

export interface RefreshOutcome {
  readonly kind: "startup" | "manual";
  readonly ok: boolean;
  readonly message: string;
  readonly finishedAt: Date;
  readonly sync: SyncResult | null;
  readonly prices: PriceRefreshOutcome | null;
}

export interface SyncCoordinatorDeps {
  readonly syncService: SyncService;
  readonly lots: LotService;
  readonly prices: PriceService;
  readonly accounts: AccountSource;
  readonly heldAssets: (accountId: string) => Promise<AssetCode[]>;
  readonly now?: () => Date;
}

export class SyncCoordinator {
  private running: Promise<RefreshOutcome> | null = null;
  private startupStarted = false;
  private last: RefreshOutcome | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: SyncCoordinatorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  lastOutcome(): RefreshOutcome | null {
    return this.last;
  }

  /** True until the startup recovery has been started in this process. */
  startupPending(): boolean {
    return !this.startupStarted;
  }

  /** Startup recovery sync: started at most once per process. */
  startup(): Promise<RefreshOutcome> {
    if (!this.startupStarted) {
      this.startupStarted = true;
      return this.run("startup");
    }
    return this.running ?? Promise.resolve(this.last ?? this.idle("startup"));
  }

  /** Manual "Sync now". Joins a refresh already in progress instead of starting a second one. */
  syncNow(): Promise<RefreshOutcome> {
    this.startupStarted = true;
    return this.run("manual");
  }

  private run(kind: RefreshOutcome["kind"]): Promise<RefreshOutcome> {
    this.running ??= this.execute(kind)
      .catch((error: unknown): RefreshOutcome => ({
        kind,
        ok: false,
        message: error instanceof Error ? error.message : "Refresh failed",
        finishedAt: this.now(),
        sync: null,
        prices: null,
      }))
      .then((outcome) => {
        this.last = outcome;
        return outcome;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async execute(kind: RefreshOutcome["kind"]): Promise<RefreshOutcome> {
    const { syncService, lots, prices, accounts } = this.deps;
    const accountId = await accounts.accountId();
    if (!accountId) return { ...this.idle(kind), message: "Not connected." };
    const provider = await accounts.provider(accountId);
    if (!provider) return { ...this.idle(kind), message: "No stored credentials. Connect again." };

    const sync = kind === "startup" ? await syncService.recoverOnStartup(provider) : await syncService.sync(provider, "manual");
    // Stored history stays valid when a sync fails, so lots and prices are
    // still refreshed (prices come from public endpoints and may still work).
    await lots.rebuild(accountId);
    const priceOutcome = await prices.refresh(await this.deps.heldAssets(accountId));

    const message = sync.ok
      ? `Synced: ${sync.counts.trades.inserted} new trades, ${sync.counts.ledgerEntries.inserted} new ledger entries.`
      : `Kraken sync failed: ${sync.errorMessage}`;
    return { kind, ok: sync.ok, message, finishedAt: this.now(), sync, prices: priceOutcome };
  }

  private idle(kind: RefreshOutcome["kind"]): RefreshOutcome {
    return { kind, ok: false, message: "No sync has run yet.", finishedAt: this.now(), sync: null, prices: null };
  }
}
