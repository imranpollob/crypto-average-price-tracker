"use client";

import { useActionState } from "react";
import type { AutomaticMatchingMethod } from "@/domain/lots/automatic-matching";
import { matchingMethodAction, type MatchingMethodActionState } from "../actions";

const OPTIONS: readonly { value: AutomaticMatchingMethod; title: string; help: string }[] = [
  { value: "fifo", title: "FIFO — First In, First Out", help: "Oldest acquired lots are used first" },
  { value: "lifo", title: "LIFO — Last In, First Out", help: "Most recently acquired lots are used first" },
  {
    value: "hifo",
    title: "HIFO — Highest In, First Out",
    help: "Highest-cost lots (including fees) are used first. Where a lot of unknown cost could be chosen, the figures stay incomplete until it is valued.",
  },
];

export function MatchingMethodForm({ current }: { current: AutomaticMatchingMethod }) {
  const [state, action, pending] = useActionState<MatchingMethodActionState, FormData>(matchingMethodAction, null);
  return (
    <form action={action} className="stack">
      <fieldset className="stack">
        <legend>
          <strong>Automatic lot matching method</strong>
        </legend>
        <p className="muted">
          Used for unmatched sale or outgoing quantities. Manual lot matches always override this setting. Changing it only
          recalculates figures — no sync, and your saved matches stay as they are.
        </p>
        {OPTIONS.map((o) => (
          <label key={o.value} className="radio">
            <input type="radio" name="method" value={o.value} defaultChecked={o.value === current} />
            <span>
              {o.title}
              <br />
              <span className="muted">{o.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <span className="inline">
        <button type="submit" disabled={pending}>
          {pending ? "Saving..." : "Save"}
        </button>
        {state && !pending && <span className={state.ok ? "notice ok" : "notice error"}>{state.message}</span>}
      </span>
    </form>
  );
}
