import type { Adapter } from './types.js';

export type AdapterRegistry = ReturnType<typeof createAdapterRegistry>;

export function createAdapterRegistry() {
  const adapters = new Map<string, Adapter>();
  return {
    register(adapter: Adapter): void {
      if (adapters.has(adapter.name)) {
        throw new Error(`adapter already registered: ${adapter.name}`);
      }
      adapters.set(adapter.name, adapter);
    },
    list(): Adapter[] {
      return [...adapters.values()];
    },
    get(name: string): Adapter | undefined {
      return adapters.get(name);
    },
  };
}
