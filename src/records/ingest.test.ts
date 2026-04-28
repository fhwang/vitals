import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryBlobStore, readProvenance } from '../storage/index.js';
import { ingestRecord } from './ingest.js';

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

  const passthroughValidator = (p: string) => Promise.resolve(p);

  it('writes blob + provenance and returns a content-hashed key', async () => {
    const filePath = join(tmpDir, 'visit.xml');
    await writeFile(filePath, fixture, 'utf8');
    const store = new MemoryBlobStore();

    const result = await ingestRecord(store, passthroughValidator, {
      path: filePath,
      kind: 'ccda',
      source: 'portal-export',
    });

    expect(result.kind).toBe('ccda');
    expect(result.key).toMatch(/^ccda\/[0-9a-f]{64}\.xml$/);

    const meta = await store.head(result.key);
    expect(meta).not.toBeNull();
    expect(meta?.size).toBe(new TextEncoder().encode(fixture).byteLength);

    const provenance = await readProvenance(store, result.key);
    expect(provenance).not.toBeNull();
    expect(provenance?.source).toBe('portal-export');
    expect(provenance?.original_filename).toBe('visit.xml');
    expect(provenance?.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is idempotent: same bytes produce the same key', async () => {
    const filePath = join(tmpDir, 'visit.xml');
    await writeFile(filePath, fixture, 'utf8');
    const store = new MemoryBlobStore();

    const first = await ingestRecord(store, passthroughValidator, {
      path: filePath,
      kind: 'ccda',
      source: 'portal-export',
    });
    const second = await ingestRecord(store, passthroughValidator, {
      path: filePath,
      kind: 'ccda',
      source: 'portal-export-rerun',
    });

    expect(second.key).toBe(first.key);

    const entries: string[] = [];
    for await (const entry of store.list('ccda/')) entries.push(entry.key);
    // one blob + one provenance sidecar — same bytes never produce two .xml entries
    expect(entries.filter((k) => k.endsWith('.xml')).length).toBe(1);
  });

  it('throws UnsupportedKindError for an unknown kind', async () => {
    const store = new MemoryBlobStore();
    await expect(
      ingestRecord(store, passthroughValidator, {
        path: '/anywhere',
        kind: 'unknown-kind',
        source: 'x',
      }),
    ).rejects.toThrow(/unsupported kind/);
  });

  it('surfaces validator failures (e.g., path outside roots)', async () => {
    const store = new MemoryBlobStore();
    const rejecting = () => Promise.reject(new Error('outside roots'));
    await expect(
      ingestRecord(store, rejecting, { path: '/nope', kind: 'ccda', source: 'x' }),
    ).rejects.toThrow(/outside roots/);
  });

  it('throws FileNotFoundError when the file does not exist', async () => {
    const store = new MemoryBlobStore();
    await expect(
      ingestRecord(store, passthroughValidator, {
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
    await expect(
      ingestRecord(store, passthroughValidator, {
        path: filePath,
        kind: 'ccda',
        source: 'x',
      }),
    ).rejects.toThrow(/parse failed for ccda/);
  });
});
