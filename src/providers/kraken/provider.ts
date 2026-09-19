import { Decimal } from "@/domain/decimal";
import type {
  AssetCode,
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
import type { KrakenClient } from "./client";
import type { KrakenAssetMapper } from "./mapper";
import { normalizeBalances, PROVIDER_TYPE, toKrakenSeconds } from "./normalizer";
import { assessPermissions, parseKeyInfo, permissionError, READ_ONLY_NOTICE } from "./permissions";
import { fetchBalance } from "./rest";
import { fetchKrakenHistory, type KrakenHistory, loadAssetMapper } from "./sync";

export const PERMISSION_WARNING =
  `${READ_ONLY_NOTICE} Keys that can trade, move funds, allocate Earn or change withdrawal addresses are refused.`;

const UNVERIFIED_PERMISSIONS =
  "Kraken did not return this key's permissions, so the absence of trading or withdrawal permissions could not be verified. Make sure the key is read-only.";

/**
 * Kraken implementation of PortfolioProvider. Everything Kraken-specific stays
 * behind this class; it returns only normalized records.
 */
export class KrakenProvider implements PortfolioProvider {
  readonly type = PROVIDER_TYPE;
  readonly capabilities: ProviderCapabilities = {
    trades: true,
    ledger: true,
    transfers: true,
    balances: true,
    marketData: false,
    liveUpdates: false,
  };

  private mapper: Promise<KrakenAssetMapper> | null = null;
  private readonly histories = new Map<string, Promise<KrakenHistory>>();

  constructor(
    readonly providerAccountId: string,
    private readonly client: KrakenClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  toJSON(): string {
    return `[KrakenProvider ${this.providerAccountId}]`;
  }

  /**
   * Validate the key with GetApiKeyInfo (requires no permission): the key must
   * have the three read permissions we use, and must not have any permission
   * that can change the account. Only the permission list and restriction
   * timestamps are read; the returned key string and IBAN are discarded.
   *
   * If Kraken does not support GetApiKeyInfo for this key, fall back to probing
   * the three endpoints and warn that dangerous permissions could not be ruled out.
   */
  async testConnection(): Promise<ConnectionResult> {
    try {
      let result: unknown;
      try {
        result = await this.client.privatePost("GetApiKeyInfo");
      } catch (error) {
        // Endpoint unsupported (unknown method / rejected arguments), not auth or nonce problems.
        if (error instanceof ProviderError && (error.code === "unknown" || (error.code === "invalid_request" && !error.retryable))) {
          return await this.probeEndpoints();
        }
        throw error;
      }
      const assessment = assessPermissions(parseKeyInfo(result), toKrakenSeconds(this.now()));
      const refusal = permissionError(assessment);
      if (refusal) return { ok: false, code: refusal.code, message: refusal.message };
      return { ok: true, accountLabel: null, warnings: assessment.warnings };
    } catch (error) {
      if (error instanceof ProviderError) return { ok: false, code: error.code, message: error.message };
      return { ok: false, code: "unknown", message: "Unexpected error while testing the Kraken connection" };
    }
  }

  /** Fallback: prove each read permission by calling Balance, TradesHistory and Ledgers over one minute. */
  private async probeEndpoints(): Promise<ConnectionResult> {
    await fetchBalance(this.client);
    const end = toKrakenSeconds(this.now());
    const tiny = { start: end - 60, end, without_count: true };
    await this.client.privatePost("TradesHistory", { ...tiny, limit: 1 });
    await this.client.privatePost("Ledgers", tiny);
    return { ok: true, accountLabel: null, warnings: [READ_ONLY_NOTICE, UNVERIFIED_PERMISSIONS] };
  }

  async syncTrades(params: SyncParams): Promise<NormalizedTrade[]> {
    return (await this.history(params)).trades;
  }

  async syncLedgerEntries(params: SyncParams): Promise<NormalizedLedgerEntry[]> {
    return (await this.history(params)).ledgerEntries;
  }

  async syncTransfers(params: SyncParams): Promise<NormalizedTransfer[]> {
    return (await this.history(params)).transfers;
  }

  async getBalances(): Promise<NormalizedBalance[]> {
    const mapper = await this.assetMapper();
    const result = await fetchBalance(this.client);
    return normalizeBalances({ result, mapper, providerAccountId: this.providerAccountId, asOf: this.now() });
  }

  /** Smallest representable unit per canonical asset, per Kraken's own Assets metadata. */
  async getReconciliationTolerance(): Promise<ReadonlyMap<AssetCode, { readonly tolerance: Decimal; readonly precision: number }>> {
    const mapper = await this.assetMapper();
    return new Map(
      [...mapper.assetPrecision()].map(([asset, decimals]) => [asset, { tolerance: new Decimal(10).pow(-decimals), precision: decimals }]),
    );
  }

  private assetMapper(): Promise<KrakenAssetMapper> {
    this.mapper ??= loadAssetMapper(this.client).catch((e) => {
      this.mapper = null;
      throw e;
    });
    return this.mapper;
  }

  /** Trades, ledger and transfers share one download per window. */
  private history(params: SyncParams): Promise<KrakenHistory> {
    const key = `${params.since?.getTime() ?? "all"}-${params.until.getTime()}`;
    let pending = this.histories.get(key);
    if (!pending) {
      pending = this.assetMapper()
        .then((mapper) =>
          fetchKrakenHistory({
            client: this.client,
            mapper,
            providerAccountId: this.providerAccountId,
            window: { since: params.since, until: params.until },
          }),
        )
        .catch((e) => {
          this.histories.delete(key);
          throw e;
        });
      this.histories.set(key, pending);
    }
    return pending;
  }
}
