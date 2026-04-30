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
