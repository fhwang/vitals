# Ingestion design

**Date:** 2026-04-25 (revised 2026-04-27)
**Status:** Approved, implemented

## Goal

Add the first ingestion path for health records. Scope: one MCP tool that an AI agent can call to push a CCDA file into the archive. The HTTP surface is unchanged. Format awareness lives in a small `src/records/` layer that sits between the MCP tool and the existing `src/storage/` blob layer. CCDA is the only supported kind in v0; the design is shaped so adding new kinds is mechanical.

## Context

The storage layer (`docs/plans/2026-04-25-storage-design.md`) landed a generic blob store with put/get/head/list/delete + a single-record provenance sidecar. It is deliberately format-agnostic. This design adds the first writer.

Two architectural choices made earlier still hold:

1. **External parties don't navigate the archive.** Ingestion and query both go through HTTP/MCP. Browsability of the archive directory is a developer affordance at most, not a user feature.
2. **Indexing is its own future subsystem.** Today the archive is durable bytes + provenance. The eventual index will be reproducible from the archive alone and own all temporal/semantic queries.

A third choice clarified during design: **CCDA — and most plausible record kinds — are _composite_, not atomic.** A single CCDA (specifically a Continuity of Care Document, LOINC 34133-9, the most common EHR export shape) is a longitudinal patient summary covering years and many encounters. There is no single "observation date" you can attach to such a blob without lying about its contents. Apple Health exports, Garmin/Dexcom CSVs, and lab PDFs share this composite property. Atomic kinds (journal entries, single-encounter H&P notes) exist but are the exception.

This rules out the original instinct to partition the archive by date. Dates are an _index-layer_ concern. The archive layer should not pretend to know.

So the records layer narrows to two responsibilities: **validate that bytes match the asserted kind**, and **construct a content-addressed key**. Everything temporal is deferred.

## Decisions

### Transport: MCP stdio, separate process from HTTP

Each MCP session is a fresh process spawned by the agent harness (Claude Desktop, Claude Code, etc.) over stdio. No port, no auth header story, no network exposure. The HTTP server stays a long-lived daemon for query/health.

Two entry points sharing the same domain code:

```
src/index.ts          # HTTP entry (existing)
src/mcp/server.ts     # MCP stdio entry (new)
```

The process shapes are different enough to justify two entries: HTTP wants signal handling and a port; MCP-stdio wants stdout reserved for JSON-RPC and a short lifetime. A `--mode` flag would fight both concerns. Boot logic that's actually shared (config + `BlobStore` construction) lives in `src/bootstrap.ts`.

Rejected: HTTP/SSE MCP transport. Right answer for hosted multi-client servers; wrong answer for a personal local archive.

### Tool surface: one tool, kind-as-argument

```ts
ingest_record({
  path: string,                 // absolute, must be inside an advertised/CLI root
  kind: 'ccda',                 // z.enum derived from kindRegistry keys
  source: string,               // free-form, e.g. 'portal-export'
  original_filename?: string,   // defaults to basename(path)
})
=> { key: string; kind: string }
```

One tool, not one-tool-per-kind. New kinds extend the `kind` enum, not the tool list. The tool description spells out the supported kinds so the agent sees them in the listing without schema introspection.

Errors are surfaced as structured MCP errors with codes: `unsupported_kind`, `path_outside_roots`, `parse_failed`, `file_not_found`. The agent reads the code and decides what to do.

The response is intentionally minimal. No `observation_date`: the records layer doesn't claim to know when a composite document "happened," and inventing a single date for a CCD or longitudinal export would be misleading. The agent gets the storage key; that's what it needs to reference the blob later.

### Caller asserts kind, server validates

The agent asserts `kind: 'ccda'`. The server's per-kind handler runs `validateBytes(bytes)` — a narrow check that the bytes match the asserted kind. For CCDA: parse XML, confirm root element is `ClinicalDocument` with `xmlns="urn:hl7-org:v3"`. Throw `RecordParseError` otherwise.

This is the same role the parser played in the earlier draft of this design — _the validator is the verifier_ — but pared down to "are these bytes plausibly this kind?" rather than "extract a temporal anchor." The narrower check is enough for the trust posture (a casual agent mis-classifying a file gets caught at ingest, not silently mis-stored), and it's all we need before the index gets built.

Why caller-asserts:

- Kind is a single low-cardinality claim; agents rarely mis-classify at this level.
- The validator backstops it: bytes that don't sniff as the asserted kind are rejected with a clear error.
- An auto-sniffer is extra code with its own correctness story; collapsing it into per-kind validators is simpler.

### Path-based input, validated against MCP roots (with CLI fallback)

The agent passes a filesystem path. The MCP client (the agent harness) advertises a [roots list](https://modelcontextprotocol.io/specification/2025-06-18/client/roots) of allowed directories; the server validates each ingest path against the resolved real-path of those roots before reading. This is the canonical MCP pattern for "agent points server at a file" — see Anthropic's reference [filesystem MCP server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem).

Validation steps in `src/mcp/roots.ts`:

1. Resolve to absolute, then `fs.realpath` (kills symlink-escape attacks).
2. Check the real path is the root, or starts with `root + path.sep` (trailing-separator boundary check).
3. Subscribe to `notifications/roots/list_changed` to refresh the cached set.

**CLI fallback.** Real-world MCP clients (notably Claude Code, [issue #3315](https://github.com/anthropics/claude-code/issues/3315)) advertise the `roots` capability but do not actually return roots from `roots/list`. To remain usable, the server accepts repeatable `--allowed-dir <path>` flags on the command line; the union of CLI dirs + protocol-advertised roots is what `validatePath` checks against. CLI dirs persist across protocol refreshes.

Fail closed when neither source produces a root: every ingest returns `path_outside_roots`.

Rejected alternatives:

- **Inline content as a string arg.** Works for KB-scale text but caps the design at low-MB; binary requires base64 doubling; the bytes round-trip through the agent's context window. Doesn't generalize to lab PDFs or DICOM.
- **Out-of-band upload via presigned URL.** Right answer for cross-host multi-GB ingest. Heavy infrastructure for a personal local-host workflow.

### Key scheme: `<kind>/<sha256>.<ext>`

```
ccda/8f3a2b1c0d4e9f7a6b5c8d2e1f0a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a.xml
```

- `<kind>` — registered kind. Derivable from the key.
- `<sha256>` — full sha256 hex of the bytes. Zero collision anxiety, no thinking required.
- `<ext>` — declared by the kind handler.

Flat under `<kind>/`. Personal-scale archives won't accumulate enough files per kind to need directory sharding. If that ever changes, switch to `<kind>/<first-2-hex>/<rest>.<ext>` without breaking semantics.

**Idempotency falls out for free.** Same bytes → same hash → same key. Two ingests of the same file collapse to one write (storage's `put` overwrites identical bytes).

**Why not date-partitioned.** Date-based paths only make sense if every blob has _one_ meaningful date. CCDA, the most common ingest target, is composite — it doesn't. Apple Health, Dexcom CSVs, lab PDFs are similarly composite. Forcing one of those into a single-date path either picks an arbitrary winner (export date, first encounter, last encounter) or adds parser branching that the index will redo anyway. Content-addressing keeps the archive layer honest about what it knows: just bytes.

The eventual index will extract per-observation dates from the body of each blob and answer all temporal queries — that's its job. The archive doesn't need to do part of it.

### Format awareness lives in `src/records/`

`src/storage/` stays generic and untouched. `src/records/` owns kind validation, key construction, and provenance authoring. The orchestrator in `src/records/ingest.ts`:

```ts
export async function ingestRecord(
  store: BlobStore,
  validatePath: (p: string) => Promise<string>,
  input: { path: string; kind: Kind; source: string; original_filename?: string },
): Promise<{ key: string; kind: Kind }>;
```

`BlobStore` and `validatePath` are injected — keeps the orchestrator testable against `MemoryBlobStore` with a permissive validator. The MCP server provides both at wire-up time.

### Kind registry shape

Each kind module exports a single handler:

```ts
// src/records/ccda.ts
export const ccdaKind: KindHandler = {
  kind: 'ccda',
  extension: 'xml',
  contentType: 'application/xml',
  validateBytes(bytes: Uint8Array): void {
    // parse XML, confirm root ClinicalDocument with xmlns="urn:hl7-org:v3"
    // throws RecordParseError on failure
  },
};
```

The registry composes them into a typed map:

```ts
// src/records/kind-registry.ts
import { ccdaKind } from './ccda.js';

export const kindRegistry = { ccda: ccdaKind } as const;
export type Kind = keyof typeof kindRegistry;

export interface KindHandler {
  kind: Kind;
  extension: string;
  contentType: string;
  validateBytes(bytes: Uint8Array): void;
}
```

Adding `journal`, `dexcom`, `apple-health`: write `<kind>.ts` exporting a handler, add one line to the registry. `Kind` narrows automatically; the MCP tool's Zod schema is `z.enum(Object.keys(kindRegistry))` and validates against the live set.

Errors are thrown, not returned. A `RecordParseError` from `validateBytes` surfaces at the MCP boundary as `parse_failed`. Result-type plumbing isn't worth it at this scale.

### Provenance

```json
{
  "source": "portal-export",
  "ingested_at": "2026-04-25T14:32:11Z",
  "original_filename": "20201015_VisitSummary.xml",
  "content_hash": "sha256:..."
}
```

Single record per blob. With content-addressed keys, `content_hash` is technically redundant with the key — kept for the integrity-check use case (verify-bytes-match-key) and because provenance is the canonical metadata file, not a path-only fact.

## File inventory

```
src/bootstrap.ts                  # shared config + BlobStore construction

src/records/
├── index.ts                      # public surface
├── ingest.ts                     # orchestrator
├── kind-registry.ts              # registry + KindHandler interface + Kind type
├── ccda.ts                       # ccdaKind handler (validateBytes)
├── ccda.test.ts                  # CCDA fixtures: valid, malformed, wrong root, wrong namespace
├── ingest.test.ts                # orchestrator with MemoryBlobStore + permissive validator
└── errors.ts                     # RecordParseError, UnsupportedKindError, ...

src/mcp/
├── server.ts                     # entry: McpServer, StdioServerTransport, tool wiring, parseAllowedDirs
├── roots.ts                      # RootsState: cache + validatePath
├── roots.test.ts                 # symlink escape, .. traversal, boundary checks
└── server.test.ts                # SDK Client + in-memory transport, end-to-end ingest_record + parseAllowedDirs unit tests

package.json                      # adds @modelcontextprotocol/sdk, fast-xml-parser; adds dev:mcp/start:mcp scripts
```

New deps: **`@modelcontextprotocol/sdk`**, **`fast-xml-parser`**.

## Acceptance

```
pnpm run check                                     # all green
pnpm run start:mcp --allowed-dir <some-dir>        # MCP server boots on stdio (no errors to stderr)
```

Plus, end-to-end test (`server.test.ts`) covers:

1. Client advertises a roots list; calls `ingest_record` with a valid CCDA fixture.
2. Result has `key` matching `ccda/[0-9a-f]{64}\.xml` and `kind: 'ccda'`.
3. Re-ingesting the same bytes returns the same key (idempotent).
4. Path outside roots → `path_outside_roots`.
5. Bytes that don't sniff as CCDA → `parse_failed`.
6. (Schema-rejected before reaching the handler) Unknown kind via Zod.

Plus `parseAllowedDirs` unit tests cover empty, single, multi, and malformed argv.

## Deferred

- **Additional kinds** (journal, dexcom, apple-health, lab PDFs). Each is a new `<kind>.ts` + registry line + tests.
- **Index / query layer.** Where per-observation date extraction, cross-format temporal queries, partial-date handling, period semantics, and FHIR-style `effective[x]` live. Bi-temporal modeling (recording vs effective time) belongs there, not here.
- **Out-of-band upload path** (presigned URLs). Needed when ingest moves cross-host or files exceed JSON-RPC-comfortable scale.
- **Streaming reads.** Today's CCDAs are KB; switch to `fs.createReadStream` + multipart upload when a kind needs it.
- **`raw/<sha256>.<ext>` fallback for unrecognized formats.** Forensics-friendly; not needed until we ingest something we don't have a handler for.
- **Directory sharding under `<kind>/`.** Personal scale doesn't need it.
