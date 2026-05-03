import { and, asc, between, eq, gte, lte, or, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/index.js';
import { observations, sourceDocuments } from '../db/schema.js';
import type { Coding, Observation, ParsedDocument } from '../records/index.js';
import type {
  DocumentContributor,
  DocumentSummary,
  MetricCatalogEntry,
  ObservationHistoryQuery,
  PeriodDurationQuery,
} from './sqlite-archive.js';

export interface DocumentMetadata {
  document_type: ParsedDocument['document_type'];
  document_date: string;
  document_date_range: ParsedDocument['document_date_range'];
  contributors_to: DocumentContributor[];
}

const DEFAULT_METADATA: DocumentMetadata = {
  document_type: 'unknown',
  document_date: '',
  document_date_range: null,
  contributors_to: [],
};

export function parseMetadata(json: string | null): DocumentMetadata {
  if (json === null) return DEFAULT_METADATA;
  return JSON.parse(json) as DocumentMetadata;
}

export function serializeMetadata(meta: DocumentMetadata): string {
  return JSON.stringify(meta);
}

export type ObservationRowFromSql = typeof observations.$inferSelect & {
  archive_key: string;
};

function buildHistoryWhere(query: ObservationHistoryQuery): SQL | undefined {
  const codingMatch = or(
    ...query.codings.map((c) =>
      and(eq(observations.coding_system, c.system), eq(observations.coding_code, c.code)),
    ),
  );
  const conditions: (SQL | undefined)[] = [codingMatch];
  if (query.since !== undefined) {
    conditions.push(gte(observations.effective_start, `${query.since}T00:00:00Z`));
  }
  if (query.until !== undefined) {
    conditions.push(lte(observations.effective_start, `${query.until}T23:59:59Z`));
  }
  return and(...conditions);
}

export function queryObservationRows(
  db: Db,
  query: ObservationHistoryQuery,
): ObservationRowFromSql[] {
  return db
    .select({
      id: observations.id,
      coding_system: observations.coding_system,
      coding_code: observations.coding_code,
      coding_display: observations.coding_display,
      effective_start: observations.effective_start,
      effective_end: observations.effective_end,
      value_quantity: observations.value_quantity,
      value_string: observations.value_string,
      value_unit: observations.value_unit,
      ref_range: observations.ref_range,
      interpretation: observations.interpretation,
      source_document_id: observations.source_document_id,
      archive_key: sourceDocuments.archive_key,
    })
    .from(observations)
    .innerJoin(sourceDocuments, eq(sourceDocuments.id, observations.source_document_id))
    .where(buildHistoryWhere(query))
    .orderBy(asc(observations.effective_start))
    .all();
}

export function rowToObservation(row: ObservationRowFromSql): Observation {
  const value: number | string = row.value_quantity ?? row.value_string ?? '';
  const coding: Coding = {
    system: row.coding_system,
    code: row.coding_code,
    ...(row.coding_display !== null ? { display: row.coding_display } : {}),
  };
  return {
    coding,
    date: row.effective_start.slice(0, 10),
    effective_start: row.effective_start,
    effective_end: row.effective_end,
    value,
    unit: row.value_unit,
    ref_range: row.ref_range,
    interpretation: row.interpretation,
    source_document_key: row.archive_key,
  };
}

export type DocumentRowFromSql = typeof sourceDocuments.$inferSelect & {
  observation_count: number;
};

export function queryDocumentRows(db: Db): DocumentRowFromSql[] {
  return db
    .select({
      id: sourceDocuments.id,
      kind: sourceDocuments.kind,
      source: sourceDocuments.source,
      original_filename: sourceDocuments.original_filename,
      ingested_at: sourceDocuments.ingested_at,
      archive_key: sourceDocuments.archive_key,
      content_hash: sourceDocuments.content_hash,
      metadata_json: sourceDocuments.metadata_json,
      observation_count: sql<number>`(
        SELECT COUNT(*) FROM ${observations} WHERE ${observations.source_document_id} = ${sourceDocuments.id}
      )`,
    })
    .from(sourceDocuments)
    .orderBy(asc(sourceDocuments.ingested_at))
    .all();
}

export function rowToDocumentSummary(row: DocumentRowFromSql): DocumentSummary {
  const meta = parseMetadata(row.metadata_json);
  return {
    key: row.archive_key,
    kind: row.kind,
    ingested_at: row.ingested_at,
    source: row.source,
    original_filename: row.original_filename ?? '',
    document_type: meta.document_type,
    document_date: meta.document_date,
    document_date_range: meta.document_date_range,
    observation_count: row.observation_count,
    contributors_to: meta.contributors_to,
  };
}

export interface MetricRowFromSql {
  coding_system: string;
  coding_code: string;
  coding_display: string | null;
  observation_count: number;
  first_observed: string;
  last_observed: string;
  distinct_units: number;
  any_unit: string | null;
}

export function queryMetricRows(db: Db): MetricRowFromSql[] {
  return db
    .select({
      coding_system: observations.coding_system,
      coding_code: observations.coding_code,
      coding_display: sql<string | null>`MAX(${observations.coding_display})`,
      observation_count: sql<number>`COUNT(*)`,
      first_observed: sql<string>`MIN(${observations.effective_start})`,
      last_observed: sql<string>`MAX(${observations.effective_start})`,
      distinct_units: sql<number>`COUNT(DISTINCT ${observations.value_unit})`,
      any_unit: sql<string | null>`MAX(${observations.value_unit})`,
    })
    .from(observations)
    .groupBy(observations.coding_system, observations.coding_code)
    .all();
}

export function rowToMetric(row: MetricRowFromSql): MetricCatalogEntry {
  return {
    coding: {
      system: row.coding_system,
      code: row.coding_code,
      ...(row.coding_display !== null ? { display: row.coding_display } : {}),
    },
    observation_count: row.observation_count,
    first_observed: row.first_observed.slice(0, 10),
    last_observed: row.last_observed.slice(0, 10),
    unit: row.distinct_units === 1 ? row.any_unit : null,
  };
}

// Period-duration math: SUM of (effective_end - effective_start) in minutes.
// Filters: coding match, value_quantity within [min, max] inclusive,
// effective_end IS NOT NULL (excludes instant observations naturally),
// effective_start within the date_range.
function periodMinutesSum(): SQL<number> {
  return sql<number>`SUM((julianday(${observations.effective_end}) - julianday(${observations.effective_start})) * 1440)`;
}

function periodFilter(query: PeriodDurationQuery): SQL | undefined {
  return and(
    eq(observations.coding_system, query.coding.system),
    eq(observations.coding_code, query.coding.code),
    sql`${observations.effective_end} IS NOT NULL`,
    gte(observations.effective_start, `${query.start_date}T00:00:00Z`),
    lte(observations.effective_start, `${query.end_date}T23:59:59Z`),
    between(observations.value_quantity, query.min_value, query.max_value),
  );
}

export function queryTotalPeriodMinutes(db: Db, query: PeriodDurationQuery): number {
  const row = db
    .select({ total: periodMinutesSum() })
    .from(observations)
    .where(periodFilter(query))
    .get();
  return row?.total ?? 0;
}

export interface DailyBucketRow {
  bucket_start: string;
  minutes: number;
}

export function queryDailyPeriodMinutes(db: Db, query: PeriodDurationQuery): DailyBucketRow[] {
  const bucketStart = sql<string>`substr(${observations.effective_start}, 1, 10)`;
  return db
    .select({
      bucket_start: bucketStart,
      minutes: periodMinutesSum(),
    })
    .from(observations)
    .where(periodFilter(query))
    .groupBy(bucketStart)
    .orderBy(bucketStart)
    .all();
}

export function findMostRecentCcdKey(db: Db): string | null {
  const rows = db
    .select({
      archive_key: sourceDocuments.archive_key,
      metadata_json: sourceDocuments.metadata_json,
    })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.kind, 'ccda'))
    .all();
  let bestKey: string | null = null;
  let bestDate = '';
  for (const row of rows) {
    const meta = parseMetadata(row.metadata_json);
    if (meta.document_type !== 'ccd') continue;
    if (bestKey === null || meta.document_date > bestDate) {
      bestKey = row.archive_key;
      bestDate = meta.document_date;
    }
  }
  return bestKey;
}
