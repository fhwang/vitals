import { eq } from 'drizzle-orm';

import { observations as observationsTable, openDatabase, sourceDocuments, type Db } from '#db';
import { serializeMetadata } from '#query';
import { kindRegistry, type ParsedDocument } from '#records';
import { LocalFsBlobStore, getInflated, hashBytes, putGzipped, type BlobStore } from '#storage';

interface BackfillArgs {
  archiveRoot: string;
  dbPath: string;
  dryRun: boolean;
}

interface BackfillStats {
  scanned: number;
  alreadyIndexed: number;
  newlyIndexed: number;
  errors: number;
  dry_run: boolean;
}

function takeNext(argv: readonly string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function flagPairs(argv: readonly string[]): { flag: string; value: string | undefined }[] {
  const out: { flag: string; value: string | undefined }[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === undefined) continue;
    if (flag === '--dry-run') {
      out.push({ flag, value: undefined });
    } else if (flag === '--archive-root' || flag === '--db-path') {
      out.push({ flag, value: takeNext(argv, i, flag) });
      i++;
    } else {
      throw new Error(`unknown arg: ${flag}`);
    }
  }
  return out;
}

function parseArgs(argv: readonly string[]): BackfillArgs {
  const pairs = flagPairs(argv);
  const archiveRoot = pairs.find((p) => p.flag === '--archive-root')?.value;
  const dbPath = pairs.find((p) => p.flag === '--db-path')?.value;
  const dryRun = pairs.some((p) => p.flag === '--dry-run');
  if (archiveRoot === undefined) throw new Error('--archive-root is required');
  if (dbPath === undefined) throw new Error('--db-path is required');
  return { archiveRoot, dbPath, dryRun };
}

function alreadyIndexed(db: Db, archiveKey: string): boolean {
  const row = db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.archive_key, archiveKey))
    .get();
  return row !== undefined;
}

function collectContributors(
  parsed: ParsedDocument,
): ('observations' | 'problems' | 'medications')[] {
  const out: ('observations' | 'problems' | 'medications')[] = [];
  if (parsed.observations.length > 0) out.push('observations');
  if (parsed.problems.length > 0) out.push('problems');
  if (parsed.medications.length > 0) out.push('medications');
  return out;
}

function insertObservations(
  db: Db,
  sourceDocumentId: number,
  observations: ParsedDocument['observations'],
): number {
  let count = 0;
  for (const obs of observations) {
    db.insert(observationsTable)
      .values({
        coding_system: obs.coding.system,
        coding_code: obs.coding.code,
        coding_display: obs.coding.display ?? null,
        effective_start: obs.effective_start,
        effective_end: obs.effective_end,
        value_quantity: typeof obs.value === 'number' ? obs.value : null,
        value_string: typeof obs.value === 'string' ? obs.value : null,
        value_unit: obs.unit,
        ref_range: obs.ref_range,
        interpretation: obs.interpretation,
        source_document_id: sourceDocumentId,
      })
      .run();
    count += 1;
  }
  return count;
}

interface CcdaCommitInputs {
  parsed: ParsedDocument;
  archiveKey: string;
  fullHash: string;
}

function ccdaSourceDocumentValues(inputs: CcdaCommitInputs) {
  return {
    kind: 'ccda',
    source: 'backfill',
    original_filename: inputs.archiveKey.split('/').pop() ?? inputs.archiveKey,
    ingested_at: new Date().toISOString(),
    archive_key: inputs.archiveKey,
    content_hash: inputs.fullHash,
    metadata_json: serializeMetadata({
      document_type: inputs.parsed.document_type,
      document_date: inputs.parsed.document_date,
      document_date_range: inputs.parsed.document_date_range,
      contributors_to: collectContributors(inputs.parsed),
    }),
  };
}

function commitCcda(db: Db, inputs: CcdaCommitInputs): void {
  db.transaction((tx) => {
    const row = tx
      .insert(sourceDocuments)
      .values(ccdaSourceDocumentValues(inputs))
      .returning({ id: sourceDocuments.id })
      .get();
    if (row === undefined) throw new Error('source_documents insert returned no row');
    insertObservations(tx, row.id, inputs.parsed.observations);
  });
}

function newStats(dryRun: boolean): BackfillStats {
  return { scanned: 0, alreadyIndexed: 0, newlyIndexed: 0, errors: 0, dry_run: dryRun };
}

function createBackfiller(db: Db, store: BlobStore, args: BackfillArgs) {
  const stats = newStats(args.dryRun);
  async function indexOne(rawKey: string, targetKey: string): Promise<void> {
    const bytes = await getInflated(store, rawKey);
    kindRegistry.ccda.validateBytes(bytes);
    const parsed = kindRegistry.ccda.parseDocument(bytes);
    if (args.dryRun) {
      process.stdout.write(
        `[dry-run] would index ${rawKey} -> ${targetKey} (${String(parsed.observations.length)} obs)\n`,
      );
      return;
    }
    if (!rawKey.endsWith('.gz')) await putGzipped(store, rawKey, bytes);
    commitCcda(db, { parsed, archiveKey: targetKey, fullHash: hashBytes(bytes) });
    if (rawKey !== targetKey) await store.delete(rawKey);
    process.stdout.write(
      `indexed ${rawKey} -> ${targetKey} (${String(parsed.observations.length)} obs)\n`,
    );
  }
  async function tryIndexOne(rawKey: string, targetKey: string): Promise<void> {
    try {
      await indexOne(rawKey, targetKey);
      stats.newlyIndexed += 1;
    } catch (err) {
      stats.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error processing ${rawKey}: ${message}\n`);
    }
  }
  return {
    stats,
    async runOne(rawKey: string): Promise<void> {
      stats.scanned += 1;
      const targetKey = rawKey.endsWith('.gz') ? rawKey : `${rawKey}.gz`;
      if (alreadyIndexed(db, targetKey) || alreadyIndexed(db, rawKey)) {
        stats.alreadyIndexed += 1;
        return;
      }
      await tryIndexOne(rawKey, targetKey);
    },
  };
}

async function* iterateCcdaCandidates(store: BlobStore): AsyncIterable<string> {
  for await (const entry of store.list('ccda/')) {
    if (entry.key.endsWith('.provenance.json')) continue;
    if (!entry.key.endsWith('.xml') && !entry.key.endsWith('.xml.gz')) continue;
    yield entry.key;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = openDatabase(args.dbPath);
  const store = new LocalFsBlobStore(args.archiveRoot);
  const runner = createBackfiller(db, store, args);
  for await (const key of iterateCcdaCandidates(store)) {
    await runner.runOne(key);
  }
  process.stdout.write(`${JSON.stringify(runner.stats, null, 2)}\n`);
  if (runner.stats.errors > 0) process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
