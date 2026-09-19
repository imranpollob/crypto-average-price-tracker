import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { CredentialCipher, CredentialDecryptionError, loadOrCreateKey } from "./cipher";

const dir = mkdtempSync(join(tmpdir(), "capt-key-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("credential encryption", () => {
  const cipher = new CredentialCipher(randomBytes(32));
  const creds = { apiKey: "public-key", apiSecret: "c2VjcmV0LXZhbHVlLXRoYXQtbXVzdC1uZXZlci1sZWFr" };

  it("round-trips and never stores plaintext", () => {
    const payload = cipher.encryptJson(creds);
    expect(payload).not.toContain(creds.apiSecret);
    expect(payload).not.toContain(creds.apiKey);
    expect(cipher.decryptJson(payload)).toEqual(creds);
  });

  it("uses a fresh IV per encryption", () => {
    expect(cipher.encryptJson(creds)).not.toBe(cipher.encryptJson(creds));
  });

  it("detects tampering and wrong keys", () => {
    const payload = cipher.encryptJson(creds);
    const parts = payload.split(":");
    const tampered = [...parts.slice(0, 3), Buffer.from("tampered").toString("base64")].join(":");
    expect(() => cipher.decryptJson(tampered)).toThrow(CredentialDecryptionError);
    expect(() => new CredentialCipher(randomBytes(32)).decryptJson(payload)).toThrow(CredentialDecryptionError);
    expect(() => cipher.decrypt("garbage")).toThrow(CredentialDecryptionError);
  });

  it("does not expose the key when serialized", () => {
    expect(JSON.stringify({ cipher })).toBe('{"cipher":"[CredentialCipher]"}');
  });
});

describe("key management", () => {
  it("creates a key file once and reuses it", () => {
    const file = join(dir, "sub", "master.key");
    const a = loadOrCreateKey({ keyFile: file });
    const b = loadOrCreateKey({ keyFile: file });
    expect(a.equals(b)).toBe(true);
    expect(Buffer.from(readFileSync(file, "utf8"), "base64")).toHaveLength(32);
  });

  it("prefers APP_ENCRYPTION_KEY and validates it", () => {
    const key = randomBytes(32);
    expect(loadOrCreateKey({ env: key.toString("base64"), keyFile: join(dir, "unused.key") }).equals(key)).toBe(true);
    expect(() => loadOrCreateKey({ env: "c2hvcnQ=", keyFile: join(dir, "unused.key") })).toThrow(/32 bytes/);
  });
});
