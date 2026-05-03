import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { observations, sourceDocuments } from './schema.js';
import { openDatabase } from './connection.js';

describe('openDatabase', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'vitals-db-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('opens a fresh DB at the requested path and applies migrations', () => {
    const path = join(tmp, 'fresh.db');
    const db = openDatabase(path);
    // No throw on a SELECT against the migrated table = schema applied.
    expect(db.select().from(observations).all()).toEqual([]);
  });

  it('creates the parent directory when missing', () => {
    const path = join(tmp, 'nested', 'sub', 'vitals.db');
    openDatabase(path);
    expect(statSync(path).isFile()).toBe(true);
  });

  it('sets file mode 0600 on a freshly created DB file', () => {
    const path = join(tmp, 'mode.db');
    openDatabase(path);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('reopening an existing DB is idempotent', () => {
    const path = join(tmp, 'reopen.db');
    openDatabase(path);
    // Second open should succeed without re-running migrations.
    expect(() => openDatabase(path)).not.toThrow();
  });

  it('supports :memory: databases', () => {
    const db = openDatabase(':memory:');
    expect(db.select().from(sourceDocuments).all()).toEqual([]);
  });

  it('enforces foreign keys', () => {
    const db = openDatabase(':memory:');
    let caught: unknown;
    try {
      db.insert(observations)
        .values({
          coding_system: 'http://loinc.org',
          coding_code: '8867-4',
          effective_start: '2026-04-30T00:00:00Z',
          source_document_id: 999, // dangling FK — no source_documents row with id=999
        })
        .run();
    } catch (err) {
      caught = err;
    }
    // Drizzle wraps better-sqlite3 errors with a generic prefix; the
    // FOREIGN KEY message lives on the cause chain.
    const message = describeError(caught);
    expect(message).toMatch(/FOREIGN KEY/);
  });
});

function describeError(err: unknown): string {
  if (err === undefined) return '';
  const messages: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(' | ');
}
