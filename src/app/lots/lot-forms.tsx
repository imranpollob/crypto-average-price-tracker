"use client";

import { useActionState, useMemo, useState } from "react";
import { type Decimal, dec, ZERO } from "@/domain/decimal";
import type { AllocationView, CandidateLotView, DisposalView, MatchPreview } from "@/server/app/lot-service";
import { editMatchAction, matchAction, type MatchActionState, type SimpleActionState, valuationAction } from "./actions";
import { date, money, ORIGIN_LABEL, price, shortId } from "../format";

/** Parse user input for the live counters only; the server re-validates everything. */
function parse(value: string): Decimal | null {
  if (value.trim() === "") return ZERO;
  try {
    return dec(value.trim());
  } catch {
    return null;
  }
}

export function MatchForm({ asset, disposal }: { asset: string; disposal: DisposalView }) {
  const [qty, setQty] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [state, action, pending] = useActionState<MatchActionState, FormData>(matchAction.bind(null, asset, disposal.id), null);

  const unmatched = dec(disposal.unmatchedQuantity);
  const allocated = useMemo(() => {
    let total = ZERO;
    for (const v of Object.values(qty)) {
      const d = parse(v);
      if (d === null) return null;
      total = total.plus(d);
    }
    return total;
  }, [qty]);
  const remaining = allocated === null ? null : unmatched.minus(allocated);
  const current = JSON.stringify(qty);

  function fill(lot: CandidateLotView) {
    const others = Object.entries(qty)
      .filter(([id]) => id !== lot.lotId)
      .reduce((acc, [, v]) => acc.plus(parse(v) ?? ZERO), ZERO);
    const open = unmatched.minus(others);
    const available = dec(lot.available);
    const take = open.lessThan(available) ? open : available;
    setQty({ ...qty, [lot.lotId]: take.greaterThan(0) ? take.toFixed() : "" });
  }

  if (disposal.candidates.length === 0) {
    return (
      <p className="warning">
        No lot is available for this {disposal.kind === "sale" ? "sale" : "transfer"}: every earlier lot of {asset} is already fully assigned,
        or the acquisition is missing from the imported history.
      </p>
    );
  }

  return (
    <form action={action} onSubmit={() => setSubmitted(current)} className="match-form">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Lot</th>
              <th>Acquired</th>
              <th>Source</th>
              <th className="num">Available</th>
              <th className="num">Buy price</th>
              <th className="num">Remaining cost</th>
              <th>Allocate</th>
            </tr>
          </thead>
          <tbody>
            {disposal.candidates.map((c) => (
              <tr key={c.lotId}>
                <td title={c.lotId}>{shortId(c.lotId)}</td>
                <td>{date(c.acquiredAt)}</td>
                <td>{ORIGIN_LABEL[c.origin] ?? c.origin}</td>
                <td className="num">{c.available}</td>
                <td className="num">{price(c.unitPrice, c.priceAsset)}</td>
                <td className="num" title={c.remainingCost ?? undefined}>
                  {c.costBasisStatus === "unknown" ? "unknown" : money(c.remainingCost)}
                </td>
                <td>
                  <span className="inline">
                    <input
                      name={`qty:${c.lotId}`}
                      inputMode="decimal"
                      autoComplete="off"
                      spellCheck={false}
                      className="qty"
                      value={qty[c.lotId] ?? ""}
                      onChange={(e) => setQty({ ...qty, [c.lotId]: e.target.value })}
                      aria-label={`Quantity from lot ${shortId(c.lotId)}`}
                    />
                    <button type="button" className="secondary" onClick={() => fill(c)}>
                      Fill
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="inline">
        <span>
          Allocated: <strong>{allocated === null ? "invalid input" : allocated.toFixed()}</strong>
        </span>
        <span>
          Remaining to match:{" "}
          <strong className={remaining !== null && remaining.isNegative() ? "error-text" : undefined}>
            {remaining === null ? "—" : remaining.toFixed()}
          </strong>
        </span>
        <button type="submit" name="intent" value="preview" className="secondary" disabled={pending}>
          Preview
        </button>
        <button type="submit" name="intent" value="save" disabled={pending}>
          {pending ? "Working..." : "Save match"}
        </button>
      </p>
      {state?.kind === "error" && !pending && (
        <div className="notice error" role="alert">
          {state.messages.map((m) => (
            <p key={m}>{m}</p>
          ))}
        </div>
      )}
      {state?.kind === "saved" && !pending && (
        <p className="notice ok" role="status">
          {state.message}
        </p>
      )}
      {state?.kind === "preview" && !pending && submitted === current && <Preview preview={state.preview} />}
    </form>
  );
}

function Preview({ preview }: { preview: MatchPreview }) {
  const t = preview.totals;
  return (
    <div className="notice" role="status">
      <strong>Preview — not saved</strong>
      {preview.kind === "sale" ? (
        <dl className="grid">
          <dt>Sale proceeds</dt>
          <dd title={t.grossProceeds ?? undefined}>{t.grossProceeds === null ? "unknown" : money(t.grossProceeds)}</dd>
          <dt>Allocated cost</dt>
          <dd title={t.acquisitionCost ?? undefined}>{t.acquisitionCost === null ? "unknown" : money(t.acquisitionCost)}</dd>
          <dt>Fees (buy + sell)</dt>
          <dd>
            {money(t.buyFees)} + {money(t.sellFees)}
          </dd>
          <dt>Realized P/L</dt>
          <dd title={t.realizedPnl ?? undefined}>
            <strong>{t.realizedPnl === null ? "incomplete (unknown cost or proceeds)" : money(t.realizedPnl, true)}</strong>
          </dd>
          <dt>Still unmatched</dt>
          <dd>{preview.remainingToMatch}</dd>
        </dl>
      ) : (
        <dl className="grid">
          <dt>Cost basis leaving</dt>
          <dd title={t.acquisitionCost ?? undefined}>{t.acquisitionCost === null ? "unknown" : money(t.acquisitionCost)}</dd>
          <dt>Treatment</dt>
          <dd>Not a sale: no proceeds and no realized P/L. The basis stays attached to this outgoing transfer.</dd>
          <dt>Still unmatched</dt>
          <dd>{preview.remainingToMatch}</dd>
        </dl>
      )}
    </div>
  );
}

export function EditMatchForm({ asset, match, lotOptions }: { asset: string; match: AllocationView; lotOptions: readonly string[] }) {
  const [state, action, pending] = useActionState<SimpleActionState, FormData>(editMatchAction.bind(null, asset, match.matchId), null);
  return (
    <form action={action} className="inline">
      <select name="lotId" defaultValue={match.lotId} aria-label="Lot">
        {[match.lotId, ...lotOptions.filter((id) => id !== match.lotId)].map((id) => (
          <option key={id} value={id}>
            {shortId(id)}
          </option>
        ))}
      </select>
      <input name="quantity" defaultValue={match.quantity} inputMode="decimal" className="qty" aria-label="Quantity" />
      <button type="submit" name="intent" value="update" className="secondary" disabled={pending}>
        Update
      </button>
      <button type="submit" name="intent" value="delete" className="secondary" disabled={pending}>
        Remove
      </button>
      {state && !pending && <span className={state.ok ? "notice ok" : "notice error"}>{state.message}</span>}
    </form>
  );
}

export function ValuationForm({
  asset,
  targetType,
  targetKey,
  current,
}: {
  asset: string;
  targetType: "acquisition" | "disposal";
  targetKey: string;
  current: { gross: string; fee: string } | null;
}) {
  const [state, action, pending] = useActionState<SimpleActionState, FormData>(
    valuationAction.bind(null, asset, targetType, targetKey),
    null,
  );
  return (
    <form action={action} className="inline">
      <label>
        {targetType === "acquisition" ? "Total cost (USD, excl. fee)" : "Total proceeds (USD, before fee)"}
        <input name="gross" defaultValue={current?.gross ?? ""} inputMode="decimal" className="qty" required />
      </label>
      <label>
        Fee (USD)
        <input name="fee" defaultValue={current?.fee ?? "0"} inputMode="decimal" className="qty" />
      </label>
      <label>
        Note
        <input name="note" />
      </label>
      <button type="submit" name="intent" value="save" disabled={pending}>
        Save
      </button>
      {current && (
        <button type="submit" name="intent" value="clear" className="secondary" disabled={pending} formNoValidate>
          Clear
        </button>
      )}
      {state && !pending && <span className={state.ok ? "notice ok" : "notice error"}>{state.message}</span>}
    </form>
  );
}
