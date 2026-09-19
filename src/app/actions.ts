"use server";

import "server-only";
import { revalidatePath } from "next/cache";
import { connectProvider, type ConnectResult, syncProvider, type SyncSummary } from "@/server/app/provider-accounts";

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
  if (result.state === "connected") revalidatePath("/");
  return result;
}

export type SyncActionState = SyncSummary | null;

export async function syncNowAction(_prev: SyncActionState): Promise<SyncActionState> {
  const result = await syncProvider(PROVIDER);
  revalidatePath("/");
  return result;
}
