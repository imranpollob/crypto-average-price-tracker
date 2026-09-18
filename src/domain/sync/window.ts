/** Re-fetch this much history before the last successful sync to catch late-arriving records. */
export const DEFAULT_SYNC_OVERLAP_MS = 5 * 60 * 1000;

export interface SyncWindow {
  readonly mode: "initial" | "incremental";
  /** Fetch records at or after this time; null means full history. */
  readonly since: Date | null;
  /**
   * Fixed end of the window, recorded before fetching begins. On success this
   * becomes the new last_successful_sync_at. Records newer than this may still
   * be fetched; idempotent upserts make that harmless.
   */
  readonly until: Date;
}

export function planSyncWindow(params: {
  readonly lastSuccessfulSyncAt: Date | null;
  readonly now: Date;
  readonly overlapMs?: number;
}): SyncWindow {
  const overlap = params.overlapMs ?? DEFAULT_SYNC_OVERLAP_MS;
  if (overlap < 0) throw new Error("Sync overlap must not be negative");
  const until = new Date(params.now.getTime());
  if (!params.lastSuccessfulSyncAt) return { mode: "initial", since: null, until };
  // Guard against a clock that moved backwards since the last sync.
  const anchor = Math.min(params.lastSuccessfulSyncAt.getTime(), until.getTime());
  return { mode: "incremental", since: new Date(anchor - overlap), until };
}
