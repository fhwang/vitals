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
});
