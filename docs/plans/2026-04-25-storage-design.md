# Storage layer design

**Date:** 2026-04-25
**Status:** Approved, ready to execute

## Goal

Define a pluggable blob-storage abstraction with two production backends — local filesystem and AWS S3 (plus S3-compatibles via custom endpoint) — and an in-memory backend for tests. The operator picks the backend via a single env var and the rest of the service is storage-agnostic. Scope is limited to byte-level operations on raw record blobs plus an immutable provenance sidecar per blob. Query indexing is deferred to its own design.

## Context

The parent plan (`~/Desktop/rewrite-vitals.md`) and the scaffold design (`docs/plans/2026-04-23-project-scaffold-design.md`) assume an AWS S3 archive holding raw bytes plus a `.meta.json` sidecar per record, with bucket-as-index navigability. The scaffold landed an empty service with no storage code; this design specifies what `src/storage/` actually contains.

Two architectural shifts narrow the scope versus the parent plan:

1. **No direct storage-level access from outside parties.** Ingestion and query both go through HTTP/MCP. The bucket no longer needs to be self-navigable as an external interface; only the service walks it.
2. **Query indexing will evolve.** Time-series engines (InfluxDB, DuckDB-over-Parquet), full-text indexes, and embedding stores are plausible future additions. Indexing is its own subsystem with its own swap-out story, not coupled to the storage layer.

Combined effect: storage shrinks to "blob ops + minimum-viable provenance," and everything queryable moves to a deferred index layer.

## Decisions

### Sidecar reframe: provenance vs. indexed projections

The parent plan's `.meta.json` muddled two jobs:

- **Provenance** — facts the bytes can never tell you alone (`source`, `ingested_at`, original filename). Lost forever if not captured at ingest. Belongs in the archive.
- **Indexed projections** — fields extracted by parsers (`encounter_type`, `sections`, kind-specific metadata). Always re-derivable. Belong in a separate index layer (deferred).

Splitting them protects the invariant worth holding:

> The archive must be a complete superset of any index. Any index must be reproducible from the archive alone.

Hold this and future query engines can be swapped without migration pain.

### Provenance sidecar contents

Four fields per blob, written to `<blob-key>.provenance.json`:

```json
{
  "source": "portal-export",
  "ingested_at": "2026-04-25T14:32:11Z",
  "original_filename": "20201015_VisitSummary.xml",
  "content_hash": "sha256:..."
}
```

- **`source`** — never in the bytes; classifies how the record entered the system.
- **`ingested_at`** — explicit; storage-layer `lastModified` drifts on copy/migration.
- **`original_filename`** — invaluable for debug/audit, disposable on its own.
- **`content_hash`** — sha256 of the bytes as stored; integrity, dedupe, tamper detection.

Excluded: `kind`, `id` (derivable from key); `content_type`, `size_bytes` (storage layer surfaces them); `date`, kind-specific metadata (parser-derived → index).

Naming: `.provenance.json`, not the parent plan's `.meta.json`. The file is strictly provenance now; rename clarifies intent.

Write order: blob first, sidecar second. Single-user system; partial-write recovery is a future `vitals doctor` job that lists orphans. Not worth a two-phase commit.

### Storage abstraction: in-house thin wrapper, no library

Five-method interface:

```ts
interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  head(key: string): Promise<BlobMeta | null>;
  list(prefix: string): AsyncIterable<BlobEntry>;
  delete(key: string): Promise<void>;
}

type BlobMeta = { size: number; lastModified: Date; contentType?: string };
type BlobEntry = { key: string; size: number; lastModified: Date };
```

No streams in v0 — `Uint8Array` everywhere. CCDA blobs are KB–MB; compressed device exports stay well below where buffering matters. Add `putStream`/`getStream` the day a real file size justifies it.

**Library choice: none.** Considered:

- **`@flystorage/file-storage`** — cleanest blob-shaped API, fs + S3 adapters, streams-first.
- **`unstorage`** (UnJS) — largest driver list, but KV-flavored API is a slight mismatch for raw-bytes-by-key plus prefix listing.
- **`flydrive`** (AdonisJS) — similar to Flystorage, smaller surface.
- **Apache OpenDAL** Node bindings — most powerful, broadest backend list, but a Rust native module is a heavy dep for a project this small.

With the scope above, a library's saves (streaming, multipart uploads, listing pagination) either don't apply or are ~10 lines each. Adopting any of them costs an integration layer roughly equal in size to writing the adapters directly. `@aws-sdk/client-s3` and `node:fs/promises` are already required; calling them through ~50 lines per adapter is the lowest-dependency path.

### Adapters

Three adapters, all behind `BlobStore`:

- **`LocalFsBlobStore`** — `node:fs/promises`. Resolves keys against a configured root. Rejects keys containing `..`, leading `/`, or absolute paths (path-traversal safety). Auto-creates root + parent dirs on first write. `list` walks the directory tree.
- **`S3BlobStore`** — `@aws-sdk/client-s3` v3 modular. `Put/Get/Head/Delete/ListObjectsV2Command`. `list` loops on `NextContinuationToken` and yields entries lazily via async iteration.
- **`MemoryBlobStore`** — `Map<string, { bytes, contentType, lastModified }>`. Production-quality (it must satisfy the same contract as the others). Exported for use in tests.

App code only ever imports `BlobStore`, `createBlobStore`, and (in tests) `MemoryBlobStore`. Adapters are constructed by the factory, not by callers.

### Config: single URL-shaped env var

```bash
# Local
VITALS_STORAGE_URL=file:///Users/fhwang/vitals-archive

# AWS S3
VITALS_STORAGE_URL=s3://fhwang-vitals-archive?region=us-east-1

# S3-compatible (R2, B2, MinIO) — endpoint optional
VITALS_STORAGE_URL=s3://my-bucket?region=auto&endpoint=https://abc.r2.cloudflarestorage.com
```

Parsed by Zod `.transform()` into a discriminated union:

```ts
type StorageConfig =
  | { driver: 'local'; root: string }
  | { driver: 's3'; bucket: string; region: string; endpoint?: string };
```

Boot fails fast on malformed URL, non-absolute local path, or missing region for S3. No default — operator must set the value.

**Credentials: AWS SDK's standard chain.** Env vars (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`), shared credentials file, IAM role, container metadata. Don't put credentials in the URL — they leak into logs and process listings. Don't reinvent credential resolution.

Rationale for URL shape: matches the `DATABASE_URL` convention operators already recognize; one env var instead of three; scales to future backends (`gs://`, plain `s3://` with new endpoints) without schema churn.

### Wiring

`src/index.ts`:

1. `loadConfig()` returns a typed `Config` whose `.storage` field is already a parsed `StorageConfig`.
2. `createBlobStore(config.storage)` returns a `BlobStore`.
3. The `BlobStore` is injected into HTTP handlers and record modules via constructor / function args. No module-level singletons; nothing reaches into env at use sites.

### Testing

A **single shared contract test** (`blob-store.contract.ts`) accepts a `() => BlobStore` factory and exercises:

- put/get round-trip across content types and binary payloads
- `head` returning correct `size`, `lastModified`, `contentType`
- `head` returning `null` for missing keys
- `list` returning all entries under a prefix
- `list` returning empty for prefixes with no matches
- `delete` removing only the named key
- key-traversal rejection (`..`, leading `/`)

Run from three test files — `memory.test.ts`, `local-fs.test.ts` (per-test temp dir), and `s3.test.ts` (opt-in via `VITALS_TEST_S3_BUCKET`; skipped in CI absent the env var). Memory and fs runs are CI-mandatory; S3 is run manually until a CI test bucket is provisioned.

## File inventory

```
src/storage/
├── index.ts                    # public surface; re-exports
├── blob-store.ts               # BlobStore interface + BlobMeta + BlobEntry
├── factory.ts                  # createBlobStore
├── local-fs.ts                 # LocalFsBlobStore
├── s3.ts                       # S3BlobStore
├── memory.ts                   # MemoryBlobStore
├── provenance.ts               # Provenance schema, readProvenance, writeProvenance, provenanceKey
├── url.ts                      # parseStorageUrl: string → StorageConfig
├── blob-store.contract.ts      # shared contract test runner (not a *.test.ts)
├── memory.test.ts              # invokes contract runner
├── local-fs.test.ts            # invokes contract runner + fs-specific cases
├── s3.test.ts                  # opt-in via VITALS_TEST_S3_BUCKET
├── provenance.test.ts
└── url.test.ts

src/config.ts                   # extended: adds VITALS_STORAGE_URL via Zod transform
.env.example                    # extended: shows local + s3 URL forms
```

New deps: **`@aws-sdk/client-s3`** only. No storage-abstraction library.

## Acceptance

```
pnpm run check                                                    # all green

# Local backend boots without AWS:
VITALS_STORAGE_URL=file:///tmp/vitals-test pnpm run dev           # server starts, /health 200

# Functional smoke (manual until HTTP routes exist):
node --eval "
  import('./dist/storage/index.js').then(async ({ createBlobStore }) => {
    const s = createBlobStore({ driver: 'local', root: '/tmp/vitals-test' });
    await s.put('ccda/test.xml', new TextEncoder().encode('<x/>'), 'application/xml');
    console.log(await s.head('ccda/test.xml'));
  });
"
```

Plus the contract test passes against `MemoryBlobStore` and `LocalFsBlobStore` in CI.

## Deferred

- **Index layer.** Separate subsystem with its own design doc when query needs land. Today: `vitals` only knows how to put/get/list raw bytes. Listing CCDAs by date or filtering observations by kind comes in the index design.
- **Streaming put/get.** Not needed at current blob sizes.
- **`vitals doctor` orphan-recovery command.** Lists blobs without sidecars (or vice versa). Useful once the system has accumulated failure modes.
- **`vitals reindex` command.** Belongs to the index design.
- **Multipart uploads.** Required only for objects >5 GB.
- **S3 bucket-config concerns** (server-side encryption flags, lifecycle, versioning). Live in the deployment plan, not the service code.
- **GCS / Azure / first-class R2 / B2 adapters.** R2 and B2 work today via `s3://` + custom endpoint. Native adapters deferred until a concrete need exists; the factory and URL parser are easy to extend.
