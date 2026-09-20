"use server";

import "server-only";
import { revalidatePath } from "next/cache";
import { pollStatus, syncNow } from "@/server/app/portfolio";
import { connectProvider, type ConnectResult, type SyncSummary } from "@/server/app/provider-accounts";

/** The MVP screen manages the Kraken account; the services themselves are provider-agnostic. */
const PROVIDER = "kraken";

/**
 * Server actions. Credentials arrive in the form POST, are validated and
 * encrypted server-side, and are never sent back to the browser.
 */

export type ConnectActionState = ConnectResult | null;

export async function connectKrakenAction(_prev: ConnectActionState, form: FormData): Promise<ConnectActionState> {
  const credentials: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    // Skip React's internal "$ACTION_…" fields; the service keeps only declared credential fields.
    if (typeof value === "string" && !key.startsWith("$")) credentials[key] = value;
  }
  const result = await connectProvider(PROVIDER, credentials);
  if (result.state === "connected") revalidatePath("/", "layout");
  return result;
}

export type SyncActionState = SyncSummary | null;

/** Account sync + reconciliation → lot rebuild → prices. Joins a sync that is already running. */
export async function syncNowAction(_prev: SyncActionState): Promise<SyncActionState> {
  const outcome = await syncNow();
  revalidatePath("/", "layout");
  return { ok: outcome.ok, message: outcome.message };
}

/** Client poller: refreshes prices when due (never account history) and reports what changed. */
export async function pollAction(): Promise<{ stamp: string; syncing: boolean }> {
  return pollStatus();
}
