import type {
  NormalizedBalance,
  NormalizedTrade,
  NormalizedTransfer,
} from "@/domain/transactions/types";
import type { ProviderKind } from "@/providers/types";
import type { Db } from "./client";
import { rowToBalance, rowToTrade, rowToTransfer } from "./codec";

/** Provider/account bookkeeping and read access to normalized history. */
export class HistoryRepository {
  constructor(private readonly db: Db) {}

  async ensureProvider(type: string, kind: ProviderKind, name: string): Promise<string> {
    const p = await this.db.provider.upsert({
      where: { type },
      update: {},
      create: { type, kind, name },
      select: { id: true },
    });
    return p.id;
  }

  async createAccount(providerType: string, displayName: string): Promise<string> {
    const provider = await this.db.provider.findUniqueOrThrow({ where: { type: providerType } });
    const a = await this.db.providerAccount.create({
      data: { providerId: provider.id, displayName },
      select: { id: true },
    });
    return a.id;
  }

  async loadTrades(providerAccountId?: string): Promise<NormalizedTrade[]> {
    const rows = await this.db.trade.findMany({
      where: providerAccountId ? { providerAccountId } : {},
      include: { providerAccount: { include: { provider: true } } },
      orderBy: [{ executedAt: "asc" }, { externalTradeId: "asc" }],
    });
    return rows.map((r) => rowToTrade(r, r.providerAccount.provider.type));
  }

  async loadTransfers(providerAccountId?: string): Promise<NormalizedTransfer[]> {
    const rows = await this.db.transfer.findMany({
      where: providerAccountId ? { providerAccountId } : {},
      include: { providerAccount: { include: { provider: true } } },
      orderBy: [{ occurredAt: "asc" }, { externalTransferId: "asc" }],
    });
    return rows.map((r) => rowToTransfer(r, r.providerAccount.provider.type));
  }

  /** Balances captured by the latest successful sync of the account. */
  async loadLatestBalances(providerAccountId: string): Promise<NormalizedBalance[]> {
    const run = await this.db.syncRun.findFirst({
      where: { providerAccountId, status: "succeeded" },
      orderBy: { startedAt: "desc" },
      include: { balances: true, providerAccount: { include: { provider: true } } },
    });
    if (!run) return [];
    return run.balances.map((b) => rowToBalance(b, run.providerAccount.provider.type));
  }
}
