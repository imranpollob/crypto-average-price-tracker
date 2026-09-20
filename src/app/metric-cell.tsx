import { dec } from "@/domain/decimal";
import type { MetricView } from "@/server/app/lot-service";
import { money, percent, price, REASON_LABEL } from "./format";

/** A metric that is either known, not applicable, or incomplete (with its reasons on hover). */
export function MetricCell({ m, signed = false, as = "money" }: { m: MetricView; signed?: boolean; as?: "money" | "price" | "percent" }) {
  if (m.status === "known") {
    const text = as === "percent" ? percent(m.value) : as === "price" ? price(m.value, "USD") : money(m.value, signed);
    const d = dec(m.value);
    const tone = !signed || d.isZero() ? undefined : d.isNegative() ? "loss" : "gain";
    return (
      <span title={m.value} className={tone}>
        {text}
      </span>
    );
  }
  if (m.status === "not_applicable") return <span className="muted">n/a</span>;
  return (
    <span className="warning" title={`Incomplete: ${m.reasons.map((r) => REASON_LABEL[r] ?? r).join(", ")}`}>
      Incomplete
    </span>
  );
}
