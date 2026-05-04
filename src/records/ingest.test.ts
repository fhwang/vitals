import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, sourceDocuments, type Db } from '#db';
import { MemoryBlobStore, getInflated } from '#storage';
import { RecordParseError } from './errors.js';
import { ingestRecord } from './ingest.js';

const passthroughValidator = (p: string) => Promise.resolve(p);

function makeDeps(store: MemoryBlobStore, db: Db) {
  return { store, db, validatePath: passthroughValidator };
}

describe('ingestRecord', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vitals-ingest-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const fixture = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20201015143211-0500"/>
</ClinicalDocument>`;

  it('writes gzipped blob + source_documents row + observations rows', async () => {
    const filePath = join(tmpDir, 'visit.xml');
    await writeFile(filePath, fixture, 'utf8');
    const store = new MemoryBlobStore();
    const db = openDatabase(':memory:');

    const result = await ingestRecord(makeDeps(store, db), {
      path: filePath,
      kind: 'ccda',
      source: 'portal-export',
    });

    expect(result.kind).toBe('ccda');
    expect(result.key).toMatch(/^ccda\/[0-9a-f]{64}\.xml\.gz$/);
    expect(result.already_ingested).toBe(false);

    const meta = await store.head(result.key);
    expect(meta).not.toBeNull();
    expect(meta?.contentType).toBe('application/gzip');

    const inflated = await getInflated(store, result.key);
    expect(new TextDecoder().decode(inflated)).toBe(fixture);

    const sourceRow = db
      .select({
        source: sourceDocuments.source,
        original_filename: sourceDocuments.original_filename,
        content_hash: sourceDocuments.content_hash,
      })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.archive_key, result.key))
      .get();
    expect(sourceRow?.source).toBe('portal-export');
    expect(sourceRow?.original_filename).toBe('visit.xml');
    expect(sourceRow?.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is idempotent: same bytes produce the same key and a single source_documents row', async () => {
    const filePath = join(tmpDir, 'visit.xml');
    await writeFile(filePath, fixture, 'utf8');
    const store = new MemoryBlobStore();
    const db = openDatabase(':memory:');

    const first = await ingestRecord(makeDeps(store, db), {
      path: filePath,
      kind: 'ccda',
      source: 'portal-export',
    });
    const second = await ingestRecord(makeDeps(store, db), {
      path: filePath,
      kind: 'ccda',
      source: 'portal-export-rerun',
    });

    expect(second.key).toBe(first.key);
    expect(second.already_ingested).toBe(true);

    const allDocs = db.select().from(sourceDocuments).all();
    expect(allDocs).toHaveLength(1);
  });

  it('throws UnsupportedKindError for an unknown kind', async () => {
    const store = new MemoryBlobStore();
    const db = openDatabase(':memory:');
    await expect(
      ingestRecord(makeDeps(store, db), {
        path: '/anywhere',
        kind: 'unknown-kind',
        source: 'x',
      }),
    ).rejects.toThrow(/unsupported kind/);
  });

  it('surfaces validator failures (e.g., path outside roots)', async () => {
    const store = new MemoryBlobStore();
    const db = openDatabase(':memory:');
    const deps = {
      store,
      db,
      validatePath: () => Promise.reject(new Error('outside roots')),
    };
    await expect(ingestRecord(deps, { path: '/nope', kind: 'ccda', source: 'x' })).rejects.toThrow(
      /outside roots/,
    );
  });

  it('throws FileNotFoundError when the file does not exist', async () => {
    const store = new MemoryBlobStore();
    const db = openDatabase(':memory:');
    await expect(
      ingestRecord(makeDeps(store, db), {
        path: join(tmpDir, 'does-not-exist.xml'),
        kind: 'ccda',
        source: 'x',
      }),
    ).rejects.toThrow(/file not found/);
  });

  it('surfaces RecordParseError when bytes are not valid CCDA', async () => {
    const filePath = join(tmpDir, 'garbage.xml');
    await writeFile(filePath, '<NotCCDA/>', 'utf8');
    const store = new MemoryBlobStore();
    const db = openDatabase(':memory:');
    await expect(
      ingestRecord(makeDeps(store, db), {
        path: filePath,
        kind: 'ccda',
        source: 'x',
      }),
    ).rejects.toThrow(/parse failed for ccda/);
  });

  it('rejects ingestion when parseDocument throws RecordParseError', async () => {
    const fixturePath = fileURLToPath(
      new URL('./__fixtures__/ccda-self-check-fail.xml', import.meta.url),
    );
    const store = new MemoryBlobStore();
    const db = openDatabase(':memory:');
    await expect(
      ingestRecord(makeDeps(store, db), {
        path: fixturePath,
        kind: 'ccda',
        source: 'test',
      }),
    ).rejects.toBeInstanceOf(RecordParseError);
  });
});
