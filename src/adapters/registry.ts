import type { Adapter } from './types.js';

export class AdapterRegistry {
  private readonly adapters = new Map<string, Adapter>();

  register(adapter: Adapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`adapter already registered: ${adapter.name}`);
    }
    this.adapters.set(adapter.name, adapter);
  }

  list(): Adapter[] {
    return [...this.adapters.values()];
  }

  get(name: string): Adapter | undefined {
    return this.adapters.get(name);
  }
}
