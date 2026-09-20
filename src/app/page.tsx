import Link from "next/link";
import { Fragment } from "react";
import { getDashboard } from "@/server/app/portfolio";
import type { PositionView, Total } from "@/server/app/portfolio-service";
import { money, price } from "./format";
import { MetricCell } from "./metric-cell";
import { PositionLabels } from "./position-labels";
import { StatusBar } from "./status-bar";

export const dynamic = "force-dynamic";

function TotalRow({ label, total, signed = false, what }: { label: string; total: Total; signed?: boolean; what: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <MetricCell m={{ status: "known", value: total.value }} signed={signed} />
        {total.excluded.length > 0 && (
          <span className="warning" title={total.excluded.join(", ")}>
            {" "}
            * excludes {total.excluded.length} asset{total.excluded.length === 1 ? "" : "s"} ({what})
          </span>
        )}
      </dd>
    </>
  );
}

function PriceCell({ p }: { p: PositionView }) {
  if (p.price === null) return <span className="warning">unavailable</span>;
  return (
    <span title={`as of ${new Date(p.priceAsOf!).toLocaleString()}`} className={p.priceStale ? "stale" : undefined}>
      {price(p.price, "USD")}
      {p.priceStale && " (stale)"}
    </span>
  );
}

export default async function PortfolioPage() {
  const { status, portfolio } = await getDashboard();
  const t = portfolio?.totals;
  return (
    <main className="container wide">
      <header className="row">
        <h1>Portfolio</h1>
      </header>
      <StatusBar status={status} />

      {portfolio && t && (
        <>
          <section className="card">
            <dl className="grid totals">
              <TotalRow label="Total current value" total={t.currentValue} what="no current price" />
              <TotalRow label="Open cost basis" total={t.costBasis} what="cost basis incomplete" />
              <TotalRow label="Realized P/L" total={t.realizedPnl} signed what="P/L incomplete" />
              <TotalRow label="Unrealized P/L" total={t.unrealizedPnl} signed what="P/L incomplete" />
              <TotalRow label="Total P/L" total={t.totalPnl} signed what="P/L incomplete" />
              {portfolio.cash.map((c) => (
                <Fragment key={c.asset}>
                  <dt>Cash ({c.asset})</dt>
                  <dd>{c.asset === "USD" ? money(c.total) : `${c.total} ${c.asset}`}</dd>
                </Fragment>
              ))}
            </dl>
            {portfolio.fifoEstimatedAssets > 0 && (
              <p className="muted">
                Includes provisional FIFO matches for {portfolio.fifoEstimatedAssets} asset{portfolio.fifoEstimatedAssets === 1 ? "" : "s"}:
                sales and transfers you have not assigned to specific lots are estimated oldest-lot-first. This is a calculation
                fallback, not an assumption about your strategy — <Link href="/lots">assign lots</Link> to replace it.
              </p>
            )}
            {(t.totalPnl.excluded.length > 0 || t.currentValue.excluded.length > 0) && (
              <p className="muted">* Totals add only figures that are complete. Hover an “Incomplete” cell to see why.</p>
            )}
          </section>

          <section className="card">
            <h2>Holdings ({portfolio.positions.length})</h2>
            {portfolio.positions.length === 0 ? (
              <p className="muted">No open positions.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th className="num">Price</th>
                      <th className="num">Holdings</th>
                      <th className="num">Current value</th>
                      <th className="num">Avg cost</th>
                      <th className="num">Cost basis</th>
                      <th className="num">Realized</th>
                      <th className="num">Unrealized</th>
                      <th className="num">%</th>
                      <th className="num">Total P/L</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {portfolio.positions.map((p) => (
                      <tr key={p.asset}>
                        <td>
                          <Link href={`/assets/${encodeURIComponent(p.asset)}`}>{p.asset}</Link>
                        </td>
                        <td className="num">
                          <PriceCell p={p} />
                        </td>
                        <td className="num">{p.holdings}</td>
                        <td className="num">
                          <MetricCell m={p.currentValue} />
                        </td>
                        <td className="num">
                          <MetricCell m={p.averageCost} as="price" />
                        </td>
                        <td className="num">
                          <MetricCell m={p.costBasis} />
                        </td>
                        <td className="num">
                          <MetricCell m={p.realizedPnl} signed />
                        </td>
                        <td className="num">
                          <MetricCell m={p.unrealizedPnl} signed />
                        </td>
                        <td className="num">
                          <MetricCell m={p.unrealizedPnlPercent} as="percent" />
                        </td>
                        <td className="num">
                          <MetricCell m={p.totalPnl} signed />
                        </td>
                        <td>
                          <PositionLabels labels={p.labels} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {portfolio.closed.length > 0 && (
            <section className="card">
              <details>
                <summary>Closed positions ({portfolio.closed.length}) — realized P/L only</summary>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th className="num">Realized P/L</th>
                        <th className="num">Total P/L</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {portfolio.closed.map((p) => (
                        <tr key={p.asset}>
                          <td>
                            <Link href={`/assets/${encodeURIComponent(p.asset)}`}>{p.asset}</Link>
                          </td>
                          <td className="num">
                            <MetricCell m={p.realizedPnl} signed />
                          </td>
                          <td className="num">
                            <MetricCell m={p.totalPnl} signed />
                          </td>
                          <td>
                            <PositionLabels labels={p.labels} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>
          )}
        </>
      )}
    </main>
  );
}
