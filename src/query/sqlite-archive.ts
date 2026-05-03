import type { Db } from '../db/index.js';
import type { Coding, Medication, Observation, ParsedDocument, Problem } from '../records/index.js';
import { kindRegistry } from '../records/index.js';
import type { BlobStore } from '../storage/index.js';
import { getInflated } from '../storage/index.js';
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

export type PeriodDurationResult = { total_minutes: number } | { per_bucket: DailyBucketRow[] };

type CcdSnapshotMeta =
  | { source_document_key: string; source_document_date: string }
  | { source_document_key: null; source_document_date: null; note: string };

export type CurrentProblemsResult = CcdSnapshotMeta & { problems: Problem[] };
export type CurrentMedicationsResult = CcdSnapshotMeta & { medications: Medication[] };

export class SqliteArchive {
  constructor(
    private readonly db: Db,
    private readonly store: BlobStore,
  ) {}

  listDocuments(): DocumentSummary[] {
    return queryDocumentRows(this.db).map(rowToDocumentSummary);
  }

  listMetrics(): MetricCatalogEntry[] {
    return queryMetricRows(this.db).map(rowToMetric);
  }

  getObservationHistory(query: ObservationHistoryQuery): Observation[] {
    if (query.codings.length === 0) return [];
    return queryObservationRows(this.db, query).map(rowToObservation);
  }

  getPeriodDurationInValueRange(query: PeriodDurationQuery): PeriodDurationResult {
    if (query.bucket === 'none') {
      return { total_minutes: queryTotalPeriodMinutes(this.db, query) };
    }
    return { per_bucket: queryDailyPeriodMinutes(this.db, query) };
  }

  async getCurrentProblems(): Promise<CurrentProblemsResult> {
    const ccd = await this.loadMostRecentCcd();
    if (ccd === null) {
      return {
        source_document_key: null,
        source_document_date: null,
        problems: [],
        note: 'no CCD-shaped document in archive',
      };
    }
    return {
      source_document_key: ccd.key,
      source_document_date: ccd.parsed.document_date,
      problems: ccd.parsed.problems,
    };
  }

  async getCurrentMedications(): Promise<CurrentMedicationsResult> {
    const ccd = await this.loadMostRecentCcd();
    if (ccd === null) {
      return {
        source_document_key: null,
        source_document_date: null,
        medications: [],
        note: 'no CCD-shaped document in archive',
      };
    }
    return {
      source_document_key: ccd.key,
      source_document_date: ccd.parsed.document_date,
      medications: ccd.parsed.medications,
    };
  }

  private async loadMostRecentCcd(): Promise<{ key: string; parsed: ParsedDocument } | null> {
    const key = findMostRecentCcdKey(this.db);
    if (key === null) return null;
    const bytes = await getInflated(this.store, key);
    const parsed = kindRegistry.ccda.parseDocument(bytes);
    return { key, parsed };
  }
}
