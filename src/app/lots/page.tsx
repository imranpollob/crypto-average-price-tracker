import Link from "next/link";
import { lotSummaries } from "@/server/app/lots";
import { MetricCell } from "../metric-cell";

export const dynamic = "force-dynamic";

export default async function LotsPage() {
  const assets = await lotSummaries();
  return (
    <main className="container">
      <header className="row">
        <h1>Review lots</h1>
        <Link href="/">← Portfolio</Link>
      </header>
      {assets === null ? (
        <p className="notice warning">Connect Kraken and run a sync first.</p>
      ) : (
        <section className="card">
          <p className="muted">
            Every acquisition is a lot. Sales and outgoing transfers stay unresolved until you assign them to lots — nothing is
            assigned automatically. Figures that depend on an unresolved item show as incomplete. Current value and unrealized P/L
            are not part of this screen.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="num">Holdings</th>
                  <th className="num">Open lots</th>
                  <th className="num">Open cost basis</th>
                  <th className="num">Average cost</th>
                  <th className="num">Realized P/L</th>
                  <th className="num">To review</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.asset}>
                    <td>
                      <Link href={`/lots/${encodeURIComponent(a.asset)}`}>{a.asset}</Link>
                    </td>
                    <td className="num">{a.holdings}</td>
                    <td className="num">{a.openLots}</td>
                    <td className="num">
                      <MetricCell m={a.costBasis} />
                    </td>
                    <td className="num">
                      <MetricCell m={a.averageCost} />
                    </td>
                    <td className="num">
                      <MetricCell m={a.realizedPnl} signed />
                    </td>
                    <td className="num">
                      {a.unresolvedSales + a.unresolvedTransfers > 0 ? (
                        <span className="warning">
                          {a.unresolvedSales} sales · {a.unresolvedTransfers} transfers
                        </span>
                      ) : a.reviewRequired ? (
                        <span className="warning">review</span>
                      ) : (
                        "✓"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
