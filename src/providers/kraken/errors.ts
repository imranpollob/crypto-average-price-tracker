import { ProviderError, type ProviderErrorCode } from "../types";

/**
 * Map Kraken error strings to normalized provider errors.
 *
 * Messages contain only Kraken's fixed error codes plus our own wording —
 * never request bodies, headers, keys or signatures.
 */

/** Which read-only permission each private endpoint needs (for helpful messages). */
export const REQUIRED_PERMISSION: Readonly<Record<string, string>> = {
  Balance: "Query Funds",
  TradesHistory: "Query Closed Orders & Trades",
  Ledgers: "Query Ledger Entries",
};

interface Rule {
  readonly match: (e: string) => boolean;
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly message: (e: string, method: string) => string;
}

const starts = (prefix: string) => (e: string) => e.startsWith(prefix);

export const TWO_FACTOR_UNSUPPORTED =
  "API-key 2FA is not supported in this version. Create a dedicated read-only API key without API-key 2FA.";

/** Hint added to authentication failures: Kraken documents no specific 2FA error string. */
const TWO_FACTOR_HINT = " If this key has API-key 2FA enabled: " + TWO_FACTOR_UNSUPPORTED;

const RULES: readonly Rule[] = [
  {
    // Any error that explicitly mentions an OTP / two-factor code.
    match: (e) => /otp|2fa|two.?factor/i.test(e),
    code: "unsupported_authentication",
    retryable: false,
    message: () => TWO_FACTOR_UNSUPPORTED,
  },
  {
    match: (e) => e.startsWith("EAPI:Invalid key") || e.startsWith("EAPI:Invalid signature"),
    code: "invalid_credentials",
    retryable: false,
    message: (e) => `Kraken rejected the API credentials (${e}). Check the API key and private key.${TWO_FACTOR_HINT}`,
  },
  {
    match: starts("EAuth:Account"),
    code: "invalid_credentials",
    retryable: false,
    message: (e) => `Kraken reports an account problem (${e}).`,
  },
  {
    match: (e) => e.startsWith("EGeneral:Permission denied") || e.startsWith("EAccount:Invalid permissions"),
    code: "insufficient_permissions",
    retryable: false,
    message: (_e, method) =>
      method === "GetApiKeyInfo"
        ? // GetApiKeyInfo requires no permission, so a denial here is not a missing permission.
          `Kraken denied the key-information request.${TWO_FACTOR_HINT}`
        : `The API key is missing a required read-only permission: ${REQUIRED_PERMISSION[method] ?? method}.`,
  },
  {
    match: starts("EGeneral:Temporary lockout"),
    code: "rate_limited",
    // Retrying during a lockout extends it.
    retryable: false,
    message: (e) => `Kraken temporarily locked this API key (${e}). Wait a few minutes before retrying.`,
  },
  {
    match: (e) =>
      e.startsWith("EAPI:Rate limit exceeded") ||
      e.startsWith("EAuth:Rate limit exceeded") ||
      e.startsWith("EAuth:Too many requests") ||
      e.startsWith("EService:Throttled"),
    code: "rate_limited",
    retryable: true,
    message: (e) => `Kraken rate limit reached (${e}).`,
  },
  {
    match: (e) =>
      e.startsWith("EService:Unavailable") ||
      e.startsWith("EService:Busy") ||
      e.startsWith("EService:Deadline elapsed") ||
      e.startsWith("EGeneral:Internal error"),
    code: "provider_unavailable",
    retryable: true,
    message: (e) => `Kraken is unavailable (${e}).`,
  },
  {
    match: starts("EAPI:Invalid nonce"),
    code: "invalid_request",
    retryable: true,
    message: (e) => `Kraken rejected the request nonce (${e}). Is another app using this API key?`,
  },
  {
    match: starts("EGeneral:Invalid arguments"),
    code: "invalid_request",
    retryable: false,
    message: (e) => `Kraken rejected the request (${e}).`,
  },
];

/** Only the "Category:Message" part is kept; anything unexpected is truncated. */
function sanitizeKrakenError(e: string): string {
  const cleaned = e.replace(/[^\x20-\x7E]/g, "").slice(0, 120);
  return /^[EW][A-Za-z]+:/.test(cleaned) ? cleaned : "unrecognized error";
}

export function krakenError(errors: readonly string[], method: string): ProviderError {
  const first = sanitizeKrakenError(errors.find((e) => e.startsWith("E")) ?? errors[0] ?? "");
  for (const rule of RULES) {
    if (rule.match(first)) return new ProviderError(rule.code, rule.message(first, method), rule.retryable);
  }
  return new ProviderError("unknown", `Kraken returned an error for ${method} (${first}).`, false);
}

/** "EService:Throttled:<unix ts>" → milliseconds to wait, if present. */
export function throttledUntilMs(errors: readonly string[], nowMs: number): number | null {
  for (const e of errors) {
    const m = /^EService:Throttled:(\d+(?:\.\d+)?)/.exec(e);
    if (m) return Math.max(0, Math.ceil(Number(m[1]) * 1000 - nowMs));
  }
  return null;
}
