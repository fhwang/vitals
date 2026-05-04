import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { observations, openDatabase, sourceDocuments } from '#db';

const SCRIPT_PATH = fileURLToPath(new URL('./backfill-sqlite.ts', import.meta.url));

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../src/records/__fixtures__/${name}`, import.meta.url));
}

interface BackfillEnv {
  archiveRoot: string;
  dbPath: string;
}

async function setupArchive(): Promise<BackfillEnv> {
  const tmp = await mkdtemp(join(tmpdir(), 'vitals-backfill-'));
  const archiveRoot = join(tmp, 'archive');
  const dbPath = join(tmp, 'vitals.db');
  await mkdir(join(archiveRoot, 'ccda'), { recursive: true });
  return { archiveRoot, dbPath };
}

async function placeFixtureBlob(env: BackfillEnv, fixture: string, hash: string): Promise<string> {
  const bytes = await readFile(fixturePath(fixture));
  const targetKey = `ccda/${hash}.xml`;
  await writeFile(join(env.archiveRoot, targetKey), bytes);
  return targetKey;
}

function runBackfill(env: BackfillEnv, extraArgs: string[] = []): string {
  return execSync(
    `tsx --conditions=development ${SCRIPT_PATH} --archive-root ${env.archiveRoot} --db-path ${env.dbPath} ${extraArgs.join(' ')}`,
    { encoding: 'utf8' },
  );
}

describe('backfill-sqlite', () => {
  let env: BackfillEnv;

  beforeEach(async () => {
    env = await setupArchive();
  });

  afterEach(async () => {
    await rm(env.archiveRoot.replace(/\/archive$/, ''), { recursive: true, force: true });
  });

  it('indexes an existing CCDA into source_documents and observations', async () => {
    await placeFixtureBlob(env, 'ccda-rich-ccd.xml', 'a'.repeat(64));
    const out = runBackfill(env);
    expect(out).toMatch(/indexed/);

    const db = openDatabase(env.dbPath);
    expect(db.select().from(sourceDocuments).all()).toHaveLength(1);
    expect(db.select().from(observations).all().length).toBeGreaterThan(0);
  });

  it('is idempotent — re-runs do not double-insert', async () => {
    await placeFixtureBlob(env, 'ccda-rich-ccd.xml', 'b'.repeat(64));
    runBackfill(env);
    runBackfill(env);

    const db = openDatabase(env.dbPath);
    expect(db.select().from(sourceDocuments).all()).toHaveLength(1);
  });

  it('respects --dry-run by leaving the DB empty and the file untouched', async () => {
    const key = await placeFixtureBlob(env, 'ccda-rich-ccd.xml', 'c'.repeat(64));
    runBackfill(env, ['--dry-run']);

    const db = openDatabase(env.dbPath);
    expect(db.select().from(sourceDocuments).all()).toHaveLength(0);
    const stillThere = await readFile(join(env.archiveRoot, key));
    expect(stillThere.byteLength).toBeGreaterThan(0);
  });
});
