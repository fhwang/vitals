import type { Coding, Medication, Observation, ParsedDocument, Problem } from '../records/index.js';
import { kindRegistry, type Kind } from '../records/index.js';
import type { BlobStore, Provenance } from '../storage/index.js';
import { provenanceKey, readProvenance } from '../storage/index.js';

const PROVENANCE_SUFFIX = provenanceKey('');

export type DocumentContributor = 'observations' | 'problems' | 'medications';

export interface DocumentSummary {
  key: string;
  kind: Kind;
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

interface CcdSnapshotMeta {
  source_document_key: string | null;
  source_document_date: string | null;
  note?: string;
}

export type CurrentProblemsResult = CcdSnapshotMeta & { problems: Problem[] };
export type CurrentMedicationsResult = CcdSnapshotMeta & { medications: Medication[] };

export class ArchiveCache {
  private readonly cache = new Map<string, ParsedDocument>();

  constructor(private readonly store: BlobStore) {}

  async listDocuments(): Promise<DocumentSummary[]> {
    const summaries: DocumentSummary[] = [];
    for await (const key of this.iterateBlobKeys()) {
      const parsed = await this.getParsed(key);
      const provenance = await this.requireProvenance(key);
      summaries.push(buildSummary(key, parsed, provenance));
    }
    return summaries;
  }

  async listMetrics(): Promise<MetricCatalogEntry[]> {
    const byCoding = new Map<string, MetricCatalogEntry>();
    for await (const key of this.iterateBlobKeys()) {
      const parsed = await this.getParsed(key);
      for (const obs of parsed.observations) {
        mergeMetric(byCoding, obs);
      }
    }
    return [...byCoding.values()];
  }

  async getObservationHistory(query: ObservationHistoryQuery): Promise<Observation[]> {
    const wantedIds = new Set(query.codings.map(codingId));
    const out: Observation[] = [];
    for await (const key of this.iterateBlobKeys()) {
      const parsed = await this.getParsed(key);
      for (const obs of parsed.observations) {
        if (!matchesHistoryQuery(obs, wantedIds, query)) continue;
        out.push({ ...obs, source_document_key: key });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  async getCurrentProblems(): Promise<CurrentProblemsResult> {
    const ccd = await this.findMostRecentCcd();
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
    const ccd = await this.findMostRecentCcd();
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

  private async findMostRecentCcd(): Promise<{ key: string; parsed: ParsedDocument } | null> {
    let best: { key: string; parsed: ParsedDocument } | null = null;
    for await (const key of this.iterateBlobKeys()) {
      const parsed = await this.getParsed(key);
      if (parsed.document_type !== 'ccd') continue;
      if (best === null || parsed.document_date > best.parsed.document_date) {
        best = { key, parsed };
      }
    }
    return best;
  }

  private async *iterateBlobKeys(): AsyncIterable<string> {
    for (const kind of Object.keys(kindRegistry) as Kind[]) {
      for await (const entry of this.store.list(`${kind}/`)) {
        if (entry.key.endsWith(PROVENANCE_SUFFIX)) continue;
        yield entry.key;
      }
    }
  }

  private async getParsed(key: string): Promise<ParsedDocument> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const bytes = await this.store.get(key);
    const kind = inferKindFromKey(key);
    const parsed = kindRegistry[kind].parseDocument(bytes);
    this.cache.set(key, parsed);
    return parsed;
  }

  private async requireProvenance(key: string): Promise<Provenance> {
    const provenance = await readProvenance(this.store, key);
    if (provenance === null) {
      throw new Error(`missing provenance sidecar for ${key}`);
    }
    return provenance;
  }
}

function inferKindFromKey(key: string): Kind {
  const prefix = key.split('/')[0];
  if (prefix === undefined || prefix === '' || !(prefix in kindRegistry)) {
    throw new Error(`unknown kind for key: ${key}`);
  }
  return prefix as Kind;
}

function collectContributors(parsed: ParsedDocument): DocumentContributor[] {
  const contributors: DocumentContributor[] = [];
  if (parsed.observations.length > 0) contributors.push('observations');
  if (parsed.problems.length > 0) contributors.push('problems');
  if (parsed.medications.length > 0) contributors.push('medications');
  return contributors;
}

function codingId(coding: Coding): string {
  return `${coding.system}|${coding.code}`;
}

function matchesHistoryQuery(
  obs: Observation,
  wantedIds: Set<string>,
  query: ObservationHistoryQuery,
): boolean {
  if (!wantedIds.has(codingId(obs.coding))) return false;
  if (query.since !== undefined && obs.date < query.since) return false;
  if (query.until !== undefined && obs.date > query.until) return false;
  return true;
}

function mergeMetric(byCoding: Map<string, MetricCatalogEntry>, obs: Observation): void {
  const id = codingId(obs.coding);
  const existing = byCoding.get(id);
  if (existing) {
    existing.observation_count += 1;
    if (obs.date < existing.first_observed) existing.first_observed = obs.date;
    if (obs.date > existing.last_observed) existing.last_observed = obs.date;
    if (existing.unit !== obs.unit) existing.unit = null;
    return;
  }
  byCoding.set(id, {
    coding: { ...obs.coding },
    observation_count: 1,
    first_observed: obs.date,
    last_observed: obs.date,
    unit: obs.unit,
  });
}

function buildSummary(
  key: string,
  parsed: ParsedDocument,
  provenance: Provenance,
): DocumentSummary {
  return {
    key,
    kind: inferKindFromKey(key),
    ingested_at: provenance.ingested_at,
    source: provenance.source,
    original_filename: provenance.original_filename,
    document_type: parsed.document_type,
    document_date: parsed.document_date,
    document_date_range: parsed.document_date_range,
    observation_count: parsed.observations.length,
    contributors_to: collectContributors(parsed),
  };
}
