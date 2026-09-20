import type { PositionLabel } from "@/server/app/portfolio-service";
import { METHOD_LABEL, REASON_LABEL } from "./format";

const PRICE_REASON: Record<string, string> = {
  no_direct_market: "no direct USD market on Kraken",
  no_price_returned: "Kraken returned no price",
  not_fetched: "not fetched yet",
};

export function labelText(l: PositionLabel): string {
  switch (l.kind) {
    case "complete":
      return "Complete";
    case "automatic":
      return l.withManual ? `Manual + ${METHOD_LABEL[l.method]}` : `Automatic: ${METHOD_LABEL[l.method]}`;
    case "automatic_undetermined":
      return `${METHOD_LABEL[l.method]} cannot be determined — an eligible lot has unknown cost basis`;
    case "cost_basis_incomplete":
      return l.lotsNeedingValuation > 0
        ? `Cost basis incomplete — ${l.lotsNeedingValuation} ${l.lotsNeedingValuation === 1 ? "lot needs" : "lots need"} valuation`
        : "Cost basis incomplete";
    case "price_unavailable":
      return `Price unavailable (${PRICE_REASON[l.reason] ?? l.reason})`;
    case "review_required":
      return `Review required (${l.reasons.map((r) => REASON_LABEL[r] ?? r).join(", ")})`;
  }
}

export function PositionLabels({ labels }: { labels: readonly PositionLabel[] }) {
  return (
    <span className="labels">
      {labels.map((l) => (
        <span key={l.kind} className={`label label-${l.kind}`} title={l.kind === "automatic" ? "Unmatched quantity is assigned by the automatic lot matching method (see Settings). Manual lot matches always override it." : undefined}>
          {labelText(l)}
        </span>
      ))}
    </span>
  );
}
