import { z } from 'zod';

import { asArray, formatDate, parseCoding } from './ccda-helpers.js';
import type { Medication } from './types.js';

// Medications section: <substanceAdministration> per entry. The drug coding
// lives on consumable.manufacturedProduct.manufacturedMaterial.code (RxNorm).
// Two effectiveTime children appear: an IVL_TS for start/end and a PIVL_TS
// for the recurring dosing frequency. fast-xml-parser returns them as an
// array; we disambiguate by xsi:type.
const IvlEffectiveTimeSchema = z.object({
  '@_xsi:type': z.literal('IVL_TS'),
  low: z.object({ '@_value': z.string() }).optional(),
  high: z.object({ '@_value': z.string() }).optional(),
});

const PivlEffectiveTimeSchema = z.object({
  '@_xsi:type': z.literal('PIVL_TS'),
  period: z
    .object({
      '@_value': z.union([z.string(), z.number()]),
      '@_unit': z.string(),
    })
    .optional(),
});

const EffectiveTimeSchema = z.union([IvlEffectiveTimeSchema, PivlEffectiveTimeSchema]);

const DoseQuantitySchema = z.object({
  '@_value': z.union([z.string(), z.number()]),
  '@_unit': z.string(),
});

const RouteCodeSchema = z.object({
  '@_displayName': z.string().optional(),
});

const ManufacturedMaterialCodeSchema = z.object({
  '@_code': z.string(),
  '@_codeSystem': z.string(),
  '@_displayName': z.string().optional(),
});

const ConsumableSchema = z.object({
  manufacturedProduct: z.object({
    manufacturedMaterial: z.object({
      code: ManufacturedMaterialCodeSchema,
    }),
  }),
});

const SubstanceAdministrationSchema = z.object({
  statusCode: z.object({ '@_code': z.string() }),
  effectiveTime: z.union([EffectiveTimeSchema, z.array(EffectiveTimeSchema)]),
  routeCode: RouteCodeSchema.optional(),
  doseQuantity: DoseQuantitySchema.optional(),
  consumable: ConsumableSchema,
});

const MedicationEntrySchema = z.object({
  substanceAdministration: SubstanceAdministrationSchema,
});

const MedicationsSectionSchema = z.object({
  entry: z.union([MedicationEntrySchema, z.array(MedicationEntrySchema)]).optional(),
});

type EffectiveTime = z.infer<typeof EffectiveTimeSchema>;
type IvlEffectiveTime = z.infer<typeof IvlEffectiveTimeSchema>;
type PivlEffectiveTime = z.infer<typeof PivlEffectiveTimeSchema>;
type SubstanceAdministration = z.infer<typeof SubstanceAdministrationSchema>;

function findIvl(times: EffectiveTime[]): IvlEffectiveTime | undefined {
  return times.find((t): t is IvlEffectiveTime => t['@_xsi:type'] === 'IVL_TS');
}

function findPivl(times: EffectiveTime[]): PivlEffectiveTime | undefined {
  return times.find((t): t is PivlEffectiveTime => t['@_xsi:type'] === 'PIVL_TS');
}

function formatFrequency(pivl: PivlEffectiveTime | undefined): string {
  const period = pivl?.period;
  if (period === undefined) return '';
  return `every ${String(period['@_value'])}${period['@_unit']}`;
}

function formatDose(dose: SubstanceAdministration['doseQuantity']): string {
  if (dose === undefined) return '';
  return `${String(dose['@_value'])} ${dose['@_unit']}`;
}

function parseMedication(node: SubstanceAdministration): Medication {
  const times = asArray(node.effectiveTime);
  const ivl = findIvl(times);
  const pivl = findPivl(times);
  const startRaw = ivl?.low?.['@_value'];
  const endRaw = ivl?.high?.['@_value'];
  const code = node.consumable.manufacturedProduct.manufacturedMaterial.code;
  return {
    name: code['@_displayName'] ?? '',
    coding: parseCoding(code),
    dose: formatDose(node.doseQuantity),
    route: node.routeCode?.['@_displayName'] ?? '',
    frequency: formatFrequency(pivl),
    status: node.statusCode['@_code'],
    start_date: startRaw === undefined ? null : formatDate(startRaw.slice(0, 8)),
    end_date: endRaw === undefined ? null : formatDate(endRaw.slice(0, 8)),
  };
}

export function extractMedicationsFromSection(section: unknown): Medication[] {
  const result = MedicationsSectionSchema.safeParse(section);
  if (!result.success) {
    return [];
  }
  const medications: Medication[] = [];
  for (const entry of asArray(result.data.entry)) {
    medications.push(parseMedication(entry.substanceAdministration));
  }
  return medications;
}
