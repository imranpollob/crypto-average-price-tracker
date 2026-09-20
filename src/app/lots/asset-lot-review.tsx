import { dec } from "@/domain/decimal";
import type { AllocationView, AssetDetail, DisposalView, LotView } from "@/server/app/lot-service";
import { date, money, ORIGIN_LABEL, price, shortId } from "../format";
import { EditMatchForm, MatchForm, ValuationForm } from "./lot-forms";

/**
 * Specific-lot review for one asset: unresolved sales/transfers with matching
 * forms, the user's matches, lots, and values to supply. Shows stored user
 * decisions only — no provisional FIFO.
 */

function disposalTitle(d: DisposalView): string {
  if (d.kind === "sale") return d.origin === "trade_payment" ? "Paid in a trade" : "Sale";
  return `Outgoing: ${ORIGIN_LABEL[d.origin] ?? d.origin}`;
}

/** Lots a match could be moved to: acquired no later than the disposal, with quantity left (or its current lot). */
function lotOptionsFor(m: AllocationView, lots: readonly LotView[]): string[] {
  return lots
    .filter((l) => l.acquiredAt <= m.disposedAt && (l.remainingQuantity !== "0" || l.id === m.lotId))
    .map((l) => l.id);
}

export function AssetLotReview({ asset, detail: d, showLots = true }: { asset: string; detail: AssetDetail; showLots?: boolean }) {
  const allLots = [...d.openLots, ...d.closedLots];
  const unknownLots = allLots.filter((l) => l.costBasisStatus !== "known");
  const sales = d.unresolved.filter((x) => x.kind === "sale");
  const transfers = d.unresolved.filter((x) => x.kind === "transfer_out");
  return (
    <>
      <section className="card">
        <h2>Unresolved ({d.unresolved.length})</h2>
        {d.unresolved.length === 0 && <p className="muted">Every sale and outgoing transfer of {asset} is assigned to lots.</p>}
        {[...sales, ...transfers].map((x) => (
          <article key={x.id} className="disposal">
            <h3>
              {disposalTitle(x)} · {date(x.disposedAt)} · {x.quantity} {asset}
              {x.unitPrice !== null && ` @ ${price(x.unitPrice, x.priceAsset)}`}
            </h3>
            <p className="muted">
              {shortId(x.id)}
              {x.kind === "sale" && x.proceeds?.status === "known" && (
                <>
                  {" "}
                  · proceeds {money(x.proceeds.gross)}, fee {money(x.proceeds.fee)}
                  {x.proceeds.source === "manual" && " (manual)"}
                </>
              )}
              {x.kind === "sale" && x.proceeds?.status === "unknown" && " · proceeds unknown (set them under “Needs a value”)"}
              {x.kind === "transfer_out" && " · not a sale: no proceeds, no realized P/L"}
              {x.status === "partially_matched" && ` · ${x.matchedQuantity} matched, ${x.unmatchedQuantity} left`}
            </p>
            {x.matches.length > 0 && (
              <ul className="plain">
                {x.matches.map((m) => (
                  <li key={m.matchId}>
                    Lot {shortId(m.lotId)} — {m.quantity}{" "}
                    <EditMatchForm asset={asset} match={m} lotOptions={lotOptionsFor(m, allLots)} />
                  </li>
                ))}
              </ul>
            )}
            <MatchForm key={`${x.id}:${x.matchedQuantity}`} asset={asset} disposal={x} />
          </article>
        ))}
      </section>

      {showLots && (
      <section className="card">
        <h2>Open lots ({d.openLots.length})</h2>
        <LotTable lots={d.openLots} asset={asset} />
        {d.closedLots.length > 0 && (
          <details>
            <summary>Closed lots ({d.closedLots.length})</summary>
            <LotTable lots={d.closedLots} asset={asset} />
          </details>
        )}
      </section>
      )}

      {d.saleMatches.length > 0 && (
        <section className="card">
          <h2>Closed / matched sales ({d.saleMatches.length})</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sold</th>
                  <th className="num">Buy</th>
                  <th className="num">Sell</th>
                  <th className="num">Qty</th>
                  <th className="num">Cost</th>
                  <th className="num">Net proceeds</th>
                  <th className="num">P/L</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {d.saleMatches.map((m) => (
                  <tr key={m.matchId}>
                    <td>{date(m.disposedAt)}</td>
                    <td className="num">{price(m.lotUnitPrice, m.lotPriceAsset)}</td>
                    <td className="num">{price(m.disposalUnitPrice, m.disposalPriceAsset)}</td>
                    <td className="num">{m.quantity}</td>
                    <td className="num" title={m.allocatedAcquisitionCost ?? undefined}>
                      {m.allocatedAcquisitionCost === null ? "unknown" : money(m.allocatedAcquisitionCost)}
                    </td>
                    <td className="num" title={m.netSaleProceeds ?? undefined}>
                      {m.netSaleProceeds === null ? "unknown" : money(m.netSaleProceeds)}
                    </td>
                    <td className="num" title={m.realizedPnl ?? undefined}>
                      {m.realizedPnl === null ? <span className="warning">incomplete</span> : money(m.realizedPnl, true)}
                    </td>
                    <td>
                      <details>
                        <summary>Edit</summary>
                        <EditMatchForm asset={asset} match={m} lotOptions={lotOptionsFor(m, allLots)} />
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {d.transferMatches.length > 0 && (
        <section className="card">
          <h2>Transferred out ({d.transferMatches.length})</h2>
          <p className="muted">Cost basis that left this account with a withdrawal or adjustment. It is not a trading loss.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Left</th>
                  <th>Kind</th>
                  <th className="num">Acquired at</th>
                  <th className="num">Qty</th>
                  <th className="num">Removed basis</th>
                  <th>Destination</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {d.transferMatches.map((m) => (
                  <tr key={m.matchId}>
                    <td>{date(m.disposedAt)}</td>
                    <td>{ORIGIN_LABEL[m.disposalOrigin ?? ""] ?? m.disposalOrigin}</td>
                    <td className="num">{price(m.lotUnitPrice, m.lotPriceAsset)}</td>
                    <td className="num">{m.quantity}</td>
                    <td className="num" title={m.allocatedAcquisitionCost ?? undefined}>
                      {m.allocatedAcquisitionCost === null ? "unknown" : money(m.allocatedAcquisitionCost)}
                    </td>
                    <td className="muted">Unknown</td>
                    <td>
                      <details>
                        <summary>Edit</summary>
                        <EditMatchForm asset={asset} match={m} lotOptions={lotOptionsFor(m, allLots)} />
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(unknownLots.length > 0 || d.valuationDisposals.length > 0) && (
        <section className="card">
          <h2>Needs a value</h2>
          <p className="muted">
            Deposits, rewards and trades priced in another asset have no known USD value. Enter it only if you know it — nothing
            is estimated for you.
          </p>
          {unknownLots.map((l) => (
            <article key={l.id} className="disposal">
              <h3>
                {ORIGIN_LABEL[l.origin] ?? l.origin} · {date(l.acquiredAt)} · {l.originalQuantity} {asset}
                {l.costBasisStatus === "manual" && <span className="badge">manual cost {money(l.acquisitionCost)}</span>}
              </h3>
              <ValuationForm
                asset={asset}
                targetType="acquisition"
                targetKey={l.id}
                current={
                  l.costBasisStatus === "manual" && l.acquisitionCost !== null
                    ? { gross: subtract(l.acquisitionCost, l.acquisitionFee), fee: l.acquisitionFee ?? "0" }
                    : null
                }
              />
            </article>
          ))}
          {d.valuationDisposals.map((x) => (
            <article key={x.id} className="disposal">
              <h3>
                {disposalTitle(x)} · {date(x.disposedAt)} · {x.quantity} {asset}
                {x.unitPrice !== null && ` @ ${price(x.unitPrice, x.priceAsset)}`}
              </h3>
              <ValuationForm
                asset={asset}
                targetType="disposal"
                targetKey={x.id}
                current={x.proceeds?.status === "known" && x.proceeds.source === "manual" ? { gross: x.proceeds.gross, fee: x.proceeds.fee } : null}
              />
            </article>
          ))}
        </section>
      )}
    </>
  );
}

/** Pre-fills the cost form: stored cost includes the fee, the form asks for them separately. */
function subtract(total: string, fee: string | null): string {
  return fee === null ? total : dec(total).minus(dec(fee)).toFixed();
}

export function LotTable({ lots, asset }: { lots: readonly LotView[]; asset: string }) {
  if (lots.length === 0) return <p className="muted">No open {asset} lots.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Acquired</th>
            <th>Source</th>
            <th className="num">Quantity</th>
            <th className="num">Remaining</th>
            <th className="num">Buy price</th>
            <th className="num">Cost basis</th>
            <th className="num">Remaining basis</th>
          </tr>
        </thead>
        <tbody>
          {lots.map((l) => (
            <tr key={l.id}>
              <td title={l.id}>{date(l.acquiredAt)}</td>
              <td>{ORIGIN_LABEL[l.origin] ?? l.origin}</td>
              <td className="num">{l.originalQuantity}</td>
              <td className="num">{l.remainingQuantity}</td>
              <td className="num">{price(l.unitPrice, l.priceAsset)}</td>
              <td className="num" title={l.acquisitionCost ?? undefined}>
                {l.costBasisStatus === "unknown" ? <span className="warning">unknown</span> : money(l.acquisitionCost)}
                {l.costBasisStatus === "manual" && " (manual)"}
              </td>
              <td className="num" title={l.remainingCost ?? undefined}>
                {l.costBasisStatus === "unknown" ? "—" : money(l.remainingCost)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
