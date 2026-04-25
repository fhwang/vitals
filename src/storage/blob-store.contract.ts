import { beforeEach, describe, expect, it } from 'vitest';

import type { BlobEntry, BlobStore } from './blob-store.js';

type BlobStoreFactory = () => Promise<BlobStore> | BlobStore;

export function runBlobStoreContract(name: string, factory: BlobStoreFactory): void {
  describePutGetHead(name, factory);
  describeListing(name, factory);
  describeDelete(name, factory);
  describeKeyRejection(name, factory);
}

function describePutGetHead(name: string, factory: BlobStoreFactory): void {
  describe(`BlobStore contract: ${name} — put/get/head`, () => {
    let store: BlobStore;
    beforeEach(async () => {
      store = await factory();
    });

    it('round-trips bytes via put + get', async () => {
      const bytes = new TextEncoder().encode('hello');
      await store.put('a/b.txt', bytes, 'text/plain');
      const got = await store.get('a/b.txt');
      expect(new TextDecoder().decode(got)).toBe('hello');
    });

    it('preserves binary payloads exactly', async () => {
      const bytes = new Uint8Array([0, 1, 2, 254, 255]);
      await store.put('bin/payload', bytes);
      const got = await store.get('bin/payload');
      expect(Array.from(got)).toEqual(Array.from(bytes));
    });

    it('head returns size and lastModified for an existing key', async () => {
      await store.put('m/x.txt', new TextEncoder().encode('xyz'));
      const meta = await store.head('m/x.txt');
      expect(meta).not.toBeNull();
      expect(meta?.size).toBe(3);
      expect(meta?.lastModified).toBeInstanceOf(Date);
    });

    it('head returns null for a missing key', async () => {
      const meta = await store.head('does/not/exist');
      expect(meta).toBeNull();
    });

    it('contentType round-trips when the adapter persists it (or is undefined)', async () => {
      await store.put('ct/x.json', new TextEncoder().encode('{}'), 'application/json');
      const meta = await store.head('ct/x.json');
      expect(meta).not.toBeNull();
      if (meta?.contentType !== undefined) {
        expect(meta.contentType).toBe('application/json');
      }
    });
  });
}

function describeListing(name: string, factory: BlobStoreFactory): void {
  describe(`BlobStore contract: ${name} — list`, () => {
    let store: BlobStore;
    beforeEach(async () => {
      store = await factory();
    });

    it('list returns all entries under a prefix with their sizes', async () => {
      await store.put('p/one.txt', new TextEncoder().encode('1'));
      await store.put('p/two.txt', new TextEncoder().encode('22'));
      await store.put('q/three.txt', new TextEncoder().encode('333'));
      const found = new Map<string, number>();
      for await (const entry of store.list('p/')) {
        found.set(entry.key, entry.size);
      }
      const sorted = [...found.entries()].sort(([a], [b]) => a.localeCompare(b));
      expect(sorted).toEqual([
        ['p/one.txt', 1],
        ['p/two.txt', 2],
      ]);
    });

    it('list returns empty for a prefix with no matches', async () => {
      await store.put('x/file.txt', new TextEncoder().encode('x'));
      const collected: BlobEntry[] = [];
      for await (const entry of store.list('z/')) {
        collected.push(entry);
      }
      expect(collected).toEqual([]);
    });
  });
}

function describeDelete(name: string, factory: BlobStoreFactory): void {
  describe(`BlobStore contract: ${name} — delete`, () => {
    let store: BlobStore;
    beforeEach(async () => {
      store = await factory();
    });

    it('delete removes only the named key', async () => {
      await store.put('d/a.txt', new TextEncoder().encode('a'));
      await store.put('d/b.txt', new TextEncoder().encode('b'));
      await store.delete('d/a.txt');
      expect(await store.head('d/a.txt')).toBeNull();
      expect(await store.head('d/b.txt')).not.toBeNull();
    });

    it('delete on a missing key does not throw', async () => {
      await expect(store.delete('nope/missing.txt')).resolves.toBeUndefined();
    });
  });
}

function describeKeyRejection(name: string, factory: BlobStoreFactory): void {
  describe(`BlobStore contract: ${name} — key rejection`, () => {
    let store: BlobStore;
    beforeEach(async () => {
      store = await factory();
    });

    it('rejects keys containing ..', async () => {
      await expect(store.put('../escape.txt', new TextEncoder().encode('x'))).rejects.toThrow();
    });

    it('rejects keys with leading /', async () => {
      await expect(store.put('/abs.txt', new TextEncoder().encode('x'))).rejects.toThrow();
    });

    it('rejects keys containing . segments', async () => {
      await expect(store.put('a/./b.txt', new TextEncoder().encode('x'))).rejects.toThrow();
    });

    it('rejects keys with empty path segments', async () => {
      await expect(store.put('a//b.txt', new TextEncoder().encode('x'))).rejects.toThrow();
    });

    it('rejects invalid keys on get', async () => {
      await expect(store.get('../escape.txt')).rejects.toThrow();
    });

    it('rejects invalid keys on head', async () => {
      await expect(store.head('../escape.txt')).rejects.toThrow();
    });

    it('rejects invalid keys on delete', async () => {
      await expect(store.delete('../escape.txt')).rejects.toThrow();
    });
  });
}
