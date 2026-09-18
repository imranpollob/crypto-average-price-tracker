import type {
  NormalizedBalance,
  NormalizedLedgerEntry,
  NormalizedTrade,
  NormalizedTransfer,
} from "@/domain/transactions/types";
import {
  type ConnectionResult,
  type PortfolioProvider,
  type ProviderCapabilities,
  ProviderError,
  type SyncParams,
} from "../types";

type Operation = "testConnection" | "syncTrades" | "syncLedgerEntries" | "syncTransfers" | "getBalances";

/**
 * A scriptable provider for tests and local development. Holds records in
 * memory, honours the sync window, simulates pagination, and can be told to
 * fail specific operations to exercise recovery paths.
 */
export class InMemoryProvider implements PortfolioProvider {
  readonly capabilities: ProviderCapabilities = {
    trades: true,
    ledger: true,
    transfers: true,
    balances: true,
    marketData: false,
    liveUpdates: false,
  };

  trades: NormalizedTrade[] = [];
  ledgerEntries: NormalizedLedgerEntry[] = [];
  transfers: NormalizedTransfer[] = [];
  balances: NormalizedBalance[] = [];

  /** Records per simulated page; `pagesFetched` counts page requests. */
  pageSize = 50;
  pagesFetched = 0;
  readonly calls: Array<{ op: Operation; params?: SyncParams }> = [];
  private readonly failures = new Map<Operation, { error: Error; remaining: number }>();

  constructor(
    readonly providerAccountId: string,
    readonly type: string = "in-memory",
  ) {}

  /** Make `op` throw `error` for the next `times` calls (default: every call). */
  failOn(op: Operation, error: Error = new ProviderError("network", "Simulated network failure"), times = Infinity): this {
    this.failures.set(op, { error, remaining: times });
    return this;
  }

  clearFailures(): this {
    this.failures.clear();
    return this;
  }

  private enter(op: Operation, params?: SyncParams): void {
    this.calls.push({ op, params });
    const f = this.failures.get(op);
    if (f && f.remaining > 0) {
      f.remaining -= 1;
      throw f.error;
    }
  }

  private window<T>(records: T[], at: (r: T) => Date, params: SyncParams): T[] {
    const inWindow = records.filter((r) => !params.since || at(r).getTime() >= params.since.getTime());
    this.pagesFetched += Math.max(1, Math.ceil(inWindow.length / this.pageSize));
    return [...inWindow];
  }

  async testConnection(): Promise<ConnectionResult> {
    this.enter("testConnection");
    return { ok: true, accountLabel: this.providerAccountId, warnings: [] };
  }

  async syncTrades(params: SyncParams): Promise<NormalizedTrade[]> {
    this.enter("syncTrades", params);
    return this.window(this.trades, (t) => t.executedAt, params);
  }

  async syncLedgerEntries(params: SyncParams): Promise<NormalizedLedgerEntry[]> {
    this.enter("syncLedgerEntries", params);
    return this.window(this.ledgerEntries, (e) => e.occurredAt, params);
  }

  async syncTransfers(params: SyncParams): Promise<NormalizedTransfer[]> {
    this.enter("syncTransfers", params);
    return this.window(this.transfers, (t) => t.occurredAt, params);
  }

  async getBalances(): Promise<NormalizedBalance[]> {
    this.enter("getBalances");
    return [...this.balances];
  }
}
