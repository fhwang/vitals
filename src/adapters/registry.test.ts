import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createAdapterRegistry } from './registry.js';
import type { Adapter } from './types.js';

function makeFakeAdapter(name: string): Adapter {
  return {
    name,
    description: `fake ${name}`,
    parameter_schema: z.object({}),
    requires_auth: false,
    notification_profile: {
      display_name: name,
      auth_failure_body: `Renew ${name} credentials.`,
    },
    sync: () =>
      Promise.resolve({
        adapter: name,
        days_pulled: 0,
        samples_added: 0,
        samples_existing: 0,
        last_synced_at: '2026-04-30T00:00:00Z',
      }),
  };
}

describe('createAdapterRegistry', () => {
  it('registers and lists adapters', () => {
    const reg = createAdapterRegistry();
    reg.register(makeFakeAdapter('alpha'));
    reg.register(makeFakeAdapter('beta'));
    expect(
      reg
        .list()
        .map((a) => a.name)
        .sort(),
    ).toEqual(['alpha', 'beta']);
  });

  it('looks up by name', () => {
    const reg = createAdapterRegistry();
    reg.register(makeFakeAdapter('alpha'));
    expect(reg.get('alpha')?.name).toBe('alpha');
    expect(reg.get('missing')).toBeUndefined();
  });

  it('throws when registering a duplicate name', () => {
    const reg = createAdapterRegistry();
    reg.register(makeFakeAdapter('alpha'));
    expect(() => reg.register(makeFakeAdapter('alpha'))).toThrow(/already registered/);
  });
});
