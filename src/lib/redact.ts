/**
 * Best-effort removal of secret-looking material from text before it is logged
 * or stored (e.g. in sync_runs.error_message). Credentials must never be logged
 * in the first place; this is a safety net for third-party error messages.
 */

const SECRET_KEY_VALUE =
  /\b(api[-_]?key|api[-_]?secret|secret|private[-_]?key|password|passphrase|token|signature|api-sign|otp)\b(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi;

/** Long base64/hex-like runs: API keys, signatures, nonces with key material. */
const LONG_TOKEN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_KEY_VALUE, "$1$2[REDACTED]").replace(LONG_TOKEN, "[REDACTED]");
}

/** Safe, bounded error text for logs and persistence. */
export function safeErrorMessage(error: unknown, maxLength = 500): string {
  const raw =
    error instanceof Error ? `${error.name}: ${error.message}` : typeof error === "string" ? error : "Unknown error";
  const redacted = redactSecrets(raw);
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}
