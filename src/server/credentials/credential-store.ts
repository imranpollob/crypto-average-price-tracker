import type { ProviderCredentials } from "@/providers/types";
import type { Db } from "../db/client";
import type { CredentialCipher } from "./cipher";

/**
 * Encrypted credential persistence. Plaintext credentials exist only in server
 * memory while a provider is being created; they are never returned to the
 * browser, logged, or stored unencrypted.
 */
export class CredentialStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: CredentialCipher,
  ) {}

  async save(providerAccountId: string, credentials: ProviderCredentials): Promise<void> {
    await this.db.providerAccount.update({
      where: { id: providerAccountId },
      data: { encryptedCredentials: this.cipher.encryptJson(credentials) },
    });
  }

  async load(providerAccountId: string): Promise<ProviderCredentials | null> {
    const row = await this.db.providerAccount.findUniqueOrThrow({
      where: { id: providerAccountId },
      select: { encryptedCredentials: true },
    });
    return row.encryptedCredentials ? this.cipher.decryptJson(row.encryptedCredentials) : null;
  }

  async clear(providerAccountId: string): Promise<void> {
    await this.db.providerAccount.update({ where: { id: providerAccountId }, data: { encryptedCredentials: null } });
  }
}
