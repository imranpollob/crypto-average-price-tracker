"use server";

import "server-only";
import { revalidatePath } from "next/cache";
import { safeErrorMessage } from "@/lib/redact";
import { describeProblem, LotMatchError, type MatchPreview, ValuationInputError } from "@/server/app/lot-service";
import {
  clearLotValuation,
  deleteLotMatch,
  editLotMatch,
  previewLotMatch,
  saveLotMatch,
  setLotValuation,
} from "@/server/app/lots";
import { shortId } from "../format";

/**
 * Lot review actions. Every decision is validated by the lot engine on the
 * server; nothing is persisted by "Preview". All arithmetic happens server-side.
 */

export type MatchActionState =
  | { readonly kind: "preview"; readonly preview: MatchPreview }
  | { readonly kind: "saved"; readonly message: string }
  | { readonly kind: "error"; readonly messages: readonly string[] }
  | null;

export type SimpleActionState = { readonly ok: boolean; readonly message: string } | null;

const QTY_PREFIX = "qty:";

function shortLot(id: string | null): string {
  return id ? `Lot ${shortId(id)}: ` : "";
}

function errorMessages(error: unknown): string[] {
  if (error instanceof LotMatchError) return error.problems.map((p) => shortLot(p.lotId) + describeProblem(p.problem));
  if (error instanceof ValuationInputError) return [error.message];
  return [safeErrorMessage(error)];
}

/** A lot decision changes the portfolio figures everywhere, not only on the lot pages. */
function refresh(_asset: string) {
  revalidatePath("/", "layout");
}

export async function matchAction(asset: string, disposalId: string, _prev: MatchActionState, form: FormData): Promise<MatchActionState> {
  const allocations: { lotId: string; quantity: string }[] = [];
  for (const [key, value] of form.entries()) {
    if (key.startsWith(QTY_PREFIX) && typeof value === "string" && value.trim() !== "") {
      allocations.push({ lotId: key.slice(QTY_PREFIX.length), quantity: value.trim() });
    }
  }
  try {
    if (form.get("intent") === "save") {
      await saveLotMatch(disposalId, allocations);
      refresh(asset);
      return { kind: "saved", message: "Lot match saved." };
    }
    return { kind: "preview", preview: await previewLotMatch(disposalId, allocations) };
  } catch (error) {
    return { kind: "error", messages: errorMessages(error) };
  }
}

export async function editMatchAction(asset: string, matchId: string, _prev: SimpleActionState, form: FormData): Promise<SimpleActionState> {
  try {
    if (form.get("intent") === "delete") {
      await deleteLotMatch(matchId);
      refresh(asset);
      return { ok: true, message: "Match removed; the lot quantity is open again." };
    }
    await editLotMatch(matchId, String(form.get("lotId") ?? ""), String(form.get("quantity") ?? "").trim());
    refresh(asset);
    return { ok: true, message: "Match updated." };
  } catch (error) {
    return { ok: false, message: errorMessages(error).join(" ") };
  }
}

export async function valuationAction(
  asset: string,
  targetType: "acquisition" | "disposal",
  targetKey: string,
  _prev: SimpleActionState,
  form: FormData,
): Promise<SimpleActionState> {
  try {
    if (form.get("intent") === "clear") {
      await clearLotValuation(targetType, targetKey);
      refresh(asset);
      return { ok: true, message: "Manual value removed." };
    }
    const note = String(form.get("note") ?? "").trim();
    await setLotValuation(targetType, targetKey, String(form.get("gross") ?? "").trim(), String(form.get("fee") ?? ""), note || null);
    refresh(asset);
    return { ok: true, message: "Saved." };
  } catch (error) {
    return { ok: false, message: errorMessages(error).join(" ") };
  }
}
