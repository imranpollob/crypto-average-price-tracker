import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Encryption at rest for provider credentials (AES-256-GCM, authenticated).
 *
 * Key source, in order:
 *   1. APP_ENCRYPTION_KEY — base64 of 32 random bytes
 *   2. a key file (default ./data/master.key), created on first use with
 *      owner-only permissions where the OS supports it
 *
 * Threat model (local MVP): protects credentials in the SQLite file, its
 * backups and copies. It does not protect against someone who can read both
 * the database and the key file (i.e. full access to this user account).
 */

const VERSION = "v1";
const KEY_BYTES = 32;

export class CredentialDecryptionError extends Error {
  constructor() {
    super("Stored credentials could not be decrypted (wrong key or corrupted data)");
    this.name = "CredentialDecryptionError";
  }
}

export class CredentialCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error("Encryption key must be 32 bytes");
    this.key = key;
  }

  toJSON(): string {
    return "[CredentialCipher]";
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split(":");
    if (version !== VERSION || !iv || !tag || !data) throw new CredentialDecryptionError();
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new CredentialDecryptionError();
    }
  }

  encryptJson(value: Readonly<Record<string, string>>): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson(payload: string): Record<string, string> {
    const parsed: unknown = JSON.parse(this.decrypt(payload));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CredentialDecryptionError();
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"));
  }
}

export function loadOrCreateKey(options: { env?: string | undefined; keyFile: string }): Buffer {
  if (options.env) {
    const key = Buffer.from(options.env, "base64");
    if (key.length !== KEY_BYTES) throw new Error("APP_ENCRYPTION_KEY must be base64 of exactly 32 bytes");
    return key;
  }
  if (existsSync(options.keyFile)) {
    const key = Buffer.from(readFileSync(options.keyFile, "utf8").trim(), "base64");
    if (key.length !== KEY_BYTES) throw new Error(`Key file ${options.keyFile} is corrupted`);
    return key;
  }
  mkdirSync(dirname(options.keyFile), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(options.keyFile, key.toString("base64"), { mode: 0o600, flag: "wx" });
  try {
    chmodSync(options.keyFile, 0o600);
  } catch {
    // Not supported on every filesystem (e.g. Windows ACLs); best effort.
  }
  return key;
}
