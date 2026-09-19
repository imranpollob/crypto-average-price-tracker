import { ProviderError } from "../types";

/**
 * API-key permission policy, based on GetApiKeyInfo (docs/kraken-api-notes.md).
 *
 * Documented permission strings: query-funds, add-funds, withdraw-funds,
 * earn-funds, query-open-trades, query-closed-trades, modify-trades,
 * close-trades, query-ledger, export-data, create-ws-token,
 * add-withdraw-address, update-withdraw-address.
 */

/** Exactly what the endpoints we call need: Balance, TradesHistory, Ledgers. */
export const REQUIRED_PERMISSIONS = ["query-funds", "query-closed-trades", "query-ledger"] as const;

/** Allowed: authenticated WebSocket feeds are planned (Phase 7). */
export const OPTIONAL_PERMISSIONS = ["create-ws-token"] as const;

/** Read-only but not needed: accepted with an informational warning. */
export const UNNECESSARY_READ_PERMISSIONS = ["query-open-trades", "export-data"] as const;

/** Can move funds, trade, or change account state: the key is refused. */
export const DANGEROUS_PERMISSIONS = [
  "add-funds",
  "withdraw-funds",
  "earn-funds",
  "modify-trades",
  "close-trades",
  "add-withdraw-address",
  "update-withdraw-address",
] as const;

export const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  "query-funds": "Funds → Query Funds",
  "add-funds": "Funds → Deposit Funds",
  "withdraw-funds": "Funds → Withdraw Funds",
  "earn-funds": "Funds → Earn (allocate/deallocate)",
  "query-open-trades": "Orders & Trades → Query Open Orders & Trades",
  "query-closed-trades": "Orders & Trades → Query Closed Orders & Trades",
  "modify-trades": "Orders & Trades → Create & Modify Orders",
  "close-trades": "Orders & Trades → Cancel/Close Orders",
  "query-ledger": "Data → Query Ledger Entries",
  "export-data": "Data → Export Data",
  "create-ws-token": "WebSocket → Access WebSockets API",
  "add-withdraw-address": "Funds → Add withdrawal addresses",
  "update-withdraw-address": "Funds → Update withdrawal addresses",
};

export const READ_ONLY_NOTICE = "This application only needs read-only access.";

const label = (p: string) => PERMISSION_LABELS[p] ?? `"${p}" (unrecognized permission)`;

export interface KeyInfo {
  readonly permissions: readonly string[];
  /** Unix seconds; 0 = unrestricted. */
  readonly queryFrom: number;
  readonly queryTo: number;
  readonly validUntil: number;
}

export interface PermissionAssessment {
  readonly missing: readonly string[];
  readonly dangerous: readonly string[];
  /** Permissions this app does not recognize: refused, since their effect is unknown. */
  readonly unrecognized: readonly string[];
  readonly unnecessary: readonly string[];
  readonly optional: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Parse only the fields we need. The response also contains the API key string
 * and the account IBAN; they are deliberately never read or retained.
 */
export function parseKeyInfo(result: unknown): KeyInfo {
  if (!result || typeof result !== "object") {
    throw new ProviderError("invalid_response", "Kraken GetApiKeyInfo returned an invalid result", false);
  }
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r["permissions"]) || !r["permissions"].every((p) => typeof p === "string")) {
    throw new ProviderError("invalid_response", "Kraken GetApiKeyInfo returned invalid permissions", false);
  }
  const ts = (v: unknown): number => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);
  return {
    permissions: [...(r["permissions"] as string[])],
    queryFrom: ts(r["queryFrom"]),
    queryTo: ts(r["queryTo"]),
    validUntil: ts(r["validUntil"]),
  };
}

export function assessPermissions(info: KeyInfo, nowSeconds: number): PermissionAssessment {
  const granted = new Set(info.permissions);
  const known = new Set<string>([
    ...REQUIRED_PERMISSIONS,
    ...OPTIONAL_PERMISSIONS,
    ...UNNECESSARY_READ_PERMISSIONS,
    ...DANGEROUS_PERMISSIONS,
  ]);
  const missing = REQUIRED_PERMISSIONS.filter((p) => !granted.has(p));
  const dangerous = DANGEROUS_PERMISSIONS.filter((p) => granted.has(p));
  const unnecessary = UNNECESSARY_READ_PERMISSIONS.filter((p) => granted.has(p));
  const optional = OPTIONAL_PERMISSIONS.filter((p) => granted.has(p));
  const unrecognized = [...granted].filter((p) => !known.has(p)).sort();

  const warnings: string[] = [READ_ONLY_NOTICE];
  if (unnecessary.length > 0) {
    warnings.push(`Not needed (read-only, allowed): ${unnecessary.map(label).join(", ")}. You may remove them.`);
  }
  if (info.queryFrom > 0 || info.queryTo > 0) {
    warnings.push(
      "This key restricts the date range it can query. History outside that range will be missing and balances may not reconcile. Use a key without a query date range.",
    );
  }
  if (info.validUntil > 0) {
    warnings.push(
      info.validUntil <= nowSeconds
        ? "This key has expired."
        : `This key expires on ${new Date(info.validUntil * 1000).toISOString().slice(0, 10)}; syncing will stop working after that.`,
    );
  }
  return { missing, dangerous, unrecognized, unnecessary, optional, warnings };
}

/** Turn an assessment into the connection outcome: refuse on missing, dangerous or unrecognized permissions. */
export function permissionError(a: PermissionAssessment): ProviderError | null {
  if (a.dangerous.length > 0 || a.unrecognized.length > 0) {
    const remove = [...a.dangerous, ...a.unrecognized].map(label).join("; ");
    return new ProviderError(
      "excessive_permissions",
      `${READ_ONLY_NOTICE} This key has permissions that can change your account and was not saved. Remove: ${remove}.`,
      false,
    );
  }
  if (a.missing.length > 0) {
    return new ProviderError(
      "insufficient_permissions",
      `The API key is missing required read-only permissions: ${a.missing.map(label).join("; ")}.`,
      false,
    );
  }
  return null;
}
