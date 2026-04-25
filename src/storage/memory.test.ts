import { describe, expect, it } from 'vitest';

import { runBlobStoreContract } from './blob-store.contract.js';
import { MemoryBlobStore } from './memory.js';

runBlobStoreContract('MemoryBlobStore', () => new MemoryBlobStore());

describe('MemoryBlobStore specifics', () => {
  it('preserves contentType across put and head', async () => {
    const store = new MemoryBlobStore();
    await store.put('a.json', new TextEncoder().encode('{}'), 'application/json');
    const meta = await store.head('a.json');
    expect(meta?.contentType).toBe('application/json');
  });

  it('isolates put bytes from later mutation by the caller', async () => {
    const store = new MemoryBlobStore();
    const bytes = new Uint8Array([1, 2, 3]);
    await store.put('iso', bytes);
    bytes[0] = 99;
    const got = await store.get('iso');
    expect(Array.from(got)).toEqual([1, 2, 3]);
  });
});
