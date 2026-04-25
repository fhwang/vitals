import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runBlobStoreContract } from './blob-store.contract.js';
import { LocalFsBlobStore } from './local-fs.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vitals-fs-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

runBlobStoreContract('LocalFsBlobStore', () => new LocalFsBlobStore(root));

describe('LocalFsBlobStore specifics', () => {
  it('rejects a non-absolute root in the constructor', () => {
    expect(() => new LocalFsBlobStore('relative/path')).toThrow(/absolute/);
  });

  it('auto-creates parent directories on put', async () => {
    const store = new LocalFsBlobStore(root);
    await store.put('deep/nested/path/file.txt', new TextEncoder().encode('x'));
    const meta = await store.head('deep/nested/path/file.txt');
    expect(meta?.size).toBe(1);
  });

  it('list returns no entries when the root is empty', async () => {
    const store = new LocalFsBlobStore(root);
    const collected: string[] = [];
    for await (const entry of store.list('')) {
      collected.push(entry.key);
    }
    expect(collected).toEqual([]);
  });

  it('list tolerates files deleted mid-walk', async () => {
    const store = new LocalFsBlobStore(root);
    await store.put('a.txt', new TextEncoder().encode('a'));
    await store.put('b.txt', new TextEncoder().encode('b'));
    await store.put('c.txt', new TextEncoder().encode('c'));

    const collected: string[] = [];
    for await (const entry of store.list('')) {
      collected.push(entry.key);
      // Delete the *other* two on the first iteration — readdir already cached
      // their dirents, but stat will now ENOENT. Iteration must not crash.
      if (collected.length === 1) {
        const others = ['a.txt', 'b.txt', 'c.txt'].filter((k) => k !== entry.key);
        for (const other of others) {
          await store.delete(other);
        }
      }
    }
    // We yielded the first entry; the other two race-stat'd to ENOENT and were
    // dropped silently. So we expect exactly 1 entry yielded total.
    expect(collected).toHaveLength(1);
  });
});
