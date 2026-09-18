import { describe, expect, it } from "vitest";
import { deriveSyncStatus, type SyncStatusInput } from "@/domain/sync/status";
import { DEFAULT_SYNC_OVERLAP_MS, planSyncWindow } from "@/domain/sync/window";

const now = new Date("2026-09-24T14:00:00Z");

describe("sync window", () => {
  it("first sync fetches full history up to a fixed end", () => {
    expect(planSyncWindow({ lastSuccessfulSyncAt: null, now })).toEqual({ mode: "initial", since: null, until: now });
  });

  it("incremental sync starts ~5 minutes before the last success", () => {
    const last = new Date("2026-09-24T12:00:00Z");
    const w = planSyncWindow({ lastSuccessfulSyncAt: last, now });
    expect(DEFAULT_SYNC_OVERLAP_MS).toBe(300_000);
    expect(w).toEqual({ mode: "incremental", since: new Date("2026-09-24T11:55:00Z"), until: now });
  });

  it("#25 long offline period: window covers the whole gap", () => {
    const last = new Date("2026-06-01T00:00:00Z");
    const w = planSyncWindow({ lastSuccessfulSyncAt: last, now });
    expect(w.since!.getTime()).toBe(last.getTime() - DEFAULT_SYNC_OVERLAP_MS);
  });

  it("a clock that moved backwards never produces an empty window", () => {
    const last = new Date("2026-09-25T00:00:00Z");
    const w = planSyncWindow({ lastSuccessfulSyncAt: last, now });
    expect(w.since!.getTime()).toBe(now.getTime() - DEFAULT_SYNC_OVERLAP_MS);
  });
});

describe("sync status", () => {
  const started = new Date("2026-09-24T13:00:00Z");
  const base: SyncStatusInput = {
    connected: true,
    running: false,
    lastSuccessfulSyncAt: new Date("2026-09-24T13:30:00Z"),
    appStartedAt: started,
    lastRunFailed: false,
    lastFailureWasNetwork: false,
    balanceMismatch: false,
    reviewRequired: false,
  };

  it("synced this session → current", () => {
    expect(deriveSyncStatus(base)).toMatchObject({ state: "synced", isCurrent: true });
  });

  it("#24 startup: data from a previous session is never shown as current", () => {
    const s = deriveSyncStatus({ ...base, lastSuccessfulSyncAt: new Date("2026-09-20T09:00:00Z") });
    expect(s.state).toBe("syncing");
    expect(s.isCurrent).toBe(false);
    expect(s.dataAsOf).toEqual(new Date("2026-09-20T09:00:00Z"));
  });

  it("states: not connected, initial, syncing, offline, failed, mismatch, review", () => {
    expect(deriveSyncStatus({ ...base, connected: false }).state).toBe("not_connected");
    expect(deriveSyncStatus({ ...base, running: true, lastSuccessfulSyncAt: null }).state).toBe("initial_sync");
    expect(deriveSyncStatus({ ...base, running: true }).state).toBe("syncing");
    expect(deriveSyncStatus({ ...base, lastRunFailed: true, lastFailureWasNetwork: true }).state).toBe("offline");
    expect(deriveSyncStatus({ ...base, lastRunFailed: true })).toMatchObject({ state: "sync_failed", isCurrent: false });
    expect(deriveSyncStatus({ ...base, balanceMismatch: true, reviewRequired: true }).state).toBe("balance_mismatch");
    expect(deriveSyncStatus({ ...base, reviewRequired: true }).state).toBe("review_required");
  });
});
