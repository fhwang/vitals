import { describe, expect, it } from 'vitest';

import { hashBytes } from './hash.js';

describe('hashBytes', () => {
  it('produces a sha256: prefix and 64 hex chars', () => {
    const result = hashBytes(new TextEncoder().encode('hello'));
    expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic for the same bytes', () => {
    const bytes = new TextEncoder().encode('vitals');
    expect(hashBytes(bytes)).toBe(hashBytes(bytes));
  });
});
