import { eq } from 'drizzle-orm';

import { observations as observationsTable, sourceDocuments, type Db } from '#db';
import type { Observation } from '#records';
import { hashBytes, putGzipped, type BlobStore } from '#storage';

import { archiveKeyForSession, type ParsedSleepSession } from './parser.js';

const OURA_KIND = 'oura-sleep-session';
const OURA_SOURCE = 'oura-adapter';

export interface OuraSessionInsertion {
  source_document_id: number;
  observations_added: number;
  // Latest `bedtime_end` across inserted sessions; consumed by the adapter
  // to advance the freshness frontier on the run.
  max_session_end_at: string;
}

export type OuraStore = ReturnType<typeof createOuraStore>;

export function createOuraStore(db: Db, blobs: BlobStore) {
  const insert = async (
    session: ParsedSleepSession,
    rawJson: unknown,
  ): Promise<OuraSessionInsertion> => {
    const bytes = new TextEncoder().encode(JSON.stringify(rawJson));
    const archiveKey = archiveKeyForSession(session.session_id);
    await putGzipped(blobs, archiveKey.replace(/\.gz$/, ''), bytes);
    return db.transaction((tx) => {
      const sourceDocumentId = insertSourceDocument(tx, session, bytes);
      const observationsAdded = insertObservations(tx, sourceDocumentId, session.observations);
      return {
        source_document_id: sourceDocumentId,
        observations_added: observationsAdded,
        max_session_end_at: session.bedtime_end,
      };
    });
  };
  return {
    alreadyIngested: (sessionId: string): boolean => existsBySession(db, sessionId),
    insertSession: insert,
  };
}

function existsBySession(db: Db, sessionId: string): boolean {
  const row = db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.archive_key, archiveKeyForSession(sessionId)))
    .get();
  return row !== undefined;
}

function insertSourceDocument(db: Db, session: ParsedSleepSession, bytes: Uint8Array): number {
  const row = db
    .insert(sourceDocuments)
    .values({
      kind: OURA_KIND,
      source: OURA_SOURCE,
      original_filename: `${session.session_id}.json`,
      ingested_at: new Date().toISOString(),
      archive_key: archiveKeyForSession(session.session_id),
      content_hash: hashBytes(bytes),
      metadata_json: JSON.stringify({
        document_type: 'unknown',
        document_date: session.end_local_date,
        document_date_range: null,
        contributors_to: ['observations'],
        bedtime_start: session.bedtime_start,
        bedtime_end: session.bedtime_end,
        end_local_date: session.end_local_date,
        start_tz_offset_minutes: session.start_tz_offset_minutes,
        category: session.category,
      }),
    })
    .returning({ id: sourceDocuments.id })
    .get();
  if (row === undefined) throw new Error('insertSourceDocument returned no row');
  return row.id;
}

function insertObservations(
  db: Db,
  sourceDocumentId: number,
  observations: readonly Observation[],
): number {
  let count = 0;
  for (const obs of observations) {
    if (typeof obs.value !== 'number') continue;
    db.insert(observationsTable)
      .values({
        coding_system: obs.coding.system,
        coding_code: obs.coding.code,
        coding_display: obs.coding.display ?? null,
        effective_start: obs.effective_start,
        effective_end: obs.effective_end,
        value_quantity: obs.value,
        value_unit: obs.unit,
        source_document_id: sourceDocumentId,
      })
      .run();
    count += 1;
  }
  return count;
}
