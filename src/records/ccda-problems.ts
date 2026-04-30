import { z } from 'zod';

import { asArray, formatDate, parseCoding } from './ccda-helpers.js';
import type { Problem } from './types.js';

// Problems section: act > entryRelationship > observation. The condition
// itself sits on the inner <value xsi:type="CD"> using FHIR-Coding-equivalent
// attributes. The outer observation.code identifies the problem-list slot
// (e.g. SNOMED 64572001 "Condition") and is not the diagnosis itself.
const ProblemValueNodeSchema = z.object({
  '@_code': z.string(),
  '@_codeSystem': z.string(),
  '@_displayName': z.string().optional(),
});

const ProblemEffectiveTimeSchema = z.object({
  low: z.object({ '@_value': z.string() }).optional(),
});

const ProblemObservationSchema = z.object({
  statusCode: z.object({ '@_code': z.string() }),
  effectiveTime: ProblemEffectiveTimeSchema.optional(),
  value: ProblemValueNodeSchema,
});

const ProblemEntryRelationshipSchema = z.object({
  observation: ProblemObservationSchema,
});

const ProblemActSchema = z.object({
  entryRelationship: z.union([
    ProblemEntryRelationshipSchema,
    z.array(ProblemEntryRelationshipSchema),
  ]),
});

const ProblemEntrySchema = z.object({
  act: ProblemActSchema,
});

const ProblemsSectionSchema = z.object({
  entry: z.union([ProblemEntrySchema, z.array(ProblemEntrySchema)]).optional(),
});

function parseProblem(node: z.infer<typeof ProblemObservationSchema>): Problem {
  const onsetRaw = node.effectiveTime?.low?.['@_value'];
  return {
    name: node.value['@_displayName'] ?? '',
    coding: parseCoding(node.value),
    status: node.statusCode['@_code'],
    onset_date: onsetRaw === undefined ? null : formatDate(onsetRaw.slice(0, 8)),
  };
}

export function extractProblemsFromSection(section: unknown): Problem[] {
  const result = ProblemsSectionSchema.safeParse(section);
  if (!result.success) return [];
  const problems: Problem[] = [];
  for (const entry of asArray(result.data.entry)) {
    for (const rel of asArray(entry.act.entryRelationship)) {
      problems.push(parseProblem(rel.observation));
    }
  }
  return problems;
}
