import { eq } from 'drizzle-orm';

import type { Db } from '../../db/index.js';
import { observations as observationsTable, sourceDocuments } from '../../db/schema.js';
import type { Observation } from '../../records/index.js';
import { hashBytes } from '../../storage/index.js';
import type { BlobStore } from '../../storage/index.js';
import { putGzipped } from '../../storage/index.js';

const FITBIT_KIND = 'fitbit-intraday-hr-day';
const FITBIT_SOURCE = 'fitbit-adapter';
const ARCHIVE_PREFIX = 'fitbit/intraday-hr/';

export interface FitbitDayInsertion {
  source_document_id: number;
  samples_added: number;
}

export type FitbitStore = ReturnType<typeof createFitbitStore>;

export function createFitbitStore(db: Db, blobs: BlobStore) {
  return {
    archiveKey: (date: string): string => archiveKeyForDate(date),
    alreadyIngested(date: string): boolean {
      const row = db
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.archive_key, archiveKeyForDate(date)))
        .get();
      return row !== undefined;
    },
    async insertDay(
      date: string,
      rawJson: unknown,
      observations: readonly Observation[],
    ): Promise<FitbitDayInsertion> {
      const archiveKey = archiveKeyForDate(date);
      const bytes = new TextEncoder().encode(JSON.stringify(rawJson));
      await putGzipped(blobs, archiveKey.replace(/\.gz$/, ''), bytes);
      return db.transaction((tx) => {
        const sourceDocumentId = insertFitbitSourceDocument(tx, date, bytes);
        const samplesAdded = insertObservationRows(tx, sourceDocumentId, observations);
        return { source_document_id: sourceDocumentId, samples_added: samplesAdded };
      });
    },
  };
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
