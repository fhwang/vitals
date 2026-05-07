export interface Coding {
  system: string;
  code: string;
  display?: string;
}

export interface Observation {
  coding: Coding;
  date: string; // YYYY-MM-DD — kept for compatibility; deprecated, prefer effective_start
  effective_start: string; // ISO-8601 UTC; date-only sources get T00:00:00Z
  effective_end: string | null; // null = instant; non-null = period [start, end)
  value: number | string; // string for non-numeric ('NEGATIVE')
  unit: string | null;
  ref_range: string | null;
  interpretation: string | null; // 'H', 'L', etc.
  source_document_key: string;
}

export interface Problem {
  name: string;
  coding: Coding; // ICD-10 or SNOMED
  status: string;
  onset_date: string | null; // YYYY-MM-DD
}

export interface Medication {
  name: string;
  coding: Coding; // RxNorm
  dose: string;
  route: string;
  frequency: string;
  status: string;
  start_date: string | null; // YYYY-MM-DD
  end_date: string | null; // YYYY-MM-DD
}

export type DocumentType = 'ccd' | 'encounter' | 'unknown';

export interface ParsedDocument {
  document_type: DocumentType;
  document_date: string; // YYYY-MM-DD
  document_date_range: { from: string; to: string } | null;
  observations: Observation[];
  problems: Problem[];
  medications: Medication[];
}
