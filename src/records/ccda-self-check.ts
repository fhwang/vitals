import { z } from 'zod';

import { asArray } from './ccda-helpers.js';
import { RecordParseError } from './errors.js';

// Mirrors SELF_CHECK_METRICS in scripts/extract_ccda.py. A silent XML-parse
// miss has burned this routine before; for these whitelisted metrics, if the
// narrative table shows a number but the structured value parses to empty, we
// refuse to emit. Case-sensitive match against observation.code.@_displayName.
const SELF_CHECK_DISPLAY_NAMES = new Set([
  'LDL-CHOLESTEROL',
  'TSH',
  'HEMOGLOBIN A1c',
  'TRIGLYCERIDES',
  'GLUCOSE',
]);

const TdNodeSchema = z
  .object({
    '@_ID': z.string().optional(),
  })
  .catchall(z.unknown());

const TdCellSchema = z.union([z.string(), z.number(), TdNodeSchema]);

const TrNodeSchema = z.object({
  td: z.union([TdCellSchema, z.array(TdCellSchema)]),
});

const NarrativeTableSchema = z.object({
  text: z
    .object({
      table: z
        .object({
          tbody: z
            .object({
              tr: z.union([TrNodeSchema, z.array(TrNodeSchema)]).optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

const ReferenceSchema = z.object({
  text: z
    .object({
      reference: z.object({ '@_value': z.string() }).optional(),
    })
    .optional(),
});

type TdCell = z.infer<typeof TdCellSchema>;

function tdTextFromObject(node: object): string {
  let acc = '';
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_')) continue;
    acc += tdText(value);
  }
  return acc;
}

// Recursively concatenate text from all descendants of a parser-output node.
// fast-xml-parser emits text under '#text' and nested elements as object/array
// values under their tag names; attribute keys start with '@_' and aren't
// content. Real-world CCDAs wrap narrative values in <br/>, <span>, <content>,
// etc., so a non-recursive walk would silently parse them to ''.
function tdText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(tdText).join('');
  if (typeof node === 'object' && node !== null) return tdTextFromObject(node);
  return '';
}

function tdId(cell: TdCell): string | undefined {
  if (typeof cell === 'string' || typeof cell === 'number') return undefined;
  return cell['@_ID'];
}

function addRowToMap(row: z.infer<typeof TrNodeSchema>, map: Map<string, string>): void {
  const cells = Array.isArray(row.td) ? row.td : [row.td];
  for (let i = 0; i < cells.length - 1; i++) {
    const cell = cells[i];
    const next = cells[i + 1];
    if (cell === undefined || next === undefined) continue;
    const id = tdId(cell);
    if (id === undefined) continue;
    map.set(id, tdText(next).trim());
  }
}

// Walk every row's <td> cells. For any cell with an @_ID, the narrative value
// is the text of the next sibling cell. Mirrors `<td ID="...">label</td><td>value</td>`.
export function buildNarrativeMap(section: unknown): Map<string, string> {
  const map = new Map<string, string>();
  const result = NarrativeTableSchema.safeParse(section);
  if (!result.success) return map;
  const rows = result.data.text?.table?.tbody?.tr;
  for (const row of asArray(rows)) {
    addRowToMap(row, map);
  }
  return map;
}

// Looks up the narrative-table text for the structured observation by
// dereferencing observation.text.reference.@_value (e.g. "#ldl-2024-06") into
// the section's narrative map. Returns undefined if no reference or no entry.
export function lookupNarrativeText(
  observationNode: unknown,
  narrativeMap: Map<string, string>,
): string | undefined {
  const result = ReferenceSchema.safeParse(observationNode);
  if (!result.success) return undefined;
  const raw = result.data.text?.reference?.['@_value'];
  if (raw === undefined) return undefined;
  const refId = raw.startsWith('#') ? raw.slice(1) : raw;
  return narrativeMap.get(refId);
}

// Returns true when the structured side is empty but the narrative shows a
// finite number for a whitelisted metric — exactly the silent-parse-miss the
// self-check exists to catch.
export function isWhitelistedMismatch(
  displayName: string | undefined,
  structuredValue: number | string,
  narrativeText: string | undefined,
): boolean {
  if (displayName === undefined || !SELF_CHECK_DISPLAY_NAMES.has(displayName)) return false;
  if (structuredValue !== '') return false;
  if (narrativeText === undefined || narrativeText === '') return false;
  return Number.isFinite(Number(narrativeText));
}

// Throws RecordParseError flagging a narrative-vs-structured mismatch. Caller
// formats `context` (e.g. "LDL-CHOLESTEROL on 2024-03-01") so this function
// stays at three parameters.
export function throwNarrativeMismatch(narrativeText: string, context: string): never {
  throw new RecordParseError(
    'ccda',
    `narrative says ${narrativeText}, structured parse empty for ${context}`,
  );
}
