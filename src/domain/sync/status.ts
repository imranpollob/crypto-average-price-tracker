export type SyncState =
  | "not_connected"
  | "initial_sync"
  | "syncing"
  | "synced"
  | "offline"
  | "sync_failed"
  | "balance_mismatch"
  | "review_required";

export interface SyncStatusInput {
  readonly connected: boolean;
  readonly running: boolean;
  readonly lastSuccessfulSyncAt: Date | null;
  /** When this app process started. Data is only current once re-synced after startup. */
  readonly appStartedAt: Date;
  readonly lastRunFailed: boolean;
  /** Last failure was a network error (vs. auth/validation). */
  readonly lastFailureWasNetwork: boolean;
  readonly balanceMismatch: boolean;
  readonly reviewRequired: boolean;
}

export interface SyncStatus {
  readonly state: SyncState;
  /**
   * True only when the history was synced successfully during this app session.
   * Anything else must be presented as "data as of <lastSuccessfulSyncAt>".
   */
  readonly isCurrent: boolean;
  readonly dataAsOf: Date | null;
}

/**
 * Derive the single state shown to the user. Precedence: connection → running
 * → failure → staleness → data-quality warnings → synced. Stale data is never
 * reported as current.
 */
export function deriveSyncStatus(s: SyncStatusInput): SyncStatus {
  const dataAsOf = s.lastSuccessfulSyncAt;
  const syncedThisSession =
    dataAsOf !== null && dataAsOf.getTime() >= s.appStartedAt.getTime() && !s.lastRunFailed;

  let state: SyncState;
  if (!s.connected) state = "not_connected";
  else if (s.running) state = dataAsOf === null ? "initial_sync" : "syncing";
  else if (s.lastRunFailed) state = s.lastFailureWasNetwork ? "offline" : "sync_failed";
  // Connected, idle, never failed, but not yet synced this session: recovery pending.
  else if (!syncedThisSession) state = dataAsOf === null ? "initial_sync" : "syncing";
  else if (s.balanceMismatch) state = "balance_mismatch";
  else if (s.reviewRequired) state = "review_required";
  else state = "synced";

  return { state, isCurrent: s.connected && !s.running && syncedThisSession, dataAsOf };
}
