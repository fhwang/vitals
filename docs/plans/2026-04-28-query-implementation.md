# Query Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use superpowers:test-driven-development for any task that has tests.

**Goal:** Build the patient-state query layer specified in `docs/plans/2026-04-28-query-design.md`. Five new MCP tools (`list_documents`, `list_metrics`, `get_observation_history`, `get_current_problems`, `get_current_medications`) backed by a per-session in-memory cache that lazily parses CCDAs into a normalized FHIR-Coding-keyed shape.

**Architecture:**

- `src/records/` grows: a small types module, a FHIR-system constants module, and a `parseDocument` method on `KindHandler`. The CCDA implementation does the full extraction (observations from Results + Vital Signs, structured Problems, structured Medications, header metadata, narrative-vs-structured self-check).
- `src/records/ingest.ts` strict-fails ingest when `parseDocument` throws.
- `src/query/` is new: an `ArchiveCache` aggregates parsed documents and answers the five queries, lifetime equals one MCP session.
- `src/mcp/server.ts` registers five new tools and wires the `ArchiveCache` in at boot.
- `src/storage/` is unchanged.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import suffix), Vitest, Zod, `fast-xml-parser`, `@modelcontextprotocol/sdk`.

**Working directory:** This plan executes inside the worktree at `.claude/worktrees/feat-query/` on branch `worktree-feat-query`. All paths below are relative to the worktree root.

**Verification:** After each task, run `pnpm check` (format + lint + typecheck + forbid-junk-object-types + test). Don't commit until it's green. If a rule fires, fix the underlying problem — never use `// eslint-disable`, never widen a type to `Record<string, unknown>` to dodge `forbid-junk-object-types` (see CLAUDE.md "Lint policy"). Narrow types with Zod schemas or named interfaces; split functions if `max-lines-per-function` fires.

**Commit style:** Match recent history (`Add ...`, `Tighten ...`, short imperative line, no scope prefix). One commit per task. Co-author trailer per project default.

**TDD pattern (use for every task that has tests):**

1. Write the failing test.
2. `pnpm test <path-to-test>` — confirm it fails for the right reason.
3. Write minimal implementation.
4. `pnpm test <path-to-test>` — confirm pass.
5. `pnpm check` — full gate.
6. Commit.

**Fixture inventory (created across tasks as first needed):**

- `src/records/__fixtures__/ccda-valid.xml` — already exists (header-only, validateBytes happy path).
- `src/records/__fixtures__/not-ccda.xml` — already exists.
- `src/records/__fixtures__/ccda-rich-ccd.xml` — full CCD-shaped doc (created in Task 4).
- `src/records/__fixtures__/ccda-encounter.xml` — encounter-shaped doc, partial sections (Task 13).
- `src/records/__fixtures__/ccda-quest-translation.xml` — Quest-style nullFlavor + translation pattern (Task 8).
- `src/records/__fixtures__/ccda-self-check-fail.xml` — narrative says a number, structured `<value>` is missing (Task 12).

---

## Task 1: Records types module

**Files:** Create `src/records/types.ts`. No tests (pure type definitions).

**Step 1: Write the file**

```ts
export interface Coding {
  system: string;
  code: string;
  display?: string;
}

export interface Observation {
  coding: Coding;
  date: string; // YYYY-MM-DD
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
```

**Step 2: Re-export from `src/records/index.ts`**

Add to the existing exports:

```ts
export type {
  Coding,
  DocumentType,
  Medication,
  Observation,
  ParsedDocument,
  Problem,
} from './types.js';
```

**Step 3: Run check**

```bash
pnpm check
```

Expected: green. (No tests yet; types are exercised by later tasks.)

**Step 4: Commit**

```bash
git add src/records/types.ts src/records/index.ts
git commit
```

Message: `Add records types module`

---

## Task 2: FHIR system URI constants

**Files:** Create `src/records/coding.ts`. No tests.

**Step 1: Write the file**

```ts
export const SYSTEM_LOINC = 'http://loinc.org';
export const SYSTEM_RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
export const SYSTEM_ICD10 = 'http://hl7.org/fhir/sid/icd-10-cm';
export const SYSTEM_SNOMED = 'http://snomed.info/sct';

// CCDA OIDs that map to FHIR system URIs. CCDAs identify code systems
// by OID; the records layer translates to FHIR canonical URIs at the
// boundary so everything above speaks one vocabulary.
export const OID_TO_FHIR_SYSTEM: Readonly<Record<string, string>> = {
  '2.16.840.1.113883.6.1': SYSTEM_LOINC,
  '2.16.840.1.113883.6.88': SYSTEM_RXNORM,
  '2.16.840.1.113883.6.90': SYSTEM_ICD10,
  '2.16.840.1.113883.6.96': SYSTEM_SNOMED,
};
```

**Step 2: Re-export from `src/records/index.ts`**

```ts
export {
  OID_TO_FHIR_SYSTEM,
  SYSTEM_ICD10,
  SYSTEM_LOINC,
  SYSTEM_RXNORM,
  SYSTEM_SNOMED,
} from './coding.js';
```

**Step 3: Check + commit**

```bash
pnpm check
git add src/records/coding.ts src/records/index.ts
git commit
```

Message: `Add FHIR system URI constants and CCDA OID translation table`

---

## Task 3: Extend `KindHandler` interface with `parseDocument`

**Files:** Modify `src/records/kind-registry.ts`. Modify `src/records/ccda.ts` to add a stub.

The interface change comes first so subsequent tasks can implement against the new shape. The CCDA implementation starts as a stub that throws "not implemented"; Tasks 4–12 fill it in.

**Step 1: Modify `KindHandler` interface**

In `src/records/kind-registry.ts`, change the interface to:

```ts
import type { ParsedDocument } from './types.js';

export interface KindHandler {
  readonly kind: string;
  readonly extension: string;
  readonly contentType: string;
  validateBytes(bytes: Uint8Array): void;
  parseDocument(bytes: Uint8Array): ParsedDocument;
}
```

**Step 2: Add stub `parseDocument` to `ccdaKind`**

In `src/records/ccda.ts`, add a `parseDocument` field to the exported `ccdaKind` constant that throws:

```ts
parseDocument(_bytes: Uint8Array): ParsedDocument {
  throw new Error('ccda parseDocument not yet implemented');
},
```

(The `_bytes` underscore-prefix avoids `noUnusedParameters`.)

Add `import type { ParsedDocument } from './types.js';` at the top.

**Step 3: Confirm compilation**

```bash
pnpm typecheck
```

Expected: green. Existing `ccda.test.ts` tests still pass (they only call `validateBytes`).

**Step 4: Run full check**

```bash
pnpm check
```

Expected: green.

**Step 5: Commit**

```bash
git add src/records/kind-registry.ts src/records/ccda.ts
git commit
```

Message: `Extend KindHandler with parseDocument stub`

---

## Task 4: Rich CCD fixture + `parseDocument` header extraction (CCD case)

**Files:** Create `src/records/__fixtures__/ccda-rich-ccd.xml`. Modify `src/records/ccda.ts`. Add tests in `src/records/ccda.test.ts`.

**Step 1: Create the rich CCD fixture**

Create `src/records/__fixtures__/ccda-rich-ccd.xml` with the structure below. This single fixture will grow into the source of truth for Tasks 4–11; subsequent tasks reference different sections of it.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <!-- CCD templateId — Continuity of Care Document -->
  <templateId root="2.16.840.1.113883.10.20.22.1.2"/>
  <code code="34133-9" codeSystem="2.16.840.1.113883.6.1" displayName="Summarization of Episode Note"/>
  <effectiveTime value="20240615143211-0500"/>
  <component>
    <structuredBody>
      <!-- Results section (labs) — added in Task 5 -->
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
          <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
          <title>Results</title>
          <text>
            <table>
              <thead><tr><th>Test</th><th>Value</th></tr></thead>
              <tbody>
                <tr><td ID="ldl-2024-06">LDL-C</td><td>118</td></tr>
                <tr><td ID="hba1c-2024-06">HbA1c</td><td>5.6</td></tr>
                <tr><td ID="trig-2024-06">Triglycerides</td><td>140</td></tr>
              </tbody>
            </table>
          </text>
          <entry>
            <organizer classCode="BATTERY" moodCode="EVN">
              <effectiveTime value="20240615"/>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <code code="13457-7" codeSystem="2.16.840.1.113883.6.1" displayName="LDL-CHOLESTEROL"/>
                  <text><reference value="#ldl-2024-06"/></text>
                  <effectiveTime value="20240615"/>
                  <value xsi:type="PQ" value="118" unit="mg/dL"/>
                  <interpretationCode code="N"/>
                  <referenceRange><observationRange><text>0-99 mg/dL</text></observationRange></referenceRange>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <code code="4548-4" codeSystem="2.16.840.1.113883.6.1" displayName="HEMOGLOBIN A1c"/>
                  <text><reference value="#hba1c-2024-06"/></text>
                  <effectiveTime value="20240615"/>
                  <value xsi:type="PQ" value="5.6" unit="%"/>
                  <interpretationCode code="N"/>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <code code="2571-8" codeSystem="2.16.840.1.113883.6.1" displayName="TRIGLYCERIDES"/>
                  <text><reference value="#trig-2024-06"/></text>
                  <effectiveTime value="20240615"/>
                  <value xsi:type="PQ" value="140" unit="mg/dL"/>
                </observation>
              </component>
            </organizer>
          </entry>
        </section>
      </component>
      <!-- Vital Signs section — added in Task 6 -->
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.4.1"/>
          <code code="8716-3" codeSystem="2.16.840.1.113883.6.1"/>
          <title>Vital Signs</title>
          <entry>
            <organizer classCode="CLUSTER" moodCode="EVN">
              <effectiveTime value="20240615"/>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <code code="8480-6" codeSystem="2.16.840.1.113883.6.1" displayName="Systolic BP"/>
                  <effectiveTime value="20240615"/>
                  <value xsi:type="PQ" value="118" unit="mm[Hg]"/>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <code code="8462-4" codeSystem="2.16.840.1.113883.6.1" displayName="Diastolic BP"/>
                  <effectiveTime value="20240615"/>
                  <value xsi:type="PQ" value="76" unit="mm[Hg]"/>
                </observation>
              </component>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <code code="29463-7" codeSystem="2.16.840.1.113883.6.1" displayName="Body weight"/>
                  <effectiveTime value="20240615"/>
                  <value xsi:type="PQ" value="178" unit="[lb_av]"/>
                </observation>
              </component>
            </organizer>
          </entry>
        </section>
      </component>
      <!-- Problems section — added in Task 9 -->
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
          <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/>
          <title>Problems</title>
          <entry>
            <act classCode="ACT" moodCode="EVN">
              <entryRelationship typeCode="SUBJ">
                <observation classCode="OBS" moodCode="EVN">
                  <code code="64572001" codeSystem="2.16.840.1.113883.6.96" displayName="Condition"/>
                  <statusCode code="completed"/>
                  <effectiveTime>
                    <low value="20180312"/>
                  </effectiveTime>
                  <value xsi:type="CD" code="E78.5" codeSystem="2.16.840.1.113883.6.90" displayName="Hyperlipidemia, unspecified"/>
                </observation>
              </entryRelationship>
            </act>
          </entry>
        </section>
      </component>
      <!-- Medications section — added in Task 10 -->
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.22.2.1.1"/>
          <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>
          <title>Medications</title>
          <entry>
            <substanceAdministration classCode="SBADM" moodCode="EVN">
              <statusCode code="active"/>
              <effectiveTime xsi:type="IVL_TS">
                <low value="20210601"/>
              </effectiveTime>
              <effectiveTime xsi:type="PIVL_TS" institutionSpecified="true">
                <period value="24" unit="h"/>
              </effectiveTime>
              <routeCode code="C38288" displayName="ORAL"/>
              <doseQuantity value="20" unit="mg"/>
              <consumable>
                <manufacturedProduct>
                  <manufacturedMaterial>
                    <code code="617314" codeSystem="2.16.840.1.113883.6.88" displayName="atorvastatin 20 MG Oral Tablet"/>
                  </manufacturedMaterial>
                </manufacturedProduct>
              </consumable>
            </substanceAdministration>
          </entry>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>
```

**Step 2: Write failing test**

Append to `src/records/ccda.test.ts`:

```ts
describe('ccdaKind.parseDocument', () => {
  it('extracts CCD document_type and document_date from header', async () => {
    const bytes = await loadFixture('ccda-rich-ccd.xml');
    const parsed = ccdaKind.parseDocument(bytes);
    expect(parsed.document_type).toBe('ccd');
    expect(parsed.document_date).toBe('2024-06-15');
  });
});
```

**Step 3: Run test, expect failure**

```bash
pnpm test src/records/ccda.test.ts
```

Expected: fails (`parseDocument not yet implemented`).

**Step 4: Implement header extraction**

In `src/records/ccda.ts`, replace the stub `parseDocument` with header-only logic:

- Parse XML once (the existing module-level `parser` is reusable).
- Read `ClinicalDocument.templateId.@_root`. If `'2.16.840.1.113883.10.20.22.1.2'` → `'ccd'`. (Encounter detection lands in Task 13.)
- Read `ClinicalDocument.effectiveTime.@_value`. Take the first 8 digits, format as `YYYY-MM-DD`.
- Return a `ParsedDocument` with empty arrays for now.

Helper to factor out the `YYYYMMDD → YYYY-MM-DD` conversion (used many places later):

```ts
function formatDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}
```

`templateId` may be a single object or an array (CCDAs often nest multiple). Handle both: normalize to `Array.isArray(templateId) ? templateId : [templateId]`.

**Step 5: Run test, expect pass**

```bash
pnpm test src/records/ccda.test.ts
```

**Step 6: Run full check + commit**

```bash
pnpm check
git add src/records/__fixtures__/ccda-rich-ccd.xml src/records/ccda.ts src/records/ccda.test.ts
git commit
```

Message: `Implement CCDA parseDocument header extraction`

---

## Task 5: Observations from Results section

**Files:** Modify `src/records/ccda.ts`. Add tests in `src/records/ccda.test.ts`.

**Step 1: Write failing test**

```ts
it('extracts LDL-C, HbA1c, triglycerides observations from Results section', async () => {
  const bytes = await loadFixture('ccda-rich-ccd.xml');
  const parsed = ccdaKind.parseDocument(bytes);
  const ldl = parsed.observations.find((o) => o.coding.code === '13457-7');
  expect(ldl).toBeDefined();
  expect(ldl?.coding.system).toBe(SYSTEM_LOINC);
  expect(ldl?.coding.display).toBe('LDL-CHOLESTEROL');
  expect(ldl?.date).toBe('2024-06-15');
  expect(ldl?.value).toBe(118);
  expect(ldl?.unit).toBe('mg/dL');
  expect(ldl?.interpretation).toBe('N');
  expect(ldl?.ref_range).toBe('0-99 mg/dL');
});
```

(Add `import { SYSTEM_LOINC } from './coding.js';` at the top of the test file.)

**Step 2: Run test, expect failure**

**Step 3: Implement observation extraction**

In `parseDocument`:

- Walk into `ClinicalDocument.component.structuredBody.component[]`. Each component has a `section`.
- For each section, check `section.code.@_code === '30954-2'` (Results LOINC).
- Within Results, walk `section.entry[]`. Each entry has an `organizer`. Each organizer has a `component[]` of which each has an `observation`.
- For each observation, build:
  - `coding`: `{ system: OID_TO_FHIR_SYSTEM[observation.code.@_codeSystem], code: observation.code.@_code, display: observation.code.@_displayName }`. If the OID isn't in the table, fall back to using the OID as the system (acceptable; we tag it explicitly).
  - `date`: from `observation.effectiveTime.@_value`, first 8 digits, formatted.
  - `value`: from `observation.value.@_value`, parsed as `Number()` if numeric, otherwise string. (Quest pattern lands in Task 8.)
  - `unit`: from `observation.value.@_unit` or `null`.
  - `ref_range`: from `observation.referenceRange.observationRange.text` text node; `null` if absent.
  - `interpretation`: from `observation.interpretationCode.@_code`; `null` if absent.
  - `source_document_key`: pass-through `''` for now (the orchestrator stamps it; see Task 14).

**Helper functions are mandatory** for `max-lines-per-function`. Suggested split:

```ts
function asArray<T>(x: T | T[] | undefined): T[] { ... }
function parseCoding(codeNode: any): Coding { ... }
function parseValue(valueNode: any): { value: number | string; unit: string | null } { ... }
function parseObservation(node: any): Observation { ... }
function extractFromResultsSection(section: any): Observation[] { ... }
```

`forbid-junk-object-types` will flag any remaining inline `{ ... }` shapes — replace with named types in `types.ts` if they appear. The XML parser returns `unknown`-ish shapes; cast via Zod schemas instead of `any` where the shape is non-trivial. The minimal pattern is a `z.object(...)` per element you read.

**Step 4: Run test, expect pass**

**Step 5: Add coverage tests for the other two metrics**

```ts
it('extracts HbA1c with percent unit', async () => { ... });
it('extracts triglycerides', async () => { ... });
```

**Step 6: Check + commit**

```bash
pnpm check
git add src/records/ccda.ts src/records/ccda.test.ts
git commit
```

Message: `Extract observations from CCDA Results section`

---

## Task 6: Observations from Vital Signs section

**Files:** Modify `src/records/ccda.ts`. Tests in `src/records/ccda.test.ts`.

**Step 1: Write failing test**

```ts
it('extracts vital signs (BP, weight) as uniform observations', async () => {
  const bytes = await loadFixture('ccda-rich-ccd.xml');
  const parsed = ccdaKind.parseDocument(bytes);
  const sysBP = parsed.observations.find((o) => o.coding.code === '8480-6');
  expect(sysBP?.value).toBe(118);
  expect(sysBP?.unit).toBe('mm[Hg]');
  expect(sysBP?.date).toBe('2024-06-15');
  const weight = parsed.observations.find((o) => o.coding.code === '29463-7');
  expect(weight?.value).toBe(178);
});
```

**Step 2: Run test, expect failure**

**Step 3: Implement vital signs extraction**

The Vital Signs section uses LOINC `8716-3`. Structurally: each entry has a CLUSTER organizer with multiple observation children — same shape as Results. Refactor `extractFromResultsSection` to a more general `extractObservations(section: ...)` that handles both.

Section dispatch in the top-level loop: if section code is `30954-2` or `8716-3`, run observation extraction. Other section codes get their own handlers in later tasks.

**Step 4: Run test, expect pass; check + commit**

```bash
pnpm check
git add src/records/ccda.ts src/records/ccda.test.ts
git commit
```

Message: `Extract observations from CCDA Vital Signs section`

---

## Task 7: `document_date_range` from observation span

**Files:** Modify `src/records/ccda.ts`. Test in `src/records/ccda.test.ts`.

**Step 1: Write failing test**

```ts
it('reports document_date_range spanning observation dates', async () => {
  const bytes = await loadFixture('ccda-rich-ccd.xml');
  const parsed = ccdaKind.parseDocument(bytes);
  expect(parsed.document_date_range).toEqual({ from: '2024-06-15', to: '2024-06-15' });
});
```

**Step 2: Run test, expect failure**

**Step 3: Implement**

After observations are extracted, compute `from` = min date, `to` = max date. If no observations, set `document_date_range` to `null`. Use string compare on `YYYY-MM-DD` (lexicographic ordering matches chronological).

**Step 4: Check + commit**

```bash
pnpm check
git add src/records/ccda.ts src/records/ccda.test.ts
git commit
```

Message: `Compute document_date_range from observation span`

---

## Task 8: Quest nullFlavor + translation pattern

**Files:** Create `src/records/__fixtures__/ccda-quest-translation.xml`. Modify `src/records/ccda.ts`. Test.

**Why:** Quest reports calculated metrics (Martin-Hopkins LDL, non-HDL, ratios, TIBC saturation, eGFR, %free PSA) using HL7's `nullFlavor="OTH"` on the outer `<value>` and the actual number on a nested `<translation value="...">`. The Python `extract_ccda.py` script flags this as the load-bearing parser quirk: a silent miss has burned this routine before.

**Step 1: Create the Quest-pattern fixture**

`src/records/__fixtures__/ccda-quest-translation.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <templateId root="2.16.840.1.113883.10.20.22.1.2"/>
  <effectiveTime value="20231120"/>
  <component>
    <structuredBody>
      <component>
        <section>
          <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
          <title>Results</title>
          <text>
            <table><tbody><tr><td ID="ldl-mh">LDL-C calc</td><td>92</td></tr></tbody></table>
          </text>
          <entry>
            <organizer classCode="BATTERY" moodCode="EVN">
              <effectiveTime value="20231120"/>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <code code="13457-7" codeSystem="2.16.840.1.113883.6.1" displayName="LDL-CHOLESTEROL"/>
                  <text><reference value="#ldl-mh"/></text>
                  <effectiveTime value="20231120"/>
                  <value xsi:type="PQ" nullFlavor="OTH">
                    <translation value="92">
                      <originalText>mg/dL</originalText>
                    </translation>
                  </value>
                </observation>
              </component>
            </organizer>
          </entry>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>
```

**Step 2: Write failing test**

```ts
it('falls through to translation when outer value is nullFlavor=OTH', async () => {
  const bytes = await loadFixture('ccda-quest-translation.xml');
  const parsed = ccdaKind.parseDocument(bytes);
  const ldl = parsed.observations.find((o) => o.coding.code === '13457-7');
  expect(ldl?.value).toBe(92);
  expect(ldl?.unit).toBe('mg/dL');
});
```

**Step 3: Run test, expect failure**

**Step 4: Implement fallback**

In `parseValue`: if `value.@_value` is absent, look at `value.translation.@_value`. Unit comes from `value.translation.originalText` text node when present, else `value.@_unit`.

**Step 5: Check + commit**

```bash
pnpm check
git add src/records/__fixtures__/ccda-quest-translation.xml src/records/ccda.ts src/records/ccda.test.ts
git commit
```

Message: `Handle Quest nullFlavor translation pattern in CCDA value parsing`

---

## Task 9: Structured Problems extraction

**Files:** Modify `src/records/ccda.ts`. Test in `src/records/ccda.test.ts`.

**Step 1: Write failing test**

The rich CCD fixture includes one Problem (Hyperlipidemia, ICD-10 E78.5).

```ts
it('extracts structured problems from Problems section', async () => {
  const bytes = await loadFixture('ccda-rich-ccd.xml');
  const parsed = ccdaKind.parseDocument(bytes);
  expect(parsed.problems).toHaveLength(1);
  const [p] = parsed.problems;
  expect(p?.name).toBe('Hyperlipidemia, unspecified');
  expect(p?.coding.system).toBe(SYSTEM_ICD10);
  expect(p?.coding.code).toBe('E78.5');
  expect(p?.status).toBe('completed');
  expect(p?.onset_date).toBe('2018-03-12');
});
```

**Step 2: Run test, expect failure**

**Step 3: Implement**

The Problems section uses LOINC `11450-4`. Each entry contains an `<act><entryRelationship><observation>`. For each such observation:

- `name`: from `observation.value.@_displayName`.
- `coding`: from `observation.value.@_code` + `observation.value.@_codeSystem`. The `@_xsi:type="CD"` indicates this is the FHIR-Coding-equivalent shape on a `<value>`.
- `status`: from `observation.statusCode.@_code`.
- `onset_date`: from `observation.effectiveTime.low.@_value`, `null` if absent. Format with `formatDate`.

The `xsi:type` attribute uses the `xsi:` prefix; in `fast-xml-parser` that's exposed as the literal `@_xsi:type`. Don't filter on this — just read the inner value/code attributes.

**Step 4: Check + commit**

```bash
pnpm check
git add src/records/ccda.ts src/records/ccda.test.ts
git commit
```

Message: `Extract structured Problems from CCDA`

---

## Task 10: Structured Medications extraction

**Files:** Modify `src/records/ccda.ts`. Test.

**Step 1: Write failing test**

```ts
it('extracts structured medications from Medications section', async () => {
  const bytes = await loadFixture('ccda-rich-ccd.xml');
  const parsed = ccdaKind.parseDocument(bytes);
  expect(parsed.medications).toHaveLength(1);
  const [m] = parsed.medications;
  expect(m?.name).toBe('atorvastatin 20 MG Oral Tablet');
  expect(m?.coding.system).toBe(SYSTEM_RXNORM);
  expect(m?.coding.code).toBe('617314');
  expect(m?.dose).toBe('20 mg');
  expect(m?.route).toBe('ORAL');
  expect(m?.status).toBe('active');
  expect(m?.start_date).toBe('2021-06-01');
  expect(m?.end_date).toBeNull();
});
```

**Step 2: Run test, expect failure**

**Step 3: Implement**

The Medications section uses LOINC `10160-0`. Each entry contains a `<substanceAdministration>` with:

- Coding: walk `consumable.manufacturedProduct.manufacturedMaterial.code` for `name`, `code`, `codeSystem`.
- `dose`: format `doseQuantity.@_value + ' ' + doseQuantity.@_unit`.
- `route`: `routeCode.@_displayName`.
- `frequency`: human-readable formatting of the `effectiveTime` with `xsi:type="PIVL_TS"` (`every 24h`, `every 12h`, etc. — see helper below). For v0, format as `every <period.@_value><period.@_unit>`. If absent, empty string.
- `status`: `statusCode.@_code`.
- `start_date`: from `effectiveTime.low.@_value` (the IVL_TS effectiveTime, not the PIVL_TS one). The CCDA pattern has two `effectiveTime` children — one is IVL_TS (start/end interval), one is PIVL_TS (recurrence). Disambiguate by `@_xsi:type`.
- `end_date`: from the IVL_TS `effectiveTime.high.@_value`, `null` if absent.

```ts
function formatFrequency(pivlTs: any): string {
  const period = pivlTs?.period;
  if (!period?.['@_value'] || !period?.['@_unit']) return '';
  return `every ${period['@_value']}${period['@_unit']}`;
}
```

Multiple `effectiveTime` children in the same parent come back from `fast-xml-parser` as an array. Use the `asArray` helper from Task 5.

**Step 4: Check + commit**

```bash
pnpm check
git add src/records/ccda.ts src/records/ccda.test.ts
git commit
```

Message: `Extract structured Medications from CCDA`

---

## Task 11: Empty-section handling

**Files:** Modify `src/records/ccda.ts`. Test.

A CCDA may omit a section entirely (e.g., a panel-only doc with no Vital Signs). Already-present extraction code should handle missing sections by yielding empty arrays without throwing.

**Step 1: Write failing test**

Use the existing minimal `ccda-valid.xml` (no body sections at all):

```ts
it('returns empty arrays when CCDA has no body sections', async () => {
  const bytes = await loadFixture('ccda-valid.xml');
  const parsed = ccdaKind.parseDocument(bytes);
  expect(parsed.observations).toEqual([]);
  expect(parsed.problems).toEqual([]);
  expect(parsed.medications).toEqual([]);
  expect(parsed.document_date_range).toBeNull();
});
```

**Step 2: Run, fix as needed**

If the test already passes, skip implementation. Likely needs: tolerate missing `component`, `structuredBody`, `entry`, etc. Use `?.` chains and the `asArray` helper.

**Step 3: Check + commit**

```bash
pnpm check
git add src/records/ccda.ts src/records/ccda.test.ts
git commit
```

Message: `Handle CCDAs with missing body sections`

---

## Task 12: Narrative-vs-structured self-check

**Files:** Create `src/records/__fixtures__/ccda-self-check-fail.xml`. Modify `src/records/ccda.ts`. Test.

**Why this is load-bearing:** The Python `extract_ccda.py` script's leading comment: "a silent XML-parse miss has already burned this routine once." When the narrative `<table>` shows a numeric value but the structured `<observation>/<value>` parses to empty, the parser is wrong. We catch this at parse time and refuse to emit.

**Step 1: Create the failing fixture**

`src/records/__fixtures__/ccda-self-check-fail.xml`. Same structure as the rich CCD but with one observation crafted to fail: narrative cell shows a number, structured `<value>` is missing both `@_value` and `<translation>`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <templateId root="2.16.840.1.113883.10.20.22.1.2"/>
  <effectiveTime value="20240301"/>
  <component>
    <structuredBody>
      <component>
        <section>
          <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
          <title>Results</title>
          <text>
            <table><tbody><tr><td ID="ldl-bad">LDL-C</td><td>142</td></tr></tbody></table>
          </text>
          <entry>
            <organizer classCode="BATTERY" moodCode="EVN">
              <effectiveTime value="20240301"/>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <code code="13457-7" codeSystem="2.16.840.1.113883.6.1" displayName="LDL-CHOLESTEROL"/>
                  <text><reference value="#ldl-bad"/></text>
                  <effectiveTime value="20240301"/>
                  <!-- broken: no @_value, no translation -->
                  <value xsi:type="PQ" nullFlavor="OTH"/>
                </observation>
              </component>
            </organizer>
          </entry>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>
```

**Step 2: Write failing test**

```ts
import { RecordParseError } from './errors.js';

it('throws RecordParseError when narrative says a number but structured value is empty (whitelisted metric)', async () => {
  const bytes = await loadFixture('ccda-self-check-fail.xml');
  expect(() => ccdaKind.parseDocument(bytes)).toThrow(RecordParseError);
  expect(() => ccdaKind.parseDocument(bytes)).toThrow(/LDL-CHOLESTEROL/);
});

it('passes self-check when narrative and structured agree (rich fixture)', async () => {
  const bytes = await loadFixture('ccda-rich-ccd.xml');
  expect(() => ccdaKind.parseDocument(bytes)).not.toThrow();
});
```

**Step 3: Run test, expect failure**

The first test fails because no self-check fires today; the second passes already.

**Step 4: Implement self-check**

Whitelist (mirrors the Python script's `SELF_CHECK_METRICS`):

```ts
const SELF_CHECK_DISPLAY_NAMES = new Set([
  'LDL-CHOLESTEROL',
  'TSH',
  'HEMOGLOBIN A1c',
  'TRIGLYCERIDES',
  'GLUCOSE',
]);
```

For each Results-section observation:

1. Read `observation.text.reference.@_value` (e.g., `'#ldl-2024-06'`). Strip the leading `#`.
2. Look up that ID in the section's narrative table — walk `<text><table>...<td ID="...">` to build a `Map<id, narrative_value_text>` once per section.
3. If the observation's display name is in the whitelist, the narrative-mapped value parses as a finite number, and the structured `value` is empty (`''` or missing) — throw `RecordParseError('ccda', 'narrative says ${narrativeValue}, structured parse empty for ${displayName} on ${date}')`.

The narrative-table walk should handle nested text nodes: use a recursive concatenation of all text descendants of the `<td>` element.

**Step 5: Run test, expect pass**

**Step 6: Check + commit**

```bash
pnpm check
git add src/records/__fixtures__/ccda-self-check-fail.xml src/records/ccda.ts src/records/ccda.test.ts
git commit
```

Message: `Self-check CCDA narrative vs structured for whitelisted metrics`

---

## Task 13: Encounter CCDA fixture and `document_type` detection

**Files:** Create `src/records/__fixtures__/ccda-encounter.xml`. Modify `src/records/ccda.ts`. Test.

**Step 1: Create encounter fixture**

`src/records/__fixtures__/ccda-encounter.xml` — same shape as rich-ccd but with the encounter-summary template ID and a single observation:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <!-- Discharge Summary template — encounter-shaped -->
  <templateId root="2.16.840.1.113883.10.20.22.1.8"/>
  <effectiveTime value="20240920"/>
  <component>
    <structuredBody>
      <component>
        <section>
          <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
          <title>Results</title>
          <text>
            <table><tbody><tr><td ID="glu">GLUCOSE</td><td>92</td></tr></tbody></table>
          </text>
          <entry>
            <organizer classCode="BATTERY" moodCode="EVN">
              <effectiveTime value="20240920"/>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <code code="2345-7" codeSystem="2.16.840.1.113883.6.1" displayName="GLUCOSE"/>
                  <text><reference value="#glu"/></text>
                  <effectiveTime value="20240920"/>
                  <value xsi:type="PQ" value="92" unit="mg/dL"/>
                </observation>
              </component>
            </organizer>
          </entry>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>
```

**Step 2: Write failing test**

```ts
it('detects encounter document_type from templateId', async () => {
  const bytes = await loadFixture('ccda-encounter.xml');
  const parsed = ccdaKind.parseDocument(bytes);
  expect(parsed.document_type).toBe('encounter');
  expect(parsed.observations).toHaveLength(1);
});

it('returns unknown for templateIds we do not recognize', async () => {
  const bytes = new TextEncoder().encode(
    `<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3">
       <templateId root="9.9.9.9"/>
       <effectiveTime value="20240101"/>
     </ClinicalDocument>`,
  );
  expect(ccdaKind.parseDocument(bytes).document_type).toBe('unknown');
});
```

**Step 3: Run test, expect failure**

**Step 4: Implement**

In `parseDocument`, walk every `templateId` (recall it can be array or single). Map any of the encounter-summary CCDA template IDs to `'encounter'`:

```ts
const CCD_TEMPLATE_IDS = new Set(['2.16.840.1.113883.10.20.22.1.2']);
const ENCOUNTER_TEMPLATE_IDS = new Set([
  '2.16.840.1.113883.10.20.22.1.8', // Discharge Summary
  '2.16.840.1.113883.10.20.22.1.9', // Progress Note
  '2.16.840.1.113883.10.20.22.1.13', // Operative Note
]);
```

If any templateId hits CCD set → `'ccd'`. Else if any hits encounter set → `'encounter'`. Else `'unknown'`.

**Step 5: Check + commit**

```bash
pnpm check
git add src/records/__fixtures__/ccda-encounter.xml src/records/ccda.ts src/records/ccda.test.ts
git commit
```

Message: `Detect encounter document_type from CCDA templateId`

---

## Task 14: Strict ingest — call `parseDocument`, fail on `RecordParseError`

**Files:** Modify `src/records/ingest.ts`. Modify `src/records/ingest.test.ts`.

**Step 1: Write failing test**

Add to `src/records/ingest.test.ts`:

```ts
it('rejects ingestion when parseDocument throws RecordParseError', async () => {
  const fixturePath = fileURLToPath(
    new URL('./__fixtures__/ccda-self-check-fail.xml', import.meta.url),
  );
  await expect(
    ingestRecord(store, async (p) => p, {
      path: fixturePath,
      kind: 'ccda',
      source: 'test',
    }),
  ).rejects.toBeInstanceOf(RecordParseError);
});
```

(Add imports: `import { fileURLToPath } from 'node:url';` and `import { RecordParseError } from './errors.js';`.)

**Step 2: Run test, expect failure**

(`ingestRecord` doesn't call `parseDocument` yet.)

**Step 3: Modify ingestRecord**

After `kindRegistry[kind].validateBytes(bytes)`, add:

```ts
kindRegistry[kind].parseDocument(bytes);
```

Discard the result — the design (`docs/plans/2026-04-28-query-design.md`, "Strict ingest") is explicit that the parsed output is thrown away. The query layer re-parses on first touch.

**Step 4: Run test, expect pass**

Also re-run the full ingest test suite to confirm the existing happy-path tests still pass (the rich CCD fixture passes self-check, so it should be fine).

**Step 5: Check + commit**

```bash
pnpm check
git add src/records/ingest.ts src/records/ingest.test.ts
git commit
```

Message: `Strict-fail ingest on parseDocument errors`

---

## Task 15: `ArchiveCache` scaffolding + `listDocuments`

**Files:** Create `src/query/archive.ts`, `src/query/archive.test.ts`, `src/query/index.ts`.

**Step 1: Write failing test**

`src/query/archive.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { ingestRecord } from '../records/index.js';
import { MemoryBlobStore } from '../storage/index.js';
import { ArchiveCache } from './archive.js';

async function ingestFixture(store: MemoryBlobStore, name: string): Promise<string> {
  const path = fileURLToPath(new URL(`../records/__fixtures__/${name}`, import.meta.url));
  const { key } = await ingestRecord(store, async (p) => p, {
    path,
    kind: 'ccda',
    source: 'test',
  });
  return key;
}

describe('ArchiveCache.listDocuments', () => {
  let store: MemoryBlobStore;
  let cache: ArchiveCache;

  beforeEach(() => {
    store = new MemoryBlobStore();
    cache = new ArchiveCache(store);
  });

  it('returns one entry per ingested CCDA with metadata', async () => {
    const richKey = await ingestFixture(store, 'ccda-rich-ccd.xml');
    const encKey = await ingestFixture(store, 'ccda-encounter.xml');
    const docs = await cache.listDocuments();
    expect(docs).toHaveLength(2);

    const rich = docs.find((d) => d.key === richKey);
    expect(rich).toMatchObject({
      kind: 'ccda',
      document_type: 'ccd',
      document_date: '2024-06-15',
      document_date_range: { from: '2024-06-15', to: '2024-06-15' },
    });
    expect(rich?.observation_count).toBeGreaterThan(0);
    expect(rich?.contributors_to).toEqual(
      expect.arrayContaining(['observations', 'problems', 'medications']),
    );

    const enc = docs.find((d) => d.key === encKey);
    expect(enc?.document_type).toBe('encounter');
    expect(enc?.contributors_to).toEqual(['observations']);
  });
});
```

**Step 2: Run test, expect failure**

(`ArchiveCache` doesn't exist.)

**Step 3: Implement**

`src/query/archive.ts`:

```ts
import type { ParsedDocument } from '../records/index.js';
import { kindRegistry, type Kind } from '../records/index.js';
import { type BlobStore, type Provenance, readProvenance } from '../storage/index.js';

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
  contributors_to: Array<'observations' | 'problems' | 'medications'>;
}

export class ArchiveCache {
  private readonly cache = new Map<string, ParsedDocument>();

  constructor(private readonly store: BlobStore) {}

  async listDocuments(): Promise<DocumentSummary[]> {
    const summaries: DocumentSummary[] = [];
    for await (const key of this.store.list()) {
      // Skip provenance sidecars; only iterate primary keys
      if (key.endsWith('.provenance.json')) continue;
      const parsed = await this.getParsed(key);
      const provenance = await readProvenance(this.store, key);
      summaries.push(buildSummary(key, parsed, provenance));
    }
    return summaries;
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
}

function inferKindFromKey(key: string): Kind {
  const prefix = key.split('/')[0];
  if (!prefix || !(prefix in kindRegistry)) {
    throw new Error(`unknown kind for key: ${key}`);
  }
  return prefix as Kind;
}

function buildSummary(
  key: string,
  parsed: ParsedDocument,
  provenance: Provenance,
): DocumentSummary {
  const contributors: DocumentSummary['contributors_to'] = [];
  if (parsed.observations.length > 0) contributors.push('observations');
  if (parsed.problems.length > 0) contributors.push('problems');
  if (parsed.medications.length > 0) contributors.push('medications');
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
    contributors_to: contributors,
  };
}
```

If `readProvenance` doesn't exist on the existing storage public surface, check `src/storage/index.ts` and `src/storage/provenance.ts` for the actual exported name. Use whatever's exported; the design assumes provenance reads are already supported.

`src/query/index.ts`:

```ts
export { ArchiveCache } from './archive.js';
export type { DocumentSummary } from './archive.js';
```

**Step 4: Run test, expect pass**

If `forbid-junk-object-types` fires on `DocumentSummary`'s `contributors_to: Array<'observations' | 'problems' | 'medications'>` shape because of an inline literal type — extract the union into a named `type Contributor = ...`.

**Step 5: Check + commit**

```bash
pnpm check
git add src/query/archive.ts src/query/archive.test.ts src/query/index.ts
git commit
```

Message: `Add ArchiveCache with listDocuments`

---

## Task 16: `ArchiveCache.listMetrics`

**Files:** Modify `src/query/archive.ts`, `src/query/archive.test.ts`, `src/query/index.ts`.

**Step 1: Write failing test**

```ts
describe('ArchiveCache.listMetrics', () => {
  it('aggregates LOINC observations across documents', async () => {
    const store = new MemoryBlobStore();
    await ingestFixture(store, 'ccda-rich-ccd.xml');
    await ingestFixture(store, 'ccda-encounter.xml');
    const cache = new ArchiveCache(store);
    const metrics = await cache.listMetrics();

    const ldl = metrics.find((m) => m.coding.code === '13457-7');
    expect(ldl?.coding.system).toBe(SYSTEM_LOINC);
    expect(ldl?.observation_count).toBe(1);
    expect(ldl?.unit).toBe('mg/dL');
    expect(ldl?.first_observed).toBe('2024-06-15');
    expect(ldl?.last_observed).toBe('2024-06-15');

    const glucose = metrics.find((m) => m.coding.code === '2345-7');
    expect(glucose?.observation_count).toBe(1);
  });

  it('reports unit as null when vendors disagree', async () => {
    // Construct a hypothetical: same LOINC, different units across docs
    // (TODO: skip if writing a fixture for this is too heavy; the case is exercised by archive.test.ts via mocked store)
  });
});
```

(The "vendors disagree" test is optional for v0; mark `it.skip` if not worth a fixture. Note in the plan; document why.)

**Step 2: Run test, expect failure**

**Step 3: Implement `listMetrics`**

```ts
export interface MetricCatalogEntry {
  coding: Coding;
  observation_count: number;
  first_observed: string;
  last_observed: string;
  unit: string | null;
}

async listMetrics(): Promise<MetricCatalogEntry[]> {
  const byCoding = new Map<string, MetricCatalogEntry>();
  for await (const key of this.store.list()) {
    if (key.endsWith('.provenance.json')) continue;
    const parsed = await this.getParsed(key);
    for (const obs of parsed.observations) {
      const id = `${obs.coding.system}|${obs.coding.code}`;
      const existing = byCoding.get(id);
      if (existing) {
        existing.observation_count += 1;
        if (obs.date < existing.first_observed) existing.first_observed = obs.date;
        if (obs.date > existing.last_observed) existing.last_observed = obs.date;
        if (existing.unit !== obs.unit) existing.unit = null;
      } else {
        byCoding.set(id, {
          coding: { ...obs.coding },
          observation_count: 1,
          first_observed: obs.date,
          last_observed: obs.date,
          unit: obs.unit,
        });
      }
    }
  }
  return [...byCoding.values()];
}
```

Re-export `MetricCatalogEntry` from `src/query/index.ts`.

**Step 4: Run test, expect pass; check + commit**

```bash
pnpm check
git add src/query/archive.ts src/query/archive.test.ts src/query/index.ts
git commit
```

Message: `Add ArchiveCache.listMetrics`

---

## Task 17: `ArchiveCache.getObservationHistory`

**Files:** Modify `src/query/archive.ts`, `src/query/archive.test.ts`.

**Step 1: Write failing test**

```ts
describe('ArchiveCache.getObservationHistory', () => {
  it('filters by codings and returns observations sorted by date', async () => {
    const store = new MemoryBlobStore();
    await ingestFixture(store, 'ccda-rich-ccd.xml');
    await ingestFixture(store, 'ccda-quest-translation.xml');
    const cache = new ArchiveCache(store);
    const history = await cache.getObservationHistory({
      codings: [{ system: SYSTEM_LOINC, code: '13457-7' }],
    });
    expect(history).toHaveLength(2);
    expect(history[0]?.date).toBe('2023-11-20');
    expect(history[1]?.date).toBe('2024-06-15');
    expect(history.every((o) => o.coding.code === '13457-7')).toBe(true);
  });

  it('merges multiple codings', async () => {
    const store = new MemoryBlobStore();
    await ingestFixture(store, 'ccda-rich-ccd.xml');
    const cache = new ArchiveCache(store);
    const history = await cache.getObservationHistory({
      codings: [
        { system: SYSTEM_LOINC, code: '13457-7' },
        { system: SYSTEM_LOINC, code: '4548-4' },
      ],
    });
    expect(history.map((o) => o.coding.code).sort()).toEqual(['13457-7', '4548-4']);
  });

  it('applies since/until date filters', async () => {
    const store = new MemoryBlobStore();
    await ingestFixture(store, 'ccda-rich-ccd.xml');
    await ingestFixture(store, 'ccda-quest-translation.xml');
    const cache = new ArchiveCache(store);
    const history = await cache.getObservationHistory({
      codings: [{ system: SYSTEM_LOINC, code: '13457-7' }],
      since: '2024-01-01',
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.date).toBe('2024-06-15');
  });
});
```

**Step 2: Run test, expect failure**

**Step 3: Implement**

```ts
export interface ObservationHistoryQuery {
  codings: Coding[];
  since?: string;
  until?: string;
}

async getObservationHistory(query: ObservationHistoryQuery): Promise<Observation[]> {
  const wantedIds = new Set(query.codings.map((c) => `${c.system}|${c.code}`));
  const out: Observation[] = [];
  for await (const key of this.store.list()) {
    if (key.endsWith('.provenance.json')) continue;
    const parsed = await this.getParsed(key);
    for (const obs of parsed.observations) {
      const id = `${obs.coding.system}|${obs.coding.code}`;
      if (!wantedIds.has(id)) continue;
      if (query.since && obs.date < query.since) continue;
      if (query.until && obs.date > query.until) continue;
      out.push({ ...obs, source_document_key: key });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
```

`source_document_key` is stamped here, not by the parser — the parser doesn't know its own key. The `...obs` spread plus override is the cheapest version.

`exactOptionalPropertyTypes` is on (see `tsconfig.json`). Don't pass `since: undefined` to the function — the input type uses `since?: string`, which means "absent" must mean omitted, not `undefined`. Inside the function, `query.since && ...` is the correct check.

**Step 4: Re-export from `src/query/index.ts`**

```ts
export type { MetricCatalogEntry, ObservationHistoryQuery } from './archive.js';
```

**Step 5: Check + commit**

```bash
pnpm check
git add src/query/archive.ts src/query/archive.test.ts src/query/index.ts
git commit
```

Message: `Add ArchiveCache.getObservationHistory with date filters`

---

## Task 18: `ArchiveCache.getCurrentProblems`

**Files:** Modify `src/query/archive.ts`, `src/query/archive.test.ts`.

**Step 1: Write failing test**

```ts
describe('ArchiveCache.getCurrentProblems', () => {
  it('returns problems from the most recent CCD-shaped document', async () => {
    const store = new MemoryBlobStore();
    const richKey = await ingestFixture(store, 'ccda-rich-ccd.xml');
    await ingestFixture(store, 'ccda-encounter.xml');
    const cache = new ArchiveCache(store);
    const result = await cache.getCurrentProblems();
    expect(result.source_document_key).toBe(richKey);
    expect(result.source_document_date).toBe('2024-06-15');
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.coding.code).toBe('E78.5');
  });

  it('returns empty + note when no CCD-shaped document exists', async () => {
    const store = new MemoryBlobStore();
    await ingestFixture(store, 'ccda-encounter.xml');
    const cache = new ArchiveCache(store);
    const result = await cache.getCurrentProblems();
    expect(result.source_document_key).toBeNull();
    expect(result.problems).toEqual([]);
    expect(result.note).toMatch(/no CCD-shaped/i);
  });
});
```

**Step 2: Run test, expect failure**

**Step 3: Implement**

```ts
export interface CurrentProblemsResult {
  source_document_key: string | null;
  source_document_date: string | null;
  problems: Problem[];
  note?: string;
}

async getCurrentProblems(): Promise<CurrentProblemsResult> {
  const ccd = await this.findMostRecentCcd();
  if (!ccd) {
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

private async findMostRecentCcd(): Promise<{ key: string; parsed: ParsedDocument } | null> {
  let best: { key: string; parsed: ParsedDocument } | null = null;
  for await (const key of this.store.list()) {
    if (key.endsWith('.provenance.json')) continue;
    const parsed = await this.getParsed(key);
    if (parsed.document_type !== 'ccd') continue;
    if (!best || parsed.document_date > best.parsed.document_date) {
      best = { key, parsed };
    }
  }
  return best;
}
```

`exactOptionalPropertyTypes` and the optional `note` field: when the CCD is found, omit `note` entirely from the returned object — don't set it to `undefined`.

**Step 4: Check + commit**

```bash
pnpm check
git add src/query/archive.ts src/query/archive.test.ts src/query/index.ts
git commit
```

Message: `Add ArchiveCache.getCurrentProblems`

---

## Task 19: `ArchiveCache.getCurrentMedications`

Same pattern as Task 18.

**Files:** Modify `src/query/archive.ts`, `src/query/archive.test.ts`, `src/query/index.ts`.

**Step 1: Write failing test** — mirror the Problems tests against `cache.getCurrentMedications()`. Assert `medications[0]?.coding.code === '617314'`.

**Step 2: Run, fail**

**Step 3: Implement** — copy the Problems shape; `findMostRecentCcd` is reusable. The only difference is which array to return.

**Step 4: Check + commit**

Message: `Add ArchiveCache.getCurrentMedications`

---

## Task 20: Wire `ArchiveCache` into MCP server boot

**Files:** Modify `src/mcp/server.ts`.

`registerIngestRecordTool` already exists; this task adds an `ArchiveCache` instance to `startMcpServer` so the tool registrations in subsequent tasks have something to call.

**Step 1: Modify `startMcpServer`**

After `const { logger, store } = buildCore(true);`:

```ts
const archive = new ArchiveCache(store);
```

Pass `archive` into the new tool registration functions added in Tasks 21–25.

For now (this task), no tool registrations consume `archive` yet — but typecheck passes because `archive` is unused on the surface. To avoid `noUnusedLocals` complaints, defer creating the variable until Task 21 — _or_ register a placeholder. **Cleaner option:** combine this step into Task 21's commit.

**Decision:** Skip this task as a standalone commit. Roll the `ArchiveCache` instantiation into Task 21.

(This task is a placeholder for clarity in the plan; no work to commit. Move on to Task 21.)

---

## Task 21: `list_documents` MCP tool

**Files:** Modify `src/mcp/server.ts`. Modify `src/mcp/server.test.ts`.

**Step 1: Write failing E2E test**

In `src/mcp/server.test.ts`, add a new `describe` block. Reuse the `buildHarness` helper but extend it (or add a parallel helper) to register the new tools. Suggested shape:

```ts
async function buildQueryHarness(): Promise<Harness & { archive: ArchiveCache }> {
  const store = new MemoryBlobStore();
  const archive = new ArchiveCache(store);
  const mcp = new McpServer({ name: 'vitals', version: 'test' });

  registerListDocumentsTool(mcp, archive);

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: 'test' }, { capabilities: {} });
  await Promise.all([mcp.connect(serverT), client.connect(clientT)]);

  return {
    client,
    store,
    archive,
    dispose: async () => {
      await client.close();
      await mcp.close();
    },
  };
}

describe('list_documents tool', () => {
  it('returns ingested CCDAs with metadata', async () => {
    const h = await buildQueryHarness();
    try {
      // seed via direct ArchiveCache → store path; ingestRecord requires path validation
      const richPath = fileURLToPath(
        new URL('../records/__fixtures__/ccda-rich-ccd.xml', import.meta.url),
      );
      const richBytes = await readFile(richPath);
      // Use ingestRecord with permissive path validator since this is a unit-test harness
      // (or seed the store directly via store.put + writeProvenance)
      ...
      const res = (await h.client.callTool({ name: 'list_documents', arguments: {} })) as ToolTextResponse;
      const body = JSON.parse(extractText(res));
      expect(body).toHaveLength(1);
      expect(body[0].document_type).toBe('ccd');
    } finally {
      await h.dispose();
    }
  });
});
```

For seeding the store, the simplest path is reusing `ingestRecord` with a permissive `validatePath` (returns the input unchanged). `ingestRecord` will write the blob and the provenance both. Use `await ingestRecord(h.store, async (p) => p, { path: richPath, kind: 'ccda', source: 'test' })`.

**Step 2: Run test, expect failure**

(`registerListDocumentsTool` doesn't exist.)

**Step 3: Implement**

In `src/mcp/server.ts`:

```ts
import { ArchiveCache } from '../query/index.js';

export function registerListDocumentsTool(mcp: McpServer, archive: ArchiveCache): void {
  mcp.registerTool(
    'list_documents',
    {
      description:
        'List all ingested documents in the vitals archive with metadata, document type, date range, observation count, and which patient-state concepts each document contributes to.',
      inputSchema: {},
    },
    async () => {
      const docs = await archive.listDocuments();
      return { content: [{ type: 'text', text: JSON.stringify(docs, null, 2) }] };
    },
  );
}
```

In `startMcpServer`:

```ts
const archive = new ArchiveCache(store);
registerIngestRecordTool(mcp, store, roots);
registerListDocumentsTool(mcp, archive);
```

**Step 4: Run test, expect pass; check + commit**

```bash
pnpm check
git add src/mcp/server.ts src/mcp/server.test.ts
git commit
```

Message: `Register list_documents MCP tool`

---

## Task 22: `list_metrics` MCP tool

**Files:** `src/mcp/server.ts`, `src/mcp/server.test.ts`.

**Step 1: Failing test** — call `list_metrics`, parse JSON, assert `body.find((m) => m.coding.code === '13457-7').coding.display === 'LDL-CHOLESTEROL'`.

**Step 2: Run, fail**

**Step 3: Implement** — `registerListMetricsTool(mcp, archive)`. Same shape as `list_documents`, returns `archive.listMetrics()` JSON.

**Step 4: Wire into `startMcpServer` and `buildQueryHarness`. Check + commit.**

Message: `Register list_metrics MCP tool`

---

## Task 23: `get_observation_history` MCP tool

**Files:** `src/mcp/server.ts`, `src/mcp/server.test.ts`.

**Step 1: Failing test** — call with `arguments: { codings: [{ system: SYSTEM_LOINC, code: '13457-7' }] }`. Assert non-empty result.

**Step 2: Run, fail**

**Step 3: Implement**

This tool's input has structure. Define a Zod schema:

```ts
const GetObservationHistoryInputSchema = z.object({
  codings: z
    .array(
      z.object({
        system: z.string().min(1),
        code: z.string().min(1),
      }),
    )
    .min(1),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .optional(),
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .optional(),
});
```

Pass `GetObservationHistoryInputSchema.shape` as `inputSchema` to `registerTool`. The handler narrows the typed input, builds the `ObservationHistoryQuery`, and calls `archive.getObservationHistory`. Watch the `exactOptionalPropertyTypes` rule: build the query object conditionally rather than passing `since: undefined`.

**Step 4: Check + commit**

Message: `Register get_observation_history MCP tool`

---

## Task 24: `get_current_problems` MCP tool

**Files:** `src/mcp/server.ts`, `src/mcp/server.test.ts`.

**Step 1: Failing test** — assert returned `problems[0].coding.code === 'E78.5'`.

**Step 2: Run, fail**

**Step 3: Implement** — no input schema. Returns `archive.getCurrentProblems()` JSON.

**Step 4: Check + commit**

Message: `Register get_current_problems MCP tool`

---

## Task 25: `get_current_medications` MCP tool

**Files:** `src/mcp/server.ts`, `src/mcp/server.test.ts`.

**Step 1: Failing test** — assert returned `medications[0].coding.code === '617314'`.

**Step 2: Run, fail**

**Step 3: Implement** — same shape as Task 24.

**Step 4: Check + commit**

Message: `Register get_current_medications MCP tool`

---

## Task 26: End-to-end smoke

**Files:** None modified.

**Step 1: Full check**

```bash
pnpm check
```

Expected: green across format, lint, typecheck, forbid-junk-object-types, all tests.

**Step 2: Boot the MCP server (manual)**

```bash
pnpm run start:mcp --allowed-dir /tmp
```

Expected: starts, prints nothing useful to stdout (stdio is reserved for JSON-RPC), logs to stderr, exits cleanly on SIGINT.

**Step 3: Hand-test against an MCP client (optional, depending on what's available)**

Configure Claude Code or Claude Desktop to spawn the server, then verify each tool from a chat. Skip if no client is set up.

**Step 4: No commit needed** unless smoke uncovered something.

---

## Acceptance recap

End state matches the design doc's Acceptance section:

1. `list_documents` returns ingested fixtures with `document_type` and `document_date_range`.
2. `list_metrics` returns the union LOINC catalog.
3. `get_observation_history` returns sorted observations, with multi-coding merge and date-range filtering.
4. `get_current_problems` and `get_current_medications` return structured arrays from the most recent CCD-shaped document.
5. With only encounter CCDAs ingested, `get_current_*` returns empty + `note`.
6. Ingesting a self-check-fail fixture → `parse_failed`.

## Notes for the executor

- Read `docs/plans/2026-04-28-query-design.md` first. Then `docs/plans/2026-04-25-ingestion-design.md` for context on the storage and records layers this builds on. Then this plan.
- The CLAUDE.md "Lint policy" is non-negotiable. If a rule fires, refactor the code, not the rule.
- `forbid-junk-object-types` will fire on inline shapes the moment a function gets a non-trivial parameter. Lift the type into `types.ts` as a named interface and import it.
- `fast-xml-parser` returns `unknown`-shaped trees. The right narrowing pattern is a Zod schema per element type you read; don't `as any`. The existing `ccda.ts` validateBytes path uses Zod for the root element — extend that pattern.
- Provenance-sidecar key suffixes are managed by `src/storage/provenance.ts`. The `archive.ts` "skip provenance" check should use the suffix exported from that module rather than a hardcoded `.provenance.json` string. Verify the export name when you implement Task 15 and adjust the snippet.
- Each task's commit should leave `pnpm check` green. If you find yourself needing to skip a check to land a commit, the task wasn't done.
