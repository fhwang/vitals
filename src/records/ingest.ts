import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { eq } from 'drizzle-orm';

import { observations as observationsTable, sourceDocuments, type Db } from '#db';
import { serializeMetadata, type DocumentMetadata } from '#query';
import { gzipKey, hashBytes, putGzipped, type BlobStore } from '#storage';
import { FileNotFoundError, UnsupportedKindError } from './errors.js';
import { kindRegistry, type Kind } from './kind-registry.js';
import type { Observation, ParsedDocument } from './types.js';

export interface IngestInput {
  path: string;
  kind: string;
  source: string;
  original_filename?: string;
}

export interface IngestDeps {
  store: BlobStore;
  db: Db;
  validatePath: (path: string) => Promise<string>;
}

export interface IngestResult {
  key: string;
  kind: Kind;
  source_document_id: number;
  observations_inserted: number;
  already_ingested: boolean;
}

export interface PreparedIngest {
  kind: Kind;
  bytes: Uint8Array;
  parsed: ParsedDocument;
  fullHash: string;
  archiveKey: string;
}

async function readBytesOrThrow(realPath: string, originalPath: string): Promise<Uint8Array> {
  try {
    return await readFile(realPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new FileNotFoundError(originalPath);
    throw err;
  }
}

function resolveKind(kind: string): Kind {
  if (!Object.prototype.hasOwnProperty.call(kindRegistry, kind)) {
    throw new UnsupportedKindError(kind, Object.keys(kindRegistry));
  }
  return kind as Kind;
}

function buildArchiveKey(kind: Kind, fullHash: string): string {
  const handler = kindRegistry[kind];
  const hex = fullHash.slice('sha256:'.length);
  return gzipKey(`${handler.kind}/${hex}.${handler.extension}`);
}

function buildCcdaMetadata(parsed: ParsedDocument): DocumentMetadata {
  const contributors: DocumentMetadata['contributors_to'] = [];
  if (parsed.observations.length > 0) contributors.push('observations');
  if (parsed.problems.length > 0) contributors.push('problems');
  if (parsed.medications.length > 0) contributors.push('medications');
  return {
    document_type: parsed.document_type,
    document_date: parsed.document_date,
    document_date_range: parsed.document_date_range,
    contributors_to: contributors,
  };
}

function existingSourceDocumentId(db: Db, archiveKey: string): number | null {
  const row = db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.archive_key, archiveKey))
    .get();
  return row?.id ?? null;
}

function insertObservations(
  db: Db,
  sourceDocumentId: number,
  observations: readonly Observation[],
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

function insertSourceDocument(db: Db, prepared: PreparedIngest, input: IngestInput): number {
  const row = db
    .insert(sourceDocuments)
    .values({
      kind: prepared.kind,
      source: input.source,
      original_filename: input.original_filename ?? basename(input.path),
      ingested_at: new Date().toISOString(),
      archive_key: prepared.archiveKey,
      content_hash: prepared.fullHash,
      metadata_json: serializeMetadata(buildCcdaMetadata(prepared.parsed)),
    })
    .returning({ id: sourceDocuments.id })
    .get();
  if (row === undefined) throw new Error('insertSourceDocument returned no row');
  return row.id;
}

function indexCcda(
  db: Db,
  prepared: PreparedIngest,
  input: IngestInput,
): { id: number; observationsInserted: number } {
  return db.transaction((tx) => {
    const sourceDocumentId = insertSourceDocument(tx, prepared, input);
    const observationsInserted = insertObservations(
      tx,
      sourceDocumentId,
      prepared.parsed.observations,
    );
    return { id: sourceDocumentId, observationsInserted };
  });
}

async function prepareIngest(deps: IngestDeps, input: IngestInput): Promise<PreparedIngest> {
  const kind = resolveKind(input.kind);
  const realPath = await deps.validatePath(input.path);
  const bytes = await readBytesOrThrow(realPath, input.path);
  kindRegistry[kind].validateBytes(bytes);
  const parsed = kindRegistry[kind].parseDocument(bytes);
  const fullHash = hashBytes(bytes);
  const archiveKey = buildArchiveKey(kind, fullHash);
  return { kind, bytes, parsed, fullHash, archiveKey };
}

async function commitPreparedIngest(
  deps: IngestDeps,
  prepared: PreparedIngest,
  input: IngestInput,
): Promise<IngestResult> {
  const existingId = existingSourceDocumentId(deps.db, prepared.archiveKey);
  if (existingId !== null) {
    return {
      key: prepared.archiveKey,
      kind: prepared.kind,
      source_document_id: existingId,
      observations_inserted: 0,
      already_ingested: true,
    };
  }
  await putGzipped(deps.store, prepared.archiveKey, prepared.bytes);
  const { id, observationsInserted } = indexCcda(deps.db, prepared, input);
  return {
    key: prepared.archiveKey,
    kind: prepared.kind,
    source_document_id: id,
    observations_inserted: observationsInserted,
    already_ingested: false,
  };
}

export async function ingestRecord(deps: IngestDeps, input: IngestInput): Promise<IngestResult> {
  const prepared = await prepareIngest(deps, input);
  return commitPreparedIngest(deps, prepared, input);
}
