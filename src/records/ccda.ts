import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';

import {
  asArray,
  CodeNodeSchema,
  formatDate,
  parseCoding,
  parseValue,
  ValueNodeSchema,
} from './ccda-helpers.js';
import { extractMedicationsFromSection } from './ccda-medications.js';
import { extractProblemsFromSection } from './ccda-problems.js';
import {
  buildNarrativeMap,
  isWhitelistedMismatch,
  lookupNarrativeText,
  throwNarrativeMismatch,
} from './ccda-self-check.js';
import { RecordParseError } from './errors.js';
import type { KindHandler } from './kind-registry.js';
import type { DocumentType, Medication, Observation, ParsedDocument, Problem } from './types.js';

const CCDA_NAMESPACE = 'urn:hl7-org:v3';
const CCD_TEMPLATE_IDS = new Set(['2.16.840.1.113883.10.20.22.1.2']);
const ENCOUNTER_TEMPLATE_IDS = new Set([
  '2.16.840.1.113883.10.20.22.1.8', // Discharge Summary
  '2.16.840.1.113883.10.20.22.1.9', // Progress Note
  '2.16.840.1.113883.10.20.22.1.13', // Operative Note
]);
const RESULTS_SECTION_CODE = '30954-2';
const VITAL_SIGNS_SECTION_CODE = '8716-3';
const PROBLEMS_SECTION_CODE = '11450-4';
const MEDICATIONS_SECTION_CODE = '10160-0';
const OBSERVATION_SECTION_CODES = new Set([RESULTS_SECTION_CODE, VITAL_SIGNS_SECTION_CODE]);

const ClinicalDocumentSchema = z.object({
  ClinicalDocument: z.object({
    '@_xmlns': z.string(),
  }),
});

const TemplateIdSchema = z.object({ '@_root': z.string() });

const HeaderSchema = z.object({
  ClinicalDocument: z.object({
    templateId: z.union([TemplateIdSchema, z.array(TemplateIdSchema)]).optional(),
    effectiveTime: z.object({ '@_value': z.string() }),
  }),
});

const InterpretationCodeSchema = z.object({ '@_code': z.string().optional() });

const ReferenceRangeSchema = z.object({
  observationRange: z
    .object({
      text: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
});

const ObservationNodeSchema = z.object({
  code: CodeNodeSchema,
  effectiveTime: z.object({ '@_value': z.string() }),
  value: ValueNodeSchema.optional(),
  interpretationCode: InterpretationCodeSchema.optional(),
  referenceRange: ReferenceRangeSchema.optional(),
});

// Walk-only schemas: just enough structure to descend section → entry →
// organizer → component → observation. Per-observation validation happens at
// the leaf via ObservationNodeSchema.safeParse, so a single unmappable
// observation (nullFlavor code, missing code, etc.) doesn't poison its
// siblings — which used to drop entire Results sections silently.
const LooseComponentSchema = z.object({
  observation: z.unknown(),
});

const LooseOrganizerSchema = z.object({
  component: z.union([LooseComponentSchema, z.array(LooseComponentSchema)]).optional(),
});

const LooseEntrySchema = z.object({
  organizer: LooseOrganizerSchema.optional(),
});

const SectionCodeSchema = z.object({ '@_code': z.string() });

// Sections are loosely typed at the structural level; per-section schemas
// (Results, Problems, Medications) narrow the entries when extracted.
const SectionSchema = z.object({
  code: SectionCodeSchema,
});

const SectionComponentSchema = z.object({
  section: SectionSchema.passthrough(),
});

const StructuredBodySchema = z.object({
  ClinicalDocument: z.object({
    component: z
      .object({
        structuredBody: z.object({
          component: z.union([SectionComponentSchema, z.array(SectionComponentSchema)]),
        }),
      })
      .optional(),
  }),
});

// Both Results (BATTERY) and Vital Signs (CLUSTER) sections use the same
// organizer/component/observation structure, so a single schema covers them.
const ObservationSectionSchema = z.object({
  entry: z.union([LooseEntrySchema, z.array(LooseEntrySchema)]).optional(),
});

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

function parseXml(bytes: Uint8Array): unknown {
  const xml = new TextDecoder().decode(bytes);
  try {
    return parser.parse(xml);
  } catch (err) {
    throw new RecordParseError('ccda', 'malformed XML', { cause: err });
  }
}

function extractDocumentType(
  templateId: z.infer<typeof TemplateIdSchema> | z.infer<typeof TemplateIdSchema>[] | undefined,
): DocumentType {
  if (templateId === undefined) return 'unknown';
  const templateIds = Array.isArray(templateId) ? templateId : [templateId];
  const roots = templateIds.map((tid) => tid['@_root']);
  if (roots.some((root) => CCD_TEMPLATE_IDS.has(root))) return 'ccd';
  if (roots.some((root) => ENCOUNTER_TEMPLATE_IDS.has(root))) return 'encounter';
  return 'unknown';
}

function extractDocumentDate(effectiveTimeValue: string): string {
  return formatDate(effectiveTimeValue.slice(0, 8));
}

function parseObservation(node: z.infer<typeof ObservationNodeSchema>): Observation {
  const { value, unit } = parseValue(node.value);
  const refRangeText = node.referenceRange?.observationRange?.text;
  const refRange = refRangeText === undefined ? null : String(refRangeText);
  const interpretation = node.interpretationCode?.['@_code'] ?? null;
  return {
    coding: parseCoding(node.code),
    date: formatDate(node.effectiveTime['@_value'].slice(0, 8)),
    value,
    unit,
    ref_range: refRange,
    interpretation,
    source_document_key: '',
  };
}

function parseAndCheckObservation(
  node: z.infer<typeof ObservationNodeSchema>,
  rawNode: unknown,
  narrativeMap: Map<string, string>,
): Observation {
  const observation = parseObservation(node);
  const displayName = node.code['@_displayName'];
  const narrativeText = lookupNarrativeText(rawNode, narrativeMap);
  if (isWhitelistedMismatch(displayName, observation.value, narrativeText)) {
    throwNarrativeMismatch(String(narrativeText), `${String(displayName)} on ${observation.date}`);
  }
  return observation;
}

function extractObservationsFromOrganizer(
  organizer: z.infer<typeof LooseOrganizerSchema>,
  narrativeMap: Map<string, string>,
): Observation[] {
  const observations: Observation[] = [];
  for (const component of asArray(organizer.component)) {
    const obsResult = ObservationNodeSchema.safeParse(component.observation);
    if (!obsResult.success) continue;
    observations.push(
      parseAndCheckObservation(obsResult.data, component.observation, narrativeMap),
    );
  }
  return observations;
}

function extractObservationsFromSection(section: unknown): Observation[] {
  const sectionResult = ObservationSectionSchema.safeParse(section);
  if (!sectionResult.success) return [];
  const narrativeMap = buildNarrativeMap(section);
  const observations: Observation[] = [];
  for (const entry of asArray(sectionResult.data.entry)) {
    if (entry.organizer === undefined) continue;
    observations.push(...extractObservationsFromOrganizer(entry.organizer, narrativeMap));
  }
  return observations;
}

function getSections(parsed: unknown): z.infer<typeof SectionSchema>[] {
  const result = StructuredBodySchema.safeParse(parsed);
  if (!result.success) return [];
  const structuredBody = result.data.ClinicalDocument.component?.structuredBody;
  if (structuredBody === undefined) return [];
  return asArray(structuredBody.component).map((c) => c.section);
}

function extractObservations(parsed: unknown): Observation[] {
  const observations: Observation[] = [];
  for (const section of getSections(parsed)) {
    if (OBSERVATION_SECTION_CODES.has(section.code['@_code'])) {
      observations.push(...extractObservationsFromSection(section));
    }
  }
  return observations;
}

function extractProblems(parsed: unknown): Problem[] {
  const problems: Problem[] = [];
  for (const section of getSections(parsed)) {
    if (section.code['@_code'] === PROBLEMS_SECTION_CODE) {
      problems.push(...extractProblemsFromSection(section));
    }
  }
  return problems;
}

function extractMedications(parsed: unknown): Medication[] {
  const medications: Medication[] = [];
  for (const section of getSections(parsed)) {
    if (section.code['@_code'] === MEDICATIONS_SECTION_CODE) {
      medications.push(...extractMedicationsFromSection(section));
    }
  }
  return medications;
}

function computeDateRange(observations: Observation[]): { from: string; to: string } | null {
  const [first, ...rest] = observations;
  if (first === undefined) return null;
  let from = first.date;
  let to = first.date;
  for (const obs of rest) {
    if (obs.date < from) from = obs.date;
    if (obs.date > to) to = obs.date;
  }
  return { from, to };
}

export const ccdaKind: KindHandler = {
  kind: 'ccda',
  extension: 'xml',
  contentType: 'application/xml',
  validateBytes(bytes: Uint8Array): void {
    const parsed = parseXml(bytes);
    const result = ClinicalDocumentSchema.safeParse(parsed);
    if (!result.success) {
      throw new RecordParseError('ccda', 'root element is not ClinicalDocument');
    }
    if (result.data.ClinicalDocument['@_xmlns'] !== CCDA_NAMESPACE) {
      throw new RecordParseError(
        'ccda',
        `expected xmlns="${CCDA_NAMESPACE}", got "${result.data.ClinicalDocument['@_xmlns']}"`,
      );
    }
  },
  parseDocument(bytes: Uint8Array): ParsedDocument {
    const parsed = parseXml(bytes);
    const result = HeaderSchema.safeParse(parsed);
    if (!result.success) {
      throw new RecordParseError('ccda', 'missing required header fields');
    }
    const { templateId, effectiveTime } = result.data.ClinicalDocument;
    const observations = extractObservations(parsed);
    return {
      document_type: extractDocumentType(templateId),
      document_date: extractDocumentDate(effectiveTime['@_value']),
      document_date_range: computeDateRange(observations),
      observations,
      problems: extractProblems(parsed),
      medications: extractMedications(parsed),
    };
  },
};
