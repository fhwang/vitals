import { and, eq } from 'drizzle-orm';

import { adapterDayState, observations as observationsTable, sourceDocuments, type Db } from '#db';
import type { Observation } from '#records';
import { hashBytes, putGzipped, type BlobStore } from '#storage';

const FITBIT_KIND = 'fitbit-intraday-hr-day';
const FITBIT_SOURCE = 'fitbit-adapter';
const FITBIT_NAME = 'fitbit';
const ARCHIVE_PREFIX = 'fitbit/intraday-hr/';

export interface FitbitDayInsertion {
  source_document_id: number;
  samples_added: number;
  // ISO timestamp of the latest sample inserted for this day, or null if no
  // samples landed. Used by the adapter to advance the freshness frontier.
  max_sample_at: string | null;
}

export type FitbitStore = ReturnType<typeof createFitbitStore>;

export function createFitbitStore(db: Db, blobs: BlobStore) {
  return {
    archiveKey: (date: string): string => archiveKeyForDate(date),
    alreadyIngested: makeAlreadyIngested(db),
    dropDay: makeDropDay(db),
    readDayState: makeReadDayState(db),
    writeDayState: makeWriteDayState(db),
    insertDay: makeInsertDay(db, blobs),
  };
}

function makeAlreadyIngested(db: Db): (date: string) => boolean {
  return (date: string) => {
    const row = db
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.archive_key, archiveKeyForDate(date)))
      .get();
    return row !== undefined;
  };
}

// Atomically remove a day's ingestion: deletes the source_documents row by
// archive_key, which cascades to the day's observations rows. The blob in
// object storage is left in place — a subsequent insertDay overwrites it.
// Returns true if a row was removed, false if nothing was present.
function makeDropDay(db: Db): (date: string) => boolean {
  return (date: string) => {
    const archiveKey = archiveKeyForDate(date);
    const result = db
      .delete(sourceDocuments)
      .where(eq(sourceDocuments.archive_key, archiveKey))
      .run();
    return result.changes > 0;
  };
}

export function readFitbitDayState(db: Db, date: string) {
  const row = db
    .select()
    .from(adapterDayState)
    .where(and(eq(adapterDayState.adapter_name, FITBIT_NAME), eq(adapterDayState.date, date)))
    .get();
  return row ?? null;
}

function makeReadDayState(db: Db) {
  return (date: string) => readFitbitDayState(db, date);
}

// Rotates the latest count into samples_count_prev so callers can perform a
// stability check on the next pull.
function makeWriteDayState(db: Db): (date: string, samplesCount: number) => void {
  return (date: string, samplesCount: number) => {
    const now = new Date().toISOString();
    const existing = db
      .select({ samples_count: adapterDayState.samples_count })
      .from(adapterDayState)
      .where(and(eq(adapterDayState.adapter_name, FITBIT_NAME), eq(adapterDayState.date, date)))
      .get();
    const prevCount = existing?.samples_count ?? null;
    db.insert(adapterDayState)
      .values({
        adapter_name: FITBIT_NAME,
        date,
        samples_count: samplesCount,
        samples_count_prev: prevCount,
        last_pulled_at: now,
      })
      .onConflictDoUpdate({
        target: [adapterDayState.adapter_name, adapterDayState.date],
        set: {
          samples_count: samplesCount,
          samples_count_prev: prevCount,
          last_pulled_at: now,
        },
      })
      .run();
  };
}

function makeInsertDay(
  db: Db,
  blobs: BlobStore,
): (
  date: string,
  rawJson: unknown,
  observations: readonly Observation[],
) => Promise<FitbitDayInsertion> {
  return async (date, rawJson, observations) => {
    const archiveKey = archiveKeyForDate(date);
    const bytes = new TextEncoder().encode(JSON.stringify(rawJson));
    await putGzipped(blobs, archiveKey.replace(/\.gz$/, ''), bytes);
    return db.transaction((tx) => {
      const sourceDocumentId = insertFitbitSourceDocument(tx, date, bytes);
      const samplesAdded = insertObservationRows(tx, sourceDocumentId, observations);
      const maxSampleAt = maxObservationStart(observations);
      return {
        source_document_id: sourceDocumentId,
        samples_added: samplesAdded,
        max_sample_at: maxSampleAt,
      };
    });
  };
}

function maxObservationStart(observations: readonly Observation[]): string | null {
  let max: string | null = null;
  for (const obs of observations) {
    if (typeof obs.value !== 'number') continue;
    if (max === null || obs.effective_start > max) max = obs.effective_start;
  }
  return max;
}

function archiveKeyForDate(date: string): string {
  return `${ARCHIVE_PREFIX}${date}.json.gz`;
}

function insertFitbitSourceDocument(db: Db, date: string, bytes: Uint8Array): number {
  const row = db
    .insert(sourceDocuments)
    .values({
      kind: FITBIT_KIND,
      source: FITBIT_SOURCE,
      original_filename: `${date}.json`,
      ingested_at: new Date().toISOString(),
      archive_key: archiveKeyForDate(date),
      content_hash: hashBytes(bytes),
      metadata_json: JSON.stringify({
        document_type: 'unknown',
        document_date: date,
        document_date_range: null,
        contributors_to: ['observations'],
      }),
    })
    .returning({ id: sourceDocuments.id })
    .get();
  if (row === undefined) throw new Error('insertFitbitSourceDocument returned no row');
  return row.id;
}

function insertObservationRows(
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
