import { z } from 'zod';

import { OID_TO_FHIR_SYSTEM } from './coding.js';
import type { Coding } from './types.js';

export const CodeNodeSchema = z.object({
  '@_code': z.string(),
  '@_codeSystem': z.string(),
  '@_displayName': z.string().optional(),
});
export type CodeNode = z.infer<typeof CodeNodeSchema>;

const TranslationNodeSchema = z.object({
  '@_value': z.union([z.string(), z.number()]).optional(),
  originalText: z.union([z.string(), z.number()]).optional(),
});

// Quest and similar labs report calculated metrics with nullFlavor="OTH" on
// the outer <value> and the actual number on a nested <translation>; the
// originalText inside the translation carries the unit.
export const ValueNodeSchema = z.object({
  '@_value': z.union([z.string(), z.number()]).optional(),
  '@_unit': z.string().optional(),
  translation: TranslationNodeSchema.optional(),
});
export type ValueNode = z.infer<typeof ValueNodeSchema>;

export function formatDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// CCDA <effectiveTime value="..."> uses HL7 v3 timestamp format:
//   YYYYMMDD                   (date only)
//   YYYYMMDDHHMM[SS][±HHMM]    (with time, optional seconds, optional offset)
// We treat the clock portion as naive-local (matching how CCDA-as-instant
// observations have always been stored) and ignore the offset. The Z suffix
// on effective_start is aspirational, not literal — it just keeps the format
// uniform with Fitbit period observations and other naive-local-as-UTC
// timestamps in this codebase.
export function parseEffectiveTime(raw: string): {
  date: string;
  effective_start: string;
} {
  const date = formatDate(raw.slice(0, 8));
  const timeMatch = /^(\d{2})(\d{2})(\d{2})?/.exec(raw.slice(8));
  if (timeMatch === null) {
    return { date, effective_start: `${date}T00:00:00Z` };
  }
  const hh = timeMatch[1];
  const mn = timeMatch[2];
  const ss = timeMatch[3] ?? '00';
  return { date, effective_start: `${date}T${hh}:${mn}:${ss}Z` };
}

export function asArray<T>(x: T | T[] | undefined): T[] {
  if (x === undefined) return [];
  return Array.isArray(x) ? x : [x];
}

export function parseCoding(codeNode: CodeNode): Coding {
  const system = OID_TO_FHIR_SYSTEM[codeNode['@_codeSystem']] ?? codeNode['@_codeSystem'];
  const coding: Coding = {
    system,
    code: codeNode['@_code'],
  };
  if (codeNode['@_displayName'] !== undefined) {
    coding.display = codeNode['@_displayName'];
  }
  return coding;
}

function coerceValue(raw: string | number): number | string {
  if (typeof raw === 'number') return raw;
  const num = Number(raw);
  return Number.isNaN(num) ? raw : num;
}

export function parseValue(valueNode: ValueNode | undefined): {
  value: number | string;
  unit: string | null;
} {
  const outerRaw = valueNode?.['@_value'];
  const outerUnit = valueNode?.['@_unit'] ?? null;
  if (outerRaw !== undefined && outerRaw !== '') {
    return { value: coerceValue(outerRaw), unit: outerUnit };
  }
  const translation = valueNode?.translation;
  const innerRaw = translation?.['@_value'];
  if (innerRaw !== undefined && innerRaw !== '') {
    const innerUnit =
      translation?.originalText !== undefined ? String(translation.originalText) : outerUnit;
    return { value: coerceValue(innerRaw), unit: innerUnit };
  }
  return { value: '', unit: outerUnit };
}
