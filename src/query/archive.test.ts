import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { SYSTEM_LOINC, ingestRecord } from '../records/index.js';
import { MemoryBlobStore } from '../storage/index.js';
import { ArchiveCache } from './archive.js';

async function ingestFixture(store: MemoryBlobStore, name: string): Promise<string> {
  const path = fileURLToPath(new URL(`../records/__fixtures__/${name}`, import.meta.url));
  const { key } = await ingestRecord(store, (p) => Promise.resolve(p), {
    path,
    kind: 'ccda',
    source: 'test',
  });
  return key;
}

describe('ArchiveCache.listDocuments', () => {
  let store: MemoryBlobStore;
  let cache: ArchiveCache;

  beforeEach(() => {
    store = new MemoryBlobStore();
    cache = new ArchiveCache(store);
  });

  it('returns one entry per ingested CCDA with metadata', async () => {
    const richKey = await ingestFixture(store, 'ccda-rich-ccd.xml');
    const encKey = await ingestFixture(store, 'ccda-encounter.xml');
    const docs = await cache.listDocuments();
    expect(docs).toHaveLength(2);

    const rich = docs.find((d) => d.key === richKey);
    expect(rich).toMatchObject({
      kind: 'ccda',
      document_type: 'ccd',
      document_date: '2024-06-15',
      document_date_range: { from: '2024-06-15', to: '2024-06-15' },
    });
    expect(rich?.observation_count).toBeGreaterThan(0);
    expect(rich?.contributors_to).toEqual(
      expect.arrayContaining(['observations', 'problems', 'medications']),
    );

    const enc = docs.find((d) => d.key === encKey);
    expect(enc?.document_type).toBe('encounter');
    expect(enc?.contributors_to).toEqual(['observations']);
  });
});

describe('ArchiveCache.listMetrics', () => {
  it('aggregates LOINC observations across documents', async () => {
    const store = new MemoryBlobStore();
    await ingestFixture(store, 'ccda-rich-ccd.xml');
    await ingestFixture(store, 'ccda-encounter.xml');
    const cache = new ArchiveCache(store);
    const metrics = await cache.listMetrics();

    const ldl = metrics.find((m) => m.coding.code === '13457-7');
    expect(ldl?.coding.system).toBe(SYSTEM_LOINC);
    expect(ldl?.observation_count).toBe(1);
    expect(ldl?.unit).toBe('mg/dL');
    expect(ldl?.first_observed).toBe('2024-06-15');
    expect(ldl?.last_observed).toBe('2024-06-15');

    const glucose = metrics.find((m) => m.coding.code === '2345-7');
    expect(glucose?.observation_count).toBe(1);
  });
});

describe('ArchiveCache.getObservationHistory', () => {
  it('filters by codings and returns observations sorted by date', async () => {
    const store = new MemoryBlobStore();
    const richKey = await ingestFixture(store, 'ccda-rich-ccd.xml');
    const questKey = await ingestFixture(store, 'ccda-quest-translation.xml');
    const cache = new ArchiveCache(store);
    const history = await cache.getObservationHistory({
      codings: [{ system: SYSTEM_LOINC, code: '13457-7' }],
    });
    expect(history).toHaveLength(2);
    expect(history[0]?.date).toBe('2023-11-20');
    expect(history[0]?.source_document_key).toBe(questKey);
    expect(history[1]?.date).toBe('2024-06-15');
    expect(history[1]?.source_document_key).toBe(richKey);
    expect(history.every((o) => o.coding.code === '13457-7')).toBe(true);
  });

  it('merges multiple codings', async () => {
    const store = new MemoryBlobStore();
    await ingestFixture(store, 'ccda-rich-ccd.xml');
    const cache = new ArchiveCache(store);
    const history = await cache.getObservationHistory({
      codings: [
        { system: SYSTEM_LOINC, code: '13457-7' },
        { system: SYSTEM_LOINC, code: '4548-4' },
      ],
    });
    expect(history.map((o) => o.coding.code).sort()).toEqual(['13457-7', '4548-4']);
  });

  it('applies since/until date filters', async () => {
    const store = new MemoryBlobStore();
    await ingestFixture(store, 'ccda-rich-ccd.xml');
    await ingestFixture(store, 'ccda-quest-translation.xml');
    const cache = new ArchiveCache(store);
    const history = await cache.getObservationHistory({
      codings: [{ system: SYSTEM_LOINC, code: '13457-7' }],
      since: '2024-01-01',
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.date).toBe('2024-06-15');
  });
});

describe('ArchiveCache.getCurrentProblems', () => {
  it('returns problems from the most recent CCD-shaped document', async () => {
    const store = new MemoryBlobStore();
    const richKey = await ingestFixture(store, 'ccda-rich-ccd.xml');
    await ingestFixture(store, 'ccda-encounter.xml');
    const cache = new ArchiveCache(store);
    const result = await cache.getCurrentProblems();
    expect(result.source_document_key).toBe(richKey);
    expect(result.source_document_date).toBe('2024-06-15');
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.coding.code).toBe('E78.5');
  });

  it('returns empty + note when no CCD-shaped document exists', async () => {
    const store = new MemoryBlobStore();
    await ingestFixture(store, 'ccda-encounter.xml');
    const cache = new ArchiveCache(store);
    const result = await cache.getCurrentProblems();
    if (result.source_document_key !== null) throw new Error('expected no CCD');
    expect(result.source_document_date).toBeNull();
    expect(result.problems).toEqual([]);
    expect(result.note).toMatch(/no CCD-shaped/i);
  });
});

describe('ArchiveCache.getCurrentMedications', () => {
  it('returns medications from the most recent CCD-shaped document', async () => {
    const store = new MemoryBlobStore();
    const richKey = await ingestFixture(store, 'ccda-rich-ccd.xml');
    await ingestFixture(store, 'ccda-encounter.xml');
    const cache = new ArchiveCache(store);
    const result = await cache.getCurrentMedications();
    expect(result.source_document_key).toBe(richKey);
    expect(result.source_document_date).toBe('2024-06-15');
    expect(result.medications).toHaveLength(1);
    expect(result.medications[0]?.coding.code).toBe('617314');
  });

  it('returns empty + note when no CCD-shaped document exists', async () => {
    const store = new MemoryBlobStore();
    await ingestFixture(store, 'ccda-encounter.xml');
    const cache = new ArchiveCache(store);
    const result = await cache.getCurrentMedications();
    if (result.source_document_key !== null) throw new Error('expected no CCD');
    expect(result.source_document_date).toBeNull();
    expect(result.medications).toEqual([]);
    expect(result.note).toMatch(/no CCD-shaped/i);
  });
});
