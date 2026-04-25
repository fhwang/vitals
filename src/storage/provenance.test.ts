import { describe, expect, it } from 'vitest';

import { MemoryBlobStore } from './memory.js';
import {
  ProvenanceSchema,
  hashBytes,
  provenanceKey,
  readProvenance,
  writeProvenance,
  type Provenance,
} from './provenance.js';

describe('provenanceKey', () => {
  it('appends .provenance.json to the blob key', () => {
    expect(provenanceKey('ccda/2020-10-15-encounter.xml')).toBe(
      'ccda/2020-10-15-encounter.xml.provenance.json',
    );
  });
});

describe('hashBytes', () => {
  it('returns sha256: prefix + 64 hex chars', () => {
    const result = hashBytes(new TextEncoder().encode('hello'));
    expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces a stable digest for the same bytes', () => {
    const bytes = new TextEncoder().encode('hello');
    expect(hashBytes(bytes)).toBe(hashBytes(bytes));
  });
});

describe('ProvenanceSchema', () => {
  const validHash = `sha256:${'a'.repeat(64)}`;

  it('rejects content_hash without sha256: prefix', () => {
    expect(() =>
      ProvenanceSchema.parse({
        source: 'a',
        ingested_at: '2026-04-25T00:00:00Z',
        original_filename: 'x.xml',
        content_hash: 'abc123',
      }),
    ).toThrow();
  });

  it('rejects empty source', () => {
    expect(() =>
      ProvenanceSchema.parse({
        source: '',
        ingested_at: '2026-04-25T00:00:00Z',
        original_filename: 'x.xml',
        content_hash: validHash,
      }),
    ).toThrow();
  });
});

describe('readProvenance / writeProvenance', () => {
  const sample: Provenance = {
    source: 'portal-export',
    ingested_at: '2026-04-25T14:32:11Z',
    original_filename: 'visit.xml',
    content_hash: `sha256:${'a'.repeat(64)}`,
  };

  it('round-trips a Provenance via the BlobStore', async () => {
    const store = new MemoryBlobStore();
    await writeProvenance(store, 'ccda/visit.xml', sample);
    const got = await readProvenance(store, 'ccda/visit.xml');
    expect(got).toEqual(sample);
  });

  it('returns null when the sidecar does not exist', async () => {
    const store = new MemoryBlobStore();
    expect(await readProvenance(store, 'ccda/missing.xml')).toBeNull();
  });
});
