import Link from "next/link";
import { notFound } from "next/navigation";
import { lotAssetDetail } from "@/server/app/lots";
import { MetricCell } from "../../metric-cell";
import { AssetLotReview } from "../asset-lot-review";

export const dynamic = "force-dynamic";

export default async function AssetLotsPage({ params }: { params: Promise<{ asset: string }> }) {
  const asset = decodeURIComponent((await params).asset);
  const d = await lotAssetDetail(asset);
  if (!d || (d.openLots.length === 0 && d.closedLots.length === 0 && d.unresolved.length === 0 && d.saleMatches.length === 0 && d.transferMatches.length === 0)) {
    notFound();
  }
  const s = d.summary;

  return (
    <main className="container wide">
      <header className="row">
        <h1>{asset} lots</h1>
        <span className="inline">
          <Link href={`/assets/${encodeURIComponent(asset)}`}>Portfolio view →</Link>
          <Link href="/lots">← All assets</Link>
        </span>
      </header>

      <section className="card">
        <p className="muted">
          Figures on this page use only your own lot decisions. The portfolio view assigns any remaining quantity with the
          automatic lot matching method (see Settings); a match you save here replaces it for that quantity immediately.
        </p>
        <dl className="grid">
          <dt>Holdings (from history)</dt>
          <dd>{s.holdings}</dd>
          <dt>Open lots</dt>
          <dd>{s.openLots}</dd>
          <dt>Open cost basis</dt>
          <dd>
            <MetricCell m={s.costBasis} />
          </dd>
          <dt>Average cost</dt>
          <dd>
            <MetricCell m={s.averageCost} />
          </dd>
          <dt>Realized P/L</dt>
          <dd>
            <MetricCell m={s.realizedPnl} signed />
          </dd>
        </dl>
        {d.issues.length > 0 && (
          <details>
            <summary className="warning">Why figures may be incomplete ({d.issues.length})</summary>
            <ul>
              {d.issues.map((i, n) => (
                <li key={n}>{i}</li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <AssetLotReview asset={asset} detail={d} />
    </main>
  );
}
