import { krakenDefinition } from "./kraken";
import { ProviderRegistry } from "./registry";

/** All provider implementations available in this build. */
export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry().register(krakenDefinition);
}
