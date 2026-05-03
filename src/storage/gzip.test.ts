import { describe, expect, it } from 'vitest';

import { getInflated, gzipKey, putGzipped } from './gzip.js';
import { MemoryBlobStore } from './memory.js';

describe('gzipKey', () => {
  it('appends .gz when missing', () => {
    expect(gzipKey('ccda/abc.xml')).toBe('ccda/abc.xml.gz');
  });

  it('is idempotent — does not double-suffix', () => {
    expect(gzipKey('ccda/abc.xml.gz')).toBe('ccda/abc.xml.gz');
  });
});

describe('putGzipped + getInflated', () => {
  it('round-trips bytes through compressed storage', async () => {
    const store = new MemoryBlobStore();
    const original = new TextEncoder().encode('<?xml version="1.0"?><doc>'.repeat(64) + '</doc>');

    const key = await putGzipped(store, 'ccda/test.xml', original);
    expect(key).toBe('ccda/test.xml.gz');

    const meta = await store.head(key);
    expect(meta?.contentType).toBe('application/gzip');
    // gzip should compress the repeated XML to something smaller than original
    expect(meta?.size).toBeLessThan(original.byteLength);

    const inflated = await getInflated(store, key);
    expect(inflated).toEqual(original);
  });

  it('getInflated returns raw bytes when key does not end in .gz', async () => {
    const store = new MemoryBlobStore();
    const original = new TextEncoder().encode('plain bytes');
    await store.put('plain/file.txt', original);

    const result = await getInflated(store, 'plain/file.txt');
    expect(result).toEqual(original);
  });
});
