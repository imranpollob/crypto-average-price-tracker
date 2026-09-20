import { InvalidCredentialsInputError, type ProviderCredentials, type ProviderDefinition } from "../types";
import { isValidKrakenSecret } from "./auth";
import { KrakenClient, type KrakenClientOptions } from "./client";
import { KRAKEN_FEE_CREDIT_ASSETS } from "./mapper";
import { KrakenMarketData } from "./market-data";
import { PROVIDER_TYPE } from "./normalizer";
import { DANGEROUS_PERMISSIONS, OPTIONAL_PERMISSIONS, PERMISSION_LABELS, REQUIRED_PERMISSIONS } from "./permissions";
import { KrakenProvider, PERMISSION_WARNING } from "./provider";

export { KrakenMarketData } from "./market-data";
export { KrakenProvider, PERMISSION_WARNING } from "./provider";

export function krakenCredentialsFrom(credentials: ProviderCredentials): { apiKey: string; apiSecret: string } {
  const apiKey = credentials["apiKey"]?.trim() ?? "";
  const apiSecret = credentials["apiSecret"]?.trim() ?? "";
  if (!apiKey) throw new InvalidCredentialsInputError("Kraken API key is required");
  if (!isValidKrakenSecret(apiSecret)) {
    throw new InvalidCredentialsInputError("Kraken private key must be the base64 value shown by Kraken");
  }
  return { apiKey, apiSecret };
}

export function createKrakenProvider(
  providerAccountId: string,
  credentials: ProviderCredentials,
  clientOptions: Omit<KrakenClientOptions, "credentials"> = {},
): KrakenProvider {
  const client = new KrakenClient({ ...clientOptions, credentials: krakenCredentialsFrom(credentials) });
  return new KrakenProvider(providerAccountId, client, clientOptions.now ? () => new Date(clientOptions.now!()) : undefined);
}

export const krakenDefinition: ProviderDefinition = {
  type: PROVIDER_TYPE,
  displayName: "Kraken",
  kind: "exchange",
  credentialFields: [
    { key: "apiKey", label: "API key", secret: false },
    { key: "apiSecret", label: "Private key", secret: true },
  ],
  setup: {
    requiredPermissions: REQUIRED_PERMISSIONS.map((p) => PERMISSION_LABELS[p]!),
    optionalPermissions: OPTIONAL_PERMISSIONS.map((p) => `${PERMISSION_LABELS[p]!} (used in a later version)`),
    forbiddenPermissions: DANGEROUS_PERMISSIONS.map((p) => PERMISSION_LABELS[p]!),
    securityNote: PERMISSION_WARNING,
  },
  feeCreditAssets: KRAKEN_FEE_CREDIT_ASSETS,
  createProvider: (providerAccountId, credentials) => createKrakenProvider(providerAccountId, credentials),
  // Public endpoints only: no credentials are involved in price lookups.
  createMarketData: () => new KrakenMarketData(new KrakenClient({})),
};
