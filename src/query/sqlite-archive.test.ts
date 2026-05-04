import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { observations as observationsTable, openDatabase, sourceDocuments, type Db } from '#db';
import { SYSTEM_LOINC, ingestRecord } from '#records';
import { MemoryBlobStore } from '#storage';
import { createSqliteArchive, type SqliteArchive } from './sqlite-archive.js';

async function ingestFixture(store: MemoryBlobStore, db: Db, name: string): Promise<string> {
  const path = fileURLToPath(new URL(`../records/__fixtures__/${name}`, import.meta.url));
  const { key } = await ingestRecord(
    { store, db, validatePath: (p) => Promise.resolve(p) },
    { path, kind: 'ccda', source: 'test' },
  );
  return key;
}

describe('SqliteArchive.listDocuments', () => {
  let store: MemoryBlobStore;
  let db: Db;
  let archive: SqliteArchive;

  beforeEach(() => {
    store = new MemoryBlobStore();
    db = openDatabase(':memory:');
    archive = createSqliteArchive(db, store);
  });

  it('returns one entry per ingested CCDA with metadata', async () => {
    const richKey = await ingestFixture(store, db, 'ccda-rich-ccd.xml');
    const encKey = await ingestFixture(store, db, 'ccda-encounter.xml');
    const docs = archive.listDocuments();
    expect(docs).toHaveLength(2);

    expect(richKey).toMatch(/^ccda\/[0-9a-f]{64}\.xml\.gz$/);
    expect(encKey).toMatch(/^ccda\/[0-9a-f]{64}\.xml\.gz$/);

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

describe('SqliteArchive.listMetrics', () => {
  it('aggregates LOINC observations across documents', async () => {
    const store = new MemoryBlobStore();
    const db = openDatabase(':memory:');
    await ingestFixture(store, db, 'ccda-rich-ccd.xml');
    await ingestFixture(store, db, 'ccda-encounter.xml');
    const archive = createSqliteArchive(db, store);
    const metrics = archive.listMetrics();

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

describe('SqliteArchive.getObservationHistory', () => {
  it('filters by codings and returns observations sorted by effective_start', async () => {
    const store = new MemoryBlobStore();
    const db = openDatabase(':memory:');
    const richKey = await ingestFixture(store, db, 'ccda-rich-ccd.xml');
    const questKey = await ingestFixture(store, db, 'ccda-quest-translation.xml');
    const archive = createSqliteArchive(db, store);
    const history = archive.getObservationHistory({
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
    const db = openDatabase(':memory:');
    await ingestFixture(store, db, 'ccda-rich-ccd.xml');
    const archive = createSqliteArchive(db, store);
    const history = archive.getObservationHistory({
      codings: [
        { system: SYSTEM_LOINC, code: '13457-7' },
        { system: SYSTEM_LOINC, code: '4548-4' },
      ],
    });
    expect(history.map((o) => o.coding.code).sort()).toEqual(['13457-7', '4548-4']);
  });

  it('applies since/until date filters', async () => {
    const store = new MemoryBlobStore();
    const db = openDatabase(':memory:');
    await ingestFixture(store, db, 'ccda-rich-ccd.xml');
    await ingestFixture(store, db, 'ccda-quest-translation.xml');
    const archive = createSqliteArchive(db, store);
    const history = archive.getObservationHistory({
      codings: [{ system: SYSTEM_LOINC, code: '13457-7' }],
      since: '2024-01-01',
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.date).toBe('2024-06-15');
  });
});

describe('SqliteArchive.getCurrentProblems', () => {
  it('returns problems from the most recent CCD-shaped document', async () => {
    const store = new MemoryBlobStore();
    const db = openDatabase(':memory:');
    const richKey = await ingestFixture(store, db, 'ccda-rich-ccd.xml');
    await ingestFixture(store, db, 'ccda-encounter.xml');
    const archive = createSqliteArchive(db, store);
    const result = await archive.getCurrentProblems();
    expect(result.source_document_key).toBe(richKey);
    expect(result.source_document_date).toBe('2024-06-15');
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.coding.code).toBe('E78.5');
  });

  it('returns empty + note when no CCD-shaped document exists', async () => {
    const store = new MemoryBlobStore();
    const db = openDatabase(':memory:');
    await ingestFixture(store, db, 'ccda-encounter.xml');
    const archive = createSqliteArchive(db, store);
    const result = await archive.getCurrentProblems();
    if (result.source_document_key !== null) throw new Error('expected no CCD');
    expect(result.source_document_date).toBeNull();
    expect(result.problems).toEqual([]);
    expect(result.note).toMatch(/no CCD-shaped/i);
  });
});

describe('SqliteArchive.getCurrentMedications', () => {
  it('returns medications from the most recent CCD-shaped document', async () => {
    const store = new MemoryBlobStore();
    const db = openDatabase(':memory:');
    const richKey = await ingestFixture(store, db, 'ccda-rich-ccd.xml');
    await ingestFixture(store, db, 'ccda-encounter.xml');
    const archive = createSqliteArchive(db, store);
    const result = await archive.getCurrentMedications();
    expect(result.source_document_key).toBe(richKey);
    expect(result.source_document_date).toBe('2024-06-15');
    expect(result.medications).toHaveLength(1);
    expect(result.medications[0]?.coding.code).toBe('617314');
  });

  it('returns empty + note when no CCD-shaped document exists', async () => {
    const store = new MemoryBlobStore();
    const db = openDatabase(':memory:');
    await ingestFixture(store, db, 'ccda-encounter.xml');
    const archive = createSqliteArchive(db, store);
    const result = await archive.getCurrentMedications();
    if (result.source_document_key !== null) throw new Error('expected no CCD');
    expect(result.source_document_date).toBeNull();
    expect(result.medications).toEqual([]);
    expect(result.note).toMatch(/no CCD-shaped/i);
  });
});

describe('SqliteArchive.getPeriodDurationInValueRange', () => {
  // Synthesize period-shaped observations directly into SQLite (Fitbit-style
  // minute samples) — easier than building a CCDA fixture for periods.
  function seedHrSamples(db: Db, samples: { start: string; end: string; bpm: number }[]): void {
    const sourceDocId = db
      .insert(sourceDocuments)
      .values({
        kind: 'ccda',
        source: 'fitbit',
        original_filename: 'fake.json',
        ingested_at: '2026-04-30T00:00:00Z',
        archive_key: 'fitbit/fake.json.gz',
        content_hash: 'sha256:fake',
        metadata_json: JSON.stringify({
          document_type: 'unknown',
          document_date: '2026-04-30',
          document_date_range: null,
          contributors_to: ['observations'],
        }),
      })
      .returning({ id: sourceDocuments.id })
      .get()?.id;
    if (sourceDocId === undefined) throw new Error('seed insert returned no id');
    for (const s of samples) {
      db.insert(observationsTable)
        .values({
          coding_system: 'http://loinc.org',
          coding_code: '8867-4',
          effective_start: s.start,
          effective_end: s.end,
          value_quantity: s.bpm,
          value_unit: '/min',
          source_document_id: sourceDocId,
        })
        .run();
    }
  }

  it('sums total minutes for periods whose value falls in range', () => {
    const db = openDatabase(':memory:');
    seedHrSamples(db, [
      { start: '2026-04-28T10:00:00Z', end: '2026-04-28T10:01:00Z', bpm: 110 }, // in range
      { start: '2026-04-28T10:01:00Z', end: '2026-04-28T10:02:00Z', bpm: 115 }, // in range
      { start: '2026-04-28T10:02:00Z', end: '2026-04-28T10:03:00Z', bpm: 90 }, // below
      { start: '2026-04-28T10:03:00Z', end: '2026-04-28T10:04:00Z', bpm: 130 }, // above
    ]);
    const archive = createSqliteArchive(db, new MemoryBlobStore());
    const result = archive.getPeriodDurationInValueRange({
      coding: { system: 'http://loinc.org', code: '8867-4' },
      start_date: '2026-04-28',
      end_date: '2026-04-28',
      min_value: 101,
      max_value: 118,
      bucket: 'none',
    });
    if (!('total_minutes' in result)) throw new Error('expected total_minutes shape');
    expect(result.total_minutes).toBeCloseTo(2, 5);
  });

  it('groups by day when bucket=day', () => {
    const db = openDatabase(':memory:');
    seedHrSamples(db, [
      { start: '2026-04-28T10:00:00Z', end: '2026-04-28T10:03:00Z', bpm: 110 }, // 3 min day 28
      { start: '2026-04-29T11:00:00Z', end: '2026-04-29T11:05:00Z', bpm: 115 }, // 5 min day 29
      { start: '2026-04-30T12:00:00Z', end: '2026-04-30T12:01:00Z', bpm: 200 }, // out of range
    ]);
    const archive = createSqliteArchive(db, new MemoryBlobStore());
    const result = archive.getPeriodDurationInValueRange({
      coding: { system: 'http://loinc.org', code: '8867-4' },
      start_date: '2026-04-28',
      end_date: '2026-04-30',
      min_value: 101,
      max_value: 118,
      bucket: 'day',
    });
    if (!('per_bucket' in result)) throw new Error('expected per_bucket shape');
    expect(result.per_bucket).toHaveLength(2);
    expect(result.per_bucket[0]?.bucket_start).toBe('2026-04-28');
    expect(result.per_bucket[0]?.minutes).toBeCloseTo(3, 5);
    expect(result.per_bucket[1]?.bucket_start).toBe('2026-04-29');
    expect(result.per_bucket[1]?.minutes).toBeCloseTo(5, 5);
  });

  it('excludes instant observations (effective_end IS NULL)', () => {
    const db = openDatabase(':memory:');
    const sourceDocId = db
      .insert(sourceDocuments)
      .values({
        kind: 'ccda',
        source: 'test',
        original_filename: 'instant.xml',
        ingested_at: '2026-04-30T00:00:00Z',
        archive_key: 'ccda/instant.xml.gz',
        content_hash: 'sha256:instant',
        metadata_json: null,
      })
      .returning({ id: sourceDocuments.id })
      .get()?.id;
    if (sourceDocId === undefined) throw new Error('seed insert returned no id');
    db.insert(observationsTable)
      .values({
        coding_system: 'http://loinc.org',
        coding_code: '8867-4',
        effective_start: '2026-04-28T10:00:00Z',
        effective_end: null,
        value_quantity: 110,
        source_document_id: sourceDocId,
      })
      .run();
    const archive = createSqliteArchive(db, new MemoryBlobStore());
    const result = archive.getPeriodDurationInValueRange({
      coding: { system: 'http://loinc.org', code: '8867-4' },
      start_date: '2026-04-28',
      end_date: '2026-04-28',
      min_value: 0,
      max_value: 1000,
      bucket: 'none',
    });
    if (!('total_minutes' in result)) throw new Error('expected total_minutes shape');
    expect(result.total_minutes).toBe(0);
  });
});
