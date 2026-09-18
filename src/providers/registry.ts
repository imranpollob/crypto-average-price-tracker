import type { ProviderType } from "@/domain/transactions/types";
import type { ProviderDefinition } from "./types";

/**
 * Registry of available provider implementations. Adding an exchange or wallet
 * means writing an adapter and registering it here — nothing else changes.
 *
 * Phase 1: empty. Kraken is registered in Phase 2.
 */
export class ProviderRegistry {
  private readonly definitions = new Map<ProviderType, ProviderDefinition>();

  register(definition: ProviderDefinition): this {
    if (this.definitions.has(definition.type)) {
      throw new Error(`Provider already registered: ${definition.type}`);
    }
    this.definitions.set(definition.type, definition);
    return this;
  }

  get(type: ProviderType): ProviderDefinition {
    const d = this.definitions.get(type);
    if (!d) throw new Error(`Unknown provider: ${type}`);
    return d;
  }

  has(type: ProviderType): boolean {
    return this.definitions.has(type);
  }

  list(): ProviderDefinition[] {
    return [...this.definitions.values()];
  }
}

export const providerRegistry = new ProviderRegistry();
