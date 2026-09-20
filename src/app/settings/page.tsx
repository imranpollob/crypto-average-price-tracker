import { getAccountStatus } from "@/server/app/portfolio";
import { getProviderDiagnostics, type ProviderStatus } from "@/server/app/provider-accounts";
import { ConnectKrakenForm, SyncNowButton } from "../kraken-forms";
import { Ago, LiveRefresh } from "../live";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<ProviderStatus["state"], string> = {
  not_connected: "Not connected",
  initial_sync: "Initial sync",
  syncing: "Syncing",
  synced: "Synced",
  offline: "Offline",
  sync_failed: "Sync failed",
  balance_mismatch: "Balance mismatch",
  review_required: "Review required",
};

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

const RECONCILIATION_LABEL: Record<string, string> = {
  reconciled: "✓ Reconciled",
  reconciled_within_precision: "✓ Within Kraken precision",
  review_required: "⚠ Review required",
  mismatch: "⚠ Mismatch",
};

export default async function SettingsPage() {
  const status = await getAccountStatus();
  const s = status.provider;
  const diag = s.lastSuccessfulSyncAt ? await getProviderDiagnostics("kraken") : null;
  return (
    <main className="container">
      <LiveRefresh stamp={status.stamp} syncing={status.syncing} />
      <header className="row">
        <h1>Connection &amp; settings</h1>
        <span className={`badge state-${status.state}`}>{STATE_LABEL[status.state]}</span>
      </header>

      <section className="card">
        <h2>Status</h2>
        <dl className="grid">
          <dt>Provider</dt>
          <dd>{s.providerName}</dd>
          <dt>Connection</dt>
          <dd>{s.connected && s.hasCredentials ? "Connected (read-only API key)" : "Not connected"}</dd>
          <dt>Account sync</dt>
          <dd>
            {status.syncing ? "Syncing with Kraken..." : <>Last successful: <Ago iso={status.lastSuccessfulSyncAt} /></>}
            {status.lastError && <span className="error-text"> — last attempt failed: {status.lastError}</span>}
          </dd>
          <dt>Price update</dt>
          <dd>
            <Ago iso={status.pricesUpdatedAt} /> (Kraken public ticker, refreshed about every 30–60 s while open)
            {status.priceError && <span className="error-text"> — last attempt failed: {status.priceError}</span>}
          </dd>
          <dt>Matching fallback</dt>
          <dd>FIFO, provisional — used only for quantity you have not assigned to lots; your own matches always take precedence.</dd>
        </dl>
      </section>

      {s.connected && !s.isCurrent && (
        <p className="notice warning" role="status">
          {s.state === "sync_failed" || s.state === "offline"
            ? `${s.providerName} synchronization failed. `
            : "Not yet synchronized in this session. "}
          Showing data as of: <strong>{when(s.lastSuccessfulSyncAt)}</strong>
        </p>
      )}

      <section className="card">
        <h2>{s.providerName}</h2>
        {s.connected && s.hasCredentials ? (
          <>
            <p>
              Last successful sync: <strong>{when(s.lastSuccessfulSyncAt)}</strong>
            </p>
            <SyncNowButton label={s.lastRun?.status === "failed" ? "Retry" : "Sync now"} />
            <details>
              <summary>Replace API credentials</summary>
              <ConnectKrakenForm submitLabel="Test and save" />
            </details>
          </>
        ) : (
          <>
            <Permissions setup={s.setup} />
            <ConnectKrakenForm submitLabel="Test connection and save" />
          </>
        )}
        <p className="warning">⚠ {s.setup.securityNote}</p>
      </section>

      {s.lastRun && (
        <section className="card">
          <h2>Last sync run</h2>
          <dl className="grid">
            <dt>Status</dt>
            <dd>
              {s.lastRun.status} ({s.lastRun.mode})
            </dd>
            <dt>Range</dt>
            <dd>
              {s.lastRun.syncFrom ? when(s.lastRun.syncFrom) : "full history"} → {when(s.lastRun.syncTo)}
            </dd>
            <dt>Trades</dt>
            <dd>
              {s.lastRun.trades.received} received, {s.lastRun.trades.inserted} new
            </dd>
            <dt>Ledger entries</dt>
            <dd>
              {s.lastRun.ledger.received} received, {s.lastRun.ledger.inserted} new
            </dd>
            <dt>Transfers</dt>
            <dd>
              {s.lastRun.transfers.received} received, {s.lastRun.transfers.inserted} new
            </dd>
            <dt>Balances</dt>
            <dd>{s.lastRun.balancesRetrieved} retrieved</dd>
            {s.lastRun.errorMessage && (
              <>
                <dt>Error</dt>
                <dd className="error-text">
                  [{s.lastRun.errorCategory}] {s.lastRun.errorMessage}
                </dd>
              </>
            )}
          </dl>
          <p className="muted">
            Stored: {s.totals.trades} trades · {s.totals.ledgerEntries} ledger entries · {s.totals.transfers} transfers
          </p>
        </section>
      )}

      {s.reconciliation.length > 0 && (
        <section className="card">
          <h2>Balance reconciliation</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="num">Calculated</th>
                  <th className="num">{s.providerName}</th>
                  <th className="num">Difference</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {s.reconciliation.map((r) => (
                  <tr key={r.asset}>
                    <td>{r.asset}</td>
                    <td className="num">{r.calculated}</td>
                    <td className="num">{r.reported}</td>
                    <td className="num">{r.difference === "0" ? "0" : r.difference.startsWith("-") ? r.difference : `+${r.difference}`}</td>
                    <td>{RECONCILIATION_LABEL[r.status] ?? r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">
            Differences are shown exactly and never corrected by editing history. &ldquo;Within Kraken precision&rdquo; differences
            are smaller than the smallest unit Kraken reports for that asset and do not affect the portfolio.
          </p>
        </section>
      )}

      {s.review.length > 0 && (
        <section className="card">
          <h2>Needs review ({s.review.length})</h2>
          <ul>
            {s.review.map((r, i) => (
              <li key={i}>
                <strong>{r.asset}</strong>: {r.detail}
              </li>
            ))}
          </ul>
        </section>
      )}
      {diag && (
        <section className="card">
          <h2>Sync diagnostics</h2>
          <dl className="grid">
            <dt>Trades</dt>
            <dd>
              {diag.diagnostics.records.exchangeTrades} exchange · {diag.diagnostics.records.ledgerDerivedTrades} instant buy/sell/convert
            </dd>
            <dt>Ledger entries</dt>
            <dd>{diag.diagnostics.records.ledgerEntries}</dd>
            <dt>History span</dt>
            <dd>
              {when(diag.diagnostics.earliestTransaction)} → {when(diag.diagnostics.latestTransaction)}
            </dd>
            <dt>Fees</dt>
            <dd>
              {diag.diagnostics.fees.normal} normal · {diag.diagnostics.fees.thirdAsset} third-asset · {diag.diagnostics.fees.feeCredit} fee credits · {diag.diagnostics.fees.fromTradeRecord} without ledger evidence
            </dd>
            <dt>Review required</dt>
            <dd>{diag.diagnostics.review.total}</dd>
          </dl>
          <details>
            <summary>Copyable report (contains no keys or secrets)</summary>
            <pre className="report">{diag.text}</pre>
          </details>
        </section>
      )}
    </main>
  );
}

function Permissions({ setup }: { setup: ProviderStatus["setup"] }) {
  return (
    <div className="stack">
      <p>
        Create an API key with <strong>read-only</strong> permissions only:
      </p>
      <ul>
        {setup.requiredPermissions.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      {setup.optionalPermissions.length > 0 && <p className="muted">Optional: {setup.optionalPermissions.join(", ")}.</p>}
      <p>
        Do <strong>not</strong> enable: {setup.forbiddenPermissions.join(", ")}. Keys with any of these are refused.
        The key is encrypted and stored only on this computer.
      </p>
    </div>
  );
}
