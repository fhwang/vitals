import type { CodingRegistry, ConfidenceByDate, QueryPlanSlot } from '#adapters';
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
import { buildLongestContinuousResult } from './longest-continuous-archive.js';
import type { DailyLongestRow, LongestRunResult } from './longest-continuous.js';
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

export interface LongestContinuousQuery {
  coding: Coding;
  start_date: string;
  end_date: string;
  min_value: number;
  max_value: number;
  bucket: 'none' | 'day';
  // Default 0 (strict adjacency). Two adjacent observations are part of the
  // same run if next.effective_start - prev.effective_end <= gap_seconds.
  // For run-length-encoded sleep stages this is 0; for sample-stream data
  // (HR samples with polling artifacts) it can be relaxed.
  gap_seconds: number;
}

export type LongestContinuousTotalResult = PeriodDurationMeta & LongestRunResult;
export type LongestContinuousBucketedResult = PeriodDurationMeta & {
  per_bucket: DailyLongestRow[];
};
export type LongestContinuousResult =
  | LongestContinuousTotalResult
  | LongestContinuousBucketedResult;

export interface PeriodDurationMeta {
  // Per-date confidence covering every date in [start_date, end_date] inclusive.
  // Routed through the coding registry: queries against Fitbit-native codings
  // get Fitbit's confidence; queries against Oura-native or AASM-canonical
  // codings get Oura's. Multi-adapter canonical codings combine providers
  // (most-conservative confidence, min frontier).
  confidence_by_date: ConfidenceByDate[];
  // ISO timestamp of the most recent observation timestamp the relevant
  // adapter(s) have seen for the query's coding, or null when no adapter
  // routes to this coding (or none have synced successfully).
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

export function createSqliteArchive(db: Db, store: BlobStore, codings: CodingRegistry) {
  return {
    listDocuments: (): DocumentSummary[] => queryDocumentRows(db).map(rowToDocumentSummary),
    listMetrics: (): MetricCatalogEntry[] => queryMetricRows(db).map(rowToMetric),
    getObservationHistory: (query: ObservationHistoryQuery): Observation[] =>
      query.codings.length === 0 ? [] : queryObservationRows(db, query).map(rowToObservation),
    getPeriodDurationInValueRange: (query: PeriodDurationQuery): PeriodDurationResult =>
      buildPeriodDurationResult(db, codings, query),
    getLongestContinuousPeriodInValueRange: (
      query: LongestContinuousQuery,
    ): LongestContinuousResult => buildLongestContinuousResult(db, codings, query),
    getCurrentProblems: (): Promise<CurrentProblemsResult> => loadCurrentProblems(db, store),
    getCurrentMedications: (): Promise<CurrentMedicationsResult> =>
      loadCurrentMedications(db, store),
  };
}

function buildPeriodDurationResult(
  db: Db,
  codings: CodingRegistry,
  query: PeriodDurationQuery,
): PeriodDurationResult {
  const meta = buildPeriodDurationMeta(codings, query);
  const slots = codings.planQuery(query.coding, {
    min: query.min_value,
    max: query.max_value,
  });
  if (query.bucket === 'none') {
    return { ...meta, total_minutes: totalMinutesAcrossSlots(db, query, slots) };
  }
  return { ...meta, per_bucket: dailyMinutesAcrossSlots(db, query, slots) };
}

export function buildPeriodDurationMeta(
  codings: CodingRegistry,
  query: PeriodDurationQuery,
): PeriodDurationMeta {
  const provider = codings.getConfidenceProvider(query.coding);
  const now = new Date();
  return {
    confidence_by_date:
      provider?.buildConfidenceByDate(now, [query.start_date, query.end_date]) ?? [],
    freshness_frontier_at: provider?.getFreshnessFrontier() ?? null,
  };
}

function applySlot(query: PeriodDurationQuery, slot: QueryPlanSlot): PeriodDurationQuery {
  return {
    ...query,
    coding: slot.native_coding,
    min_value: slot.native_value_range.min,
    max_value: slot.native_value_range.max,
  };
}

function totalMinutesForSlot(db: Db, query: PeriodDurationQuery, slot: QueryPlanSlot): number {
  return queryTotalPeriodMinutes(db, applySlot(query, slot));
}

function dailyMinutesForSlot(
  db: Db,
  query: PeriodDurationQuery,
  slot: QueryPlanSlot,
): readonly DailyBucketRow[] {
  return queryDailyPeriodMinutes(db, applySlot(query, slot));
}

function totalMinutesAcrossSlots(
  db: Db,
  query: PeriodDurationQuery,
  slots: readonly QueryPlanSlot[],
): number {
  return slots.reduce((acc, slot) => acc + totalMinutesForSlot(db, query, slot), 0);
}

function dailyMinutesAcrossSlots(
  db: Db,
  query: PeriodDurationQuery,
  slots: readonly QueryPlanSlot[],
): DailyBucketRow[] {
  const map = new Map<string, number>();
  for (const slot of slots) {
    addSlotMinutes(map, dailyMinutesForSlot(db, query, slot));
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket_start, minutes]) => ({ bucket_start, minutes }));
}

function addSlotMinutes(map: Map<string, number>, rows: readonly DailyBucketRow[]): void {
  for (const row of rows) {
    map.set(row.bucket_start, (map.get(row.bucket_start) ?? 0) + row.minutes);
  }
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
