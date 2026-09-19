import { createHash, createHmac } from "node:crypto";

/**
 * Kraken private REST authentication (docs/kraken-api-notes.md):
 *
 *   API-Sign = base64( HMAC-SHA512( base64decode(secret), uriPath + SHA256(nonce + postData) ) )
 *
 * The secret only ever lives inside the closure returned by `createSigner`; it
 * is never stored on an object that could be logged or serialized.
 */

export type Signer = (uriPath: string, nonce: string, postData: string) => string;

export class InvalidSecretError extends Error {
  constructor() {
    super("The Kraken private key is not valid base64");
    this.name = "InvalidSecretError";
  }
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function isValidKrakenSecret(secret: string): boolean {
  const s = secret.trim();
  return s.length >= 16 && s.length % 4 === 0 && BASE64.test(s);
}

export function createSigner(secretBase64: string): Signer {
  if (!isValidKrakenSecret(secretBase64)) throw new InvalidSecretError();
  const key = Buffer.from(secretBase64.trim(), "base64");
  return (uriPath, nonce, postData) => {
    const inner = createHash("sha256").update(nonce + postData).digest();
    return createHmac("sha512", key)
      .update(Buffer.concat([Buffer.from(uriPath), inner]))
      .digest("base64");
  };
}

/**
 * Strictly increasing nonce per API key: microsecond-scaled wall clock, bumped
 * by one if the clock has not advanced (or went backwards). Stays increasing
 * across app restarts as long as the clock does not jump back.
 */
export class NonceGenerator {
  private last = 0n;

  next(nowMs: number): string {
    let n = BigInt(Math.floor(nowMs)) * 1000n;
    if (n <= this.last) n = this.last + 1n;
    this.last = n;
    return n.toString();
  }
}
