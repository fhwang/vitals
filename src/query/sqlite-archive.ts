import {
  buildConfidenceByDate,
  getFitbitFreshnessFrontier,
  type ConfidenceByDate,
} from '#adapters';
import type { Db } from '#db';
import {
  kindRegistry,
  type Coding,
  type Medication,
  type Observation,
  type ParsedDocument,
  type Problem,
} from '#records';
import { getInflated, type BlobStore } from '#storage';
import type { DailyBucketRow } from './sqlite-rows.js';
import {
  findMostRecentCcdKey,
  queryDailyPeriodMinutes,
  queryDocumentRows,
  queryMetricRows,
  queryObservationRows,
  queryTotalPeriodMinutes,
  rowToDocumentSummary,
  rowToMetric,
  rowToObservation,
} from './sqlite-rows.js';

export type DocumentContributor = 'observations' | 'problems' | 'medications';

export interface DocumentSummary {
  key: string;
  kind: string;
  ingested_at: string;
  source: string;
  original_filename: string;
  document_type: ParsedDocument['document_type'];
  document_date: string;
  document_date_range: ParsedDocument['document_date_range'];
  observation_count: number;
  contributors_to: DocumentContributor[];
}

export interface MetricCatalogEntry {
  coding: Coding;
  observation_count: number;
  first_observed: string;
  last_observed: string;
  unit: string | null;
}

export interface ObservationHistoryQuery {
  codings: Coding[];
  since?: string;
  until?: string;
}

export interface PeriodDurationQuery {
  coding: Coding;
  start_date: string;
  end_date: string;
  min_value: number;
  max_value: number;
  bucket: 'none' | 'day';
}

export interface PeriodDurationMeta {
  // Per-date confidence covering every date in [start_date, end_date] inclusive.
  // Use this to tag bucket entries OR to reason about dates the query returned
  // no rows for (e.g., "did zero workouts happen, or is Saturday's data still
  // arriving?"). Currently derived from Fitbit adapter state regardless of
  // query coding — accurate for Fitbit-sourced data, conservative for others.
  confidence_by_date: ConfidenceByDate[];
  // ISO timestamp of the most recent sample observed by the Fitbit adapter,
  // or null if Fitbit has never synced successfully. Lets callers display a
  // "data fresh as of …" line without a second query.
  freshness_frontier_at: string | null;
}

export type PeriodDurationTotalResult = PeriodDurationMeta & { total_minutes: number };

export type PeriodDurationBucketedResult = PeriodDurationMeta & {
  per_bucket: DailyBucketRow[];
};

export type PeriodDurationResult = PeriodDurationTotalResult | PeriodDurationBucketedResult;

type CcdSnapshotMeta =
  | { source_document_key: string; source_document_date: string }
  | { source_document_key: null; source_document_date: null; note: string };

export type CurrentProblemsResult = CcdSnapshotMeta & { problems: Problem[] };
export type CurrentMedicationsResult = CcdSnapshotMeta & { medications: Medication[] };

export type SqliteArchive = ReturnType<typeof createSqliteArchive>;

export function createSqliteArchive(db: Db, store: BlobStore) {
  return {
    listDocuments: (): DocumentSummary[] => queryDocumentRows(db).map(rowToDocumentSummary),
    listMetrics: (): MetricCatalogEntry[] => queryMetricRows(db).map(rowToMetric),
    getObservationHistory: (query: ObservationHistoryQuery): Observation[] =>
      query.codings.length === 0 ? [] : queryObservationRows(db, query).map(rowToObservation),
    getPeriodDurationInValueRange: (query: PeriodDurationQuery): PeriodDurationResult =>
      buildPeriodDurationResult(db, query),
    getCurrentProblems: (): Promise<CurrentProblemsResult> => loadCurrentProblems(db, store),
    getCurrentMedications: (): Promise<CurrentMedicationsResult> =>
      loadCurrentMedications(db, store),
  };
}

function buildPeriodDurationResult(db: Db, query: PeriodDurationQuery): PeriodDurationResult {
  const meta: PeriodDurationMeta = {
    confidence_by_date: buildConfidenceByDate(db, new Date(), [query.start_date, query.end_date]),
    freshness_frontier_at: getFitbitFreshnessFrontier(db),
  };
  if (query.bucket === 'none') {
    return { ...meta, total_minutes: queryTotalPeriodMinutes(db, query) };
  }
  return { ...meta, per_bucket: queryDailyPeriodMinutes(db, query) };
}

async function loadCurrentProblems(db: Db, store: BlobStore): Promise<CurrentProblemsResult> {
  const key = findMostRecentCcdKey(db);
  if (key === null) {
    return {
      source_document_key: null,
      source_document_date: null,
      problems: [],
      note: 'no CCD-shaped document in archive',
    };
  }
  const parsed = await loadParsedCcd(store, key);
  return {
    source_document_key: key,
    source_document_date: parsed.document_date,
    problems: parsed.problems,
  };
}

async function loadCurrentMedications(db: Db, store: BlobStore): Promise<CurrentMedicationsResult> {
  const key = findMostRecentCcdKey(db);
  if (key === null) {
    return {
      source_document_key: null,
      source_document_date: null,
      medications: [],
      note: 'no CCD-shaped document in archive',
    };
  }
  const parsed = await loadParsedCcd(store, key);
  return {
    source_document_key: key,
    source_document_date: parsed.document_date,
    medications: parsed.medications,
  };
}

async function loadParsedCcd(store: BlobStore, key: string): Promise<ParsedDocument> {
  const bytes = await getInflated(store, key);
  return kindRegistry.ccda.parseDocument(bytes);
}
