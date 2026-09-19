/**
 * Lossless JSON parsing: every number is returned as its exact source text.
 *
 * Kraken sends amounts as strings but timestamps and counts as JSON numbers;
 * parsing those with plain JSON.parse would pass them through binary floats.
 * Uses the JSON.parse source-text access reviver (Node ≥ 21).
 */

type ReviverContext = { source?: string };

export function parseJsonLossless(text: string): unknown {
  return JSON.parse(text, function (this: unknown, _key: string, value: unknown, context?: ReviverContext) {
    if (typeof value !== "number") return value;
    if (!context || typeof context.source !== "string") {
      throw new Error("This Node.js version lacks JSON.parse source-text access (Node >= 21 required)");
    }
    return context.source;
  } as (key: string, value: unknown) => unknown);
}
