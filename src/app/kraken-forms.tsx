"use client";

import { useActionState } from "react";
import { connectKrakenAction, type ConnectActionState, syncNowAction, type SyncActionState } from "./actions";

const CONNECTION_LABEL: Record<string, string> = {
  connected: "Connected",
  invalid_credentials: "Invalid credentials",
  missing_permission: "Missing permission",
  provider_unavailable: "Kraken unavailable",
  rate_limited: "Rate limited",
  dangerous_permissions: "Key refused: not read-only",
  unsupported_2fa: "API-key 2FA not supported",
  invalid_input: "Invalid input",
  failed: "Connection failed",
};

export function ConnectKrakenForm({ submitLabel }: { submitLabel: string }) {
  const [state, action, pending] = useActionState<ConnectActionState, FormData>(connectKrakenAction, null);
  return (
    <form action={action} className="stack" autoComplete="off">
      <label>
        API key
        <input name="apiKey" type="text" required spellCheck={false} autoComplete="off" />
      </label>
      <label>
        Private key
        <input name="apiSecret" type="password" required spellCheck={false} autoComplete="new-password" />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Testing connection..." : submitLabel}
      </button>
      {state && !pending && (
        <div className={state.state === "connected" ? "notice ok" : "notice error"} role="status">
          <strong>{CONNECTION_LABEL[state.state]}</strong> — {state.message}
          {state.warnings.map((w) => (
            <p key={w} className="warning">⚠ {w}</p>
          ))}
        </div>
      )}
    </form>
  );
}

export function SyncNowButton({ label }: { label: string }) {
  const [state, action, pending] = useActionState<SyncActionState, FormData>(syncNowAction, null);
  return (
    <form action={action} className="inline">
      <button type="submit" disabled={pending}>
        {pending ? "Syncing with Kraken..." : label}
      </button>
      {state && !pending && (
        <span className={state.ok ? "notice ok" : "notice error"} role="status">
          {state.message}
        </span>
      )}
    </form>
  );
}
