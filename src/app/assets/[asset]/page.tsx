import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { getAssetPage } from "@/server/app/portfolio";
import { date, money, price } from "../../format";
import { AssetLotReview, LotTable } from "../../lots/asset-lot-review";
import { MetricCell } from "../../metric-cell";
import { labelText } from "../../position-labels";
import { StatusBar } from "../../status-bar";

export const dynamic = "force-dynamic";

export default async function AssetPage({ params }: { params: Promise<{ asset: string }> }) {
  const asset = decodeURIComponent((await params).asset);
  const { status, view, lots } = await getAssetPage(asset);
  if (!view) notFound();
  const p = view.position;
  const incomplete = p.labels.filter((l) => l.kind === "cost_basis_incomplete" || l.kind === "review_required" || l.kind === "price_unavailable");

  return (
    <main className="container wide">
      <header className="row">
        <h1>{asset}</h1>
        <span className="inline">
          <Link href={`/lots/${encodeURIComponent(asset)}`}>Match lots for {asset} →</Link>
          <Link href="/">← Portfolio</Link>
        </span>
      </header>
      <StatusBar status={status} />

      <section className="card">
        <dl className="grid totals">
          <dt>Current price</dt>
          <dd>
            {p.price === null ? (
              p.holdings === "0" ? <span className="muted">not needed (no holdings)</span> : <span className="warning">unavailable</span>
            ) : (
              <>
                {price(p.price, "USD")}{" "}
                <span className={p.priceStale ? "warning" : "muted"}>
                  as of {date(p.priceAsOf!)}
                  {p.priceStale && " (stale)"}
                </span>
              </>
            )}
          </dd>
          <dt>Holdings</dt>
          <dd>
            {p.holdings} {asset}
          </dd>
          <dt>Current value</dt>
          <dd>
            <MetricCell m={p.currentValue} />
          </dd>
          <dt>Average cost</dt>
          <dd>
            <MetricCell m={p.averageCost} as="price" />
          </dd>
          <dt>Cost basis</dt>
          <dd>
            <MetricCell m={p.costBasis} />
          </dd>
          <dt>Realized P/L</dt>
          <dd>
            <MetricCell m={p.realizedPnl} signed />
          </dd>
          <dt>Unrealized P/L</dt>
          <dd>
            <MetricCell m={p.unrealizedPnl} signed />
          </dd>
          <dt>Unrealized P/L %</dt>
          <dd>
            <MetricCell m={p.unrealizedPnlPercent} as="percent" />
          </dd>
          <dt>Total P/L</dt>
          <dd>
            <MetricCell m={p.totalPnl} signed />
          </dd>
          <dt>Lot matching</dt>
          <dd>{p.fifoEstimated ? <span className="warning">FIFO estimated (provisional)</span> : "Specific/manual"}</dd>
          {incomplete.map((l) => (
            <Fragment key={l.kind}>
              <dt>Attention</dt>
              <dd className="warning">{labelText(l)}</dd>
            </Fragment>
          ))}
        </dl>
      </section>

      {view.provisionalMatches.length > 0 && (
        <section className="card">
          <h2>Provisional FIFO matches ({view.provisionalMatches.length})</h2>
          <p className="muted">
            Quantity you have not assigned is estimated oldest-lot-first so the figures above are complete. These are not saved and
            are not your decisions; <Link href={`/lots/${encodeURIComponent(asset)}`}>assign specific lots</Link> to replace them.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Disposed</th>
                  <th>Kind</th>
                  <th>Lot acquired</th>
                  <th className="num">Qty</th>
                  <th className="num">Buy</th>
                  <th className="num">Sell</th>
                  <th className="num">Cost</th>
                  <th className="num">Net proceeds</th>
                  <th className="num">P/L</th>
                </tr>
              </thead>
              <tbody>
                {view.provisionalMatches.map((m) => (
                  <tr key={m.matchId}>
                    <td>{date(m.disposedAt)}</td>
                    <td>{m.kind === "sale" ? "Sale" : "Transfer out"}</td>
                    <td>{date(m.lotAcquiredAt)}</td>
                    <td className="num">{m.quantity}</td>
                    <td className="num">{price(m.lotUnitPrice, m.lotPriceAsset)}</td>
                    <td className="num">{price(m.disposalUnitPrice, m.disposalPriceAsset)}</td>
                    <td className="num">{m.allocatedAcquisitionCost === null ? "unknown" : money(m.allocatedAcquisitionCost)}</td>
                    <td className="num">{m.kind === "sale" ? (m.netSaleProceeds === null ? "unknown" : money(m.netSaleProceeds)) : "—"}</td>
                    <td className="num">
                      {m.kind !== "sale" ? "—" : m.realizedPnl === null ? <span className="warning">incomplete</span> : money(m.realizedPnl, true)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Open lots ({view.openLots.length})</h2>
        {view.provisionalMatches.length > 0 && <p className="muted">Remaining quantities include the provisional FIFO matches above.</p>}
        <LotTable lots={view.openLots} asset={asset} />
      </section>

      {lots && (
        <>
          <h2>Specific-lot matching (your decisions)</h2>
          <AssetLotReview asset={asset} detail={lots} showLots={false} />
        </>
      )}
    </main>
  );
}
