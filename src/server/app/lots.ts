import "server-only";
import { getDb } from "../db/client";
import type { ValuationTargetType } from "../db/lot-repository";
import { type AllocationInput, type AssetDetail, type AssetSummary, LotService, type MatchPreview } from "./lot-service";
import { accountIdFor, config } from "./provider-accounts";

/** Server-side entry points for the lot review screen (MVP: the Kraken account). */

const PROVIDER = "kraken";

const g = globalThis as unknown as { __lotService?: LotService };

export function lotService(): LotService {
  g.__lotService ??= new LotService(getDb(), config);
  return g.__lotService;
}

async function account(): Promise<string> {
  const id = await accountIdFor(PROVIDER);
  if (!id) throw new Error("Kraken is not connected.");
  return id;
}

export async function lotSummaries(): Promise<AssetSummary[] | null> {
  const id = await accountIdFor(PROVIDER);
  return id ? lotService().summaries(id) : null;
}

export async function lotAssetDetail(asset: string): Promise<AssetDetail | null> {
  const id = await accountIdFor(PROVIDER);
  return id ? lotService().assetDetail(id, asset) : null;
}

export async function previewLotMatch(disposalId: string, allocations: readonly AllocationInput[]): Promise<MatchPreview> {
  return lotService().preview(await account(), disposalId, allocations);
}

export async function saveLotMatch(disposalId: string, allocations: readonly AllocationInput[]): Promise<void> {
  await lotService().saveMatches(await account(), disposalId, allocations);
}

export async function editLotMatch(matchId: string, lotId: string, quantity: string): Promise<void> {
  await lotService().editMatch(await account(), matchId, lotId, quantity);
}

export async function deleteLotMatch(matchId: string): Promise<void> {
  await lotService().deleteMatch(await account(), matchId);
}

export async function setLotValuation(type: ValuationTargetType, key: string, gross: string, fee: string, note: string | null): Promise<void> {
  await lotService().setValuation(await account(), { type, key }, gross, fee, note);
}

export async function clearLotValuation(type: ValuationTargetType, key: string): Promise<void> {
  await lotService().clearValuation(await account(), { type, key });
}
