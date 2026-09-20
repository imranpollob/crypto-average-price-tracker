import Link from "next/link";
import type { AccountStatus } from "@/server/app/portfolio";
import { SyncNowButton } from "./kraken-forms";
import { Ago, LiveRefresh } from "./live";

/** Account-sync and price freshness, shown at the top of portfolio pages. */
export function StatusBar({ status }: { status: AccountStatus }) {
  const p = status.provider;
  if (!p.connected || !p.hasCredentials) {
    return (
      <p className="notice warning">
        Kraken is not connected. <Link href="/settings">Connect a read-only API key</Link> to load your portfolio.
      </p>
    );
  }
  const failed = !status.syncing && (status.state === "offline" || status.state === "sync_failed");
  return (
    <div className={`notice status-bar ${failed ? "error" : ""}`} role="status">
      <LiveRefresh stamp={status.stamp} syncing={status.syncing} />
      <span>
        {status.syncing ? (
          <strong>Syncing with Kraken...</strong>
        ) : failed ? (
          <strong>{status.state === "offline" ? "Offline" : "Sync failed"}</strong>
        ) : status.isCurrent ? (
          <>
            Synced <Ago iso={status.lastSuccessfulSyncAt} />
          </>
        ) : (
          "Not synced yet in this session"
        )}
        {!status.isCurrent && status.lastSuccessfulSyncAt && (
          <>
            {" "}
            · showing account data as of <strong>{new Date(status.lastSuccessfulSyncAt).toLocaleString()}</strong>
          </>
        )}
        {failed && status.lastError && <span className="muted"> ({status.lastError})</span>}
      </span>
      <span>
        Prices updated <Ago iso={status.pricesUpdatedAt} />
        {status.priceError && <span className="warning"> · price refresh failed, showing cached prices</span>}
      </span>
      <SyncNowButton label={failed ? "Retry" : "Sync now"} />
    </div>
  );
}
