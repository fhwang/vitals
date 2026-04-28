# Query design

**Date:** 2026-04-28
**Status:** Approved, pending implementation

## Goal

Add the query layer that the ingestion design (`docs/plans/2026-04-25-ingestion-design.md`) deferred. After this lands, any MCP-speaking LLM client can browse the archive, query metrics across formats, and read current patient state — without knowing CCDA's structure or any specific routine.

## Context

The ingestion layer wrote durable bytes + provenance, validated kind on the way in, and explicitly deferred temporal/semantic queries to a future "index" subsystem. This design _is_ that subsystem, shaped around patient state rather than document structure.

Three architectural choices underlie everything below:

1. **Patient-state-centric, not format-centric.** Tools are shaped around patient concepts (observations, problems, medications), not around document kinds. CCDA is the only contributor today; future kinds (FHIR Condition imports, Apple Health, Dexcom) merge into the same tools transparently — a kind with nothing to say about a concept simply doesn't contribute.

2. **Tools-only, no resources or prompts.** MCP exposes tools (model-controlled, universally accessible across clients), resources (application-controlled, support varies), and prompts (user-controlled). For a server intended to be hooked into by any LLM-driven client, tools are universally accessible; resources require client-side support that isn't uniform. Workflows (e.g., a weekly health summary) are the client's concern, not this server's.

3. **FHIR `Coding` identity.** Every coded value uses `{system, code, display?}` — the FHIR data-payload form. LOINC handles labs and vitals; RxNorm handles meds; ICD-10 / SNOMED handle problems. This is the standard form FHIR resources use internally — JSON-Schema-validatable, symmetric between input and output. Compact-URI / token-search forms were considered and rejected: token form requires the LLM to recall full system URIs as part of a string, which is exactly the recall failure mode this design is trying to avoid.

## Decisions

### Tool surface

Six tools total (one existing, five new):

```ts
// existing
ingest_record(...)

// discovery
list_documents()
  → Array<{
      key, kind, ingested_at, source, original_filename,
      document_type: 'ccd' | 'encounter' | 'unknown',
      document_date: 'YYYY-MM-DD',
      document_date_range: { from, to } | null,
      observation_count,
      contributors_to: Array<'observations' | 'problems' | 'medications'>,
    }>

list_metrics()
  → Array<{
      coding: { system, code, display? },
      observation_count, first_observed, last_observed,
      unit: string | null,                // null when vendors disagree
    }>

// data
get_observation_history({
  codings: Array<{ system: string, code: string }>,
  since?: 'YYYY-MM-DD',
  until?: 'YYYY-MM-DD',
})
  → Array<Observation>

get_current_problems()
  → {
      source_document_key: string | null,
      source_document_date: 'YYYY-MM-DD' | null,
      problems: Array<Problem>,
      note?: string,                      // populated when no CCD-shaped doc
    }

get_current_medications()
  → {
      source_document_key: string | null,
      source_document_date: 'YYYY-MM-DD' | null,
      medications: Array<Medication>,
      note?: string,
    }
```

Shapes:

```ts
Observation = {
  coding: { system, code, display? },
  date: 'YYYY-MM-DD',
  value: number | string,                 // string for non-numeric ('NEGATIVE')
  unit: string | null,
  ref_range: string | null,
  interpretation: string | null,          // 'H', 'L', etc.
  source_document_key: string,
}

Problem = {
  name: string,
  coding: { system, code, display? },     // ICD-10 or SNOMED
  status: string,
  onset_date: 'YYYY-MM-DD' | null,
}

Medication = {
  name: string,
  coding: { system, code, display? },     // RxNorm
  dose: string,
  route: string,
  frequency: string,
  status: string,
  start_date: 'YYYY-MM-DD' | null,
  end_date: 'YYYY-MM-DD' | null,
}
```

### Coding inputs and constants

Inputs use the FHIR `Coding` shape. A small constants module exposes the canonical FHIR system URIs:

```ts
// src/records/coding.ts
export const SYSTEM_LOINC = 'http://loinc.org';
export const SYSTEM_RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
export const SYSTEM_ICD10 = 'http://hl7.org/fhir/sid/icd-10-cm';
export const SYSTEM_SNOMED = 'http://snomed.info/sct';
```

Internal code references these constants; we don't scatter system-URI string literals.

### Sourcing for `get_current_*`

Pick the most recent document with `document_type === 'ccd'`. Sort by `document_date` (CCDA header `effectiveTime`) descending; first wins. If the archive contains no CCD-shaped doc, return empty arrays plus a `note` field explaining (so the agent can interpret the absence rather than guess why it got nothing).

When future kinds contribute to problems or medications, the sourcing rule needs revisiting. Punted for now (single contributor → no conflict).

### Records-layer architecture

The records-layer's `KindHandler` interface grows one method:

```ts
interface KindHandler {
  kind: Kind;
  extension: string;
  contentType: string;
  validateBytes(bytes): void; // existing — narrow kind check
  parseDocument(bytes): ParsedDocument; // new — full extraction
}

interface ParsedDocument {
  document_type: 'ccd' | 'encounter' | 'unknown'; // from CCDA templateId
  document_date: 'YYYY-MM-DD'; // from CCDA header effectiveTime
  document_date_range: { from: string; to: string } | null; // YYYY-MM-DD; span across observations
  observations: Observation[];
  problems: Problem[];
  medications: Medication[];
}
```

For CCDA, `parseDocument` does what the Python `extract_ccda.py` script does today:

- Parses XML (already wired via `fast-xml-parser`).
- Extracts observations from the Results section _and_ the Vital Signs section's `<organizer>`s. Both contribute to a single uniform `Observation[]` keyed by LOINC; the tool surface treats labs and vitals identically.
- Handles Quest's `nullFlavor="OTH"` + nested `<translation value="...">` pattern. If the outer `value.@_value` is absent, falls through to `value.translation.@_value`. Units come from `translation.originalText` when present, otherwise the outer `value.@_unit`.
- Extracts structured Problems entries (name + ICD-10 or SNOMED Coding + status + onset).
- Extracts structured Medications entries (name + RxNorm Coding + dose + route + frequency + status + dates).
- Reads `templateId` to set `document_type` (CCD = 2.16.840.1.113883.10.20.22.1.2; encounter summary has its own template).
- Runs the **narrative-vs-structured self-check** on whitelisted metrics (LDL-C, HbA1c, TSH, triglycerides, glucose). For each whitelisted observation, follows `<text><reference value="#..."/></text>` into the section's narrative `<table>` and confirms the structured parse matches the narrative cell. A numeric narrative value paired with an empty structured value throws `RecordParseError`. The Python script's comment puts it bluntly: a silent XML-parse miss has already burned this routine once.

### Strict ingest

`ingestRecord` calls `handler.parseDocument(bytes)` after the existing `handler.validateBytes(bytes)`. A `RecordParseError` from either path fails the ingest with code `parse_failed`. A CCDA whose parser self-check fails never enters the archive.

The parsed output is discarded after ingest. The query layer re-parses on first touch within its own session — slight inefficiency, real simplicity gain (no persistent sidecar to maintain, no schema-migration story for parsed-format changes).

### Lazy parse, in-memory cache per session

```ts
// src/query/archive.ts
class ArchiveCache {
  private cache: Map<string, ParsedDocument>;       // keyed by blob key
  constructor(private store: BlobStore) {}

  async listDocuments(): Promise<DocumentSummary[]>
  async listMetrics(): Promise<MetricCatalogEntry[]>
  async getObservationHistory(codings, since, until): Promise<Observation[]>
  async getCurrentProblems(): Promise<...>
  async getCurrentMedications(): Promise<...>
}
```

One `ArchiveCache` per MCP session, constructed during server boot, lifetime equals session lifetime. First query touching a document triggers `parseDocument`; subsequent queries reuse the cache.

This is enough at personal scale (a few dozen CCDAs at most, each KB-MB). When the archive grows or cross-session caching becomes worth it, the cache evolves into a persistent index — but the tool surface stays the same.

## File inventory

```
src/records/
├── types.ts                  # Observation, Problem, Medication, ParsedDocument
├── coding.ts                 # SYSTEM_LOINC, SYSTEM_RXNORM, SYSTEM_ICD10, SYSTEM_SNOMED
├── kind-registry.ts          # KindHandler extended with parseDocument()
├── ccda.ts                   # implements parseDocument + self-check
├── ccda.test.ts              # XML extraction + Quest-translation + self-check fixtures
├── ingest.ts                 # calls parseDocument after validateBytes; fails on RecordParseError
├── ingest.test.ts            # adds: self-check failure → ingest rejected with parse_failed
└── __fixtures__/             # CCD-shaped fixture, encounter fixture, self-check-fail fixture

src/query/
├── index.ts                  # public surface
├── archive.ts                # ArchiveCache
└── archive.test.ts           # against MemoryBlobStore + fixtures

src/mcp/
├── server.ts                 # registers 5 new tools alongside ingest_record
└── server.test.ts            # end-to-end client tests per tool
```

No new top-level deps; `fast-xml-parser` already lands with ingestion.

## Acceptance

```
pnpm run check                                # all green
pnpm run start:mcp --allowed-dir <some-dir>   # MCP server boots on stdio
```

End-to-end test (`server.test.ts`) against an in-memory transport with two fixture CCDAs ingested:

1. `list_documents` returns both, with `document_type` and `document_date_range` populated.
2. `list_metrics` returns the union of LOINC observations across both, with display names and counts.
3. `get_observation_history({ codings: [{ system: SYSTEM_LOINC, code: '13457-7' }] })` returns LDL-C observations sorted by date.
4. Same with two codings in the array (e.g., calculated + direct LDL) merges results.
5. `get_current_problems` and `get_current_medications` return structured arrays sourced from the most recent CCD-shaped document.
6. With only encounter-type CCDAs ingested, `get_current_*` returns empty array plus `note`.
7. Ingesting a CCDA with a narrative/structured mismatch on a whitelisted metric → `parse_failed`.

## Deferred

- **Persistent parsed cache / sidecar / SQLite index.** Lazy in-memory cache is enough at personal scale; revisit when archive size or cross-session reuse warrants it. Tool surface stays the same.
- **Resources and subscriptions.** Adding a parallel resource surface for browseable state and change notifications is straightforward later. Not in v0.
- **MCP prompts.** Workflows belong to clients.
- **Concept-level synonym dictionary** (e.g., `ldl_c` → `[13457-7, 18262-6, 2089-1]`). Discovery + LLM display-name matching covers the bridging in v0.
- **Sourcing rules for multi-contributor concepts.** Today only CCDA contributes to problems and medications. When a second source appears, write the rule explicitly.
- **`get_document` for per-document drill-down.** v0 has no per-document detail beyond what `list_documents` returns; add when summaries grow.
- **Streamable HTTP transport.** stdio is the right shape for personal local-host; HTTP is for hosted multi-client. SDK swap is one line when needed.
- **Additional record kinds.** Apple Health, Dexcom, journal entries each become a new `KindHandler` with its own `validateBytes` + `parseDocument`. The query layer absorbs them without changes.
