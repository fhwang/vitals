# Ingestion Implementation Plan

> **Note (2026-04-27):** Tasks 1–21 of this plan landed as written, then the design was reworked: date-partitioned keys gave way to content-addressed `<kind>/<sha256>.<ext>` keys, `extractObservationDate` became `validateBytes`, the tool response dropped `observation_date`, and `--allowed-dir` shipped as a CLI fallback. See the updated `2026-04-25-ingestion-design.md` for current shape; see git history for the rework commits.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use superpowers:test-driven-development for any task that has tests.

**Goal:** Build the CCDA ingestion path specified in `docs/plans/2026-04-25-ingestion-design.md`. One MCP `ingest_record` tool that takes a roots-validated filesystem path + asserted kind, parses to derive an observation date, writes the blob and provenance under a date-partitioned key.

**Architecture:** Three new modules. `src/records/` owns format awareness (kind registry + per-kind handlers + ingest orchestrator). `src/mcp/` owns transport, roots state, and tool wiring. `src/bootstrap.ts` shares config + `BlobStore` construction between the existing HTTP entry and the new MCP entry. `src/storage/` is unchanged.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import suffix), Vitest, Zod, `fast-xml-parser`, `@modelcontextprotocol/sdk`.

**Working directory:** This plan executes inside the worktree at `.claude/worktrees/feat-ingestion/` on branch `worktree-feat-ingestion`. All paths below are relative to the worktree root.

**Verification:** After each task, run `pnpm check` (format + lint + typecheck + forbid-junk-object-types + test). Don't commit until it's green. If `forbid-junk-object-types` fires, narrow the type with a Zod schema or a named interface — never use `Record<string, unknown>` as an inline-shape workaround (see CLAUDE.md "Lint policy").

**Commit style:** Match recent history (`Add ...`, short imperative line). One commit per task. Co-author trailer per the project default.

---

## Task 1: Add `fast-xml-parser` and `@modelcontextprotocol/sdk`

**Files:** `package.json`, `pnpm-lock.yaml`

**Step 1: Install**

```bash
pnpm add fast-xml-parser @modelcontextprotocol/sdk
```

**Step 2: Verify**

```bash
pnpm list fast-xml-parser @modelcontextprotocol/sdk
```

Both should resolve to recent versions.

**Step 3: Run check**

```bash
pnpm check
```

Expected: green (no code changes yet).

**Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit
```

Message: `Add fast-xml-parser and @modelcontextprotocol/sdk dependencies`

---

## Task 2: Records errors module

**Files:** Create `src/records/errors.ts`

Typed errors so the MCP layer can map them to structured error codes without `instanceof` chains in handler code.

**Step 1: Write the file**

```ts
export class RecordParseError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string, options?: ErrorOptions) {
    super(`parse failed for ${kind}: ${message}`, options);
    this.name = 'RecordParseError';
    this.kind = kind;
  }
}

export class UnsupportedKindError extends Error {
  readonly kind: string;
  readonly supportedKinds: readonly string[];
  constructor(kind: string, supportedKinds: readonly string[]) {
    super(`unsupported kind: ${kind} (supported: ${supportedKinds.join(', ')})`);
    this.name = 'UnsupportedKindError';
    this.kind = kind;
    this.supportedKinds = supportedKinds;
  }
}

export class PathOutsideRootsError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`path is not inside any advertised root: ${path}`);
    this.name = 'PathOutsideRootsError';
    this.path = path;
  }
}

export class FileNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`file not found: ${path}`);
    this.name = 'FileNotFoundError';
    this.path = path;
  }
}
```

**Step 2: Run check**

```bash
pnpm check
```

Expected: green.

**Step 3: Commit**

```bash
git add src/records/errors.ts
git commit
```

Message: `Add typed errors for records ingestion`

---

## Task 3: KindHandler interface

**Files:** Create `src/records/kind-registry.ts`

Skeleton for now — interface only, no entries. Task 9 will add `ccda`.

**Step 1: Write the file**

```ts
export interface KindHandler {
  readonly kind: string;
  readonly extension: string;
  readonly contentType: string;
  extractObservationDate(bytes: Uint8Array): Date;
}
```

(Registry and `Kind` type land in Task 9 once `ccdaKind` exists.)

**Step 2: Run check**

```bash
pnpm check
```

Expected: green.

**Step 3: Commit**

```bash
git add src/records/kind-registry.ts
git commit
```

Message: `Add KindHandler interface for records ingestion`

---

## Task 4: CCDA fixtures

**Files:** Create `src/records/__fixtures__/ccda-valid.xml`, `src/records/__fixtures__/ccda-date-only.xml`, `src/records/__fixtures__/ccda-missing-effective-time.xml`, `src/records/__fixtures__/not-ccda.xml`

Hand-rolled minimal fixtures — keep them small, focused on the parser's contract.

**`ccda-valid.xml`:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20201015143211-0500"/>
</ClinicalDocument>
```

**`ccda-date-only.xml`:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20201015"/>
</ClinicalDocument>
```

**`ccda-missing-effective-time.xml`:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <title>No effective time</title>
</ClinicalDocument>
```

**`not-ccda.xml`:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<SomeOtherDocument>
  <effectiveTime value="20201015"/>
</SomeOtherDocument>
```

**Step 1: Create the four fixture files** with the contents above.

**Step 2: Confirm Prettier doesn't try to reformat them**

XML isn't a Prettier-handled format, so these should pass `pnpm format:check` untouched. If Prettier complains, add `*.xml` to `.prettierignore`.

**Step 3: Run check**

```bash
pnpm check
```

Expected: green.

**Step 4: Commit**

```bash
git add src/records/__fixtures__/
git commit
```

Message: `Add CCDA test fixtures (valid, date-only, malformed variants)`

---

## Task 5: CCDA handler — happy path test

**Files:** Create `src/records/ccda.test.ts`

**Step 1: Write the failing test**

```ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ccdaKind } from './ccda.js';

async function loadFixture(name: string): Promise<Uint8Array> {
  const url = new URL(`./__fixtures__/${name}`, import.meta.url);
  return readFile(fileURLToPath(url));
}

describe('ccdaKind', () => {
  it('declares kind, extension, and contentType', () => {
    expect(ccdaKind.kind).toBe('ccda');
    expect(ccdaKind.extension).toBe('xml');
    expect(ccdaKind.contentType).toBe('application/xml');
  });

  it('extracts the observation date from a valid CCDA', async () => {
    const bytes = await loadFixture('ccda-valid.xml');
    const date = ccdaKind.extractObservationDate(bytes);
    expect(date.toISOString().slice(0, 10)).toBe('2020-10-15');
  });
});
```

**Step 2: Run test — expected to fail**

```bash
pnpm test -- ccda
```

Expected: FAIL with module-not-found / `ccdaKind is not defined`.

**Step 3: Write `src/records/ccda.ts`**

```ts
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';

import { RecordParseError } from './errors.js';
import type { KindHandler } from './kind-registry.js';

const EffectiveTimeSchema = z.object({
  '@_value': z.string().min(8),
});

const ClinicalDocumentSchema = z.object({
  ClinicalDocument: z.object({
    effectiveTime: EffectiveTimeSchema,
  }),
});

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

export const ccdaKind: KindHandler = {
  kind: 'ccda',
  extension: 'xml',
  contentType: 'application/xml',
  extractObservationDate(bytes: Uint8Array): Date {
    const xml = new TextDecoder().decode(bytes);
    let parsed: unknown;
    try {
      parsed = parser.parse(xml);
    } catch (err) {
      throw new RecordParseError('ccda', 'malformed XML', { cause: err });
    }
    const result = ClinicalDocumentSchema.safeParse(parsed);
    if (!result.success) {
      throw new RecordParseError('ccda', 'document is not a valid CCDA');
    }
    const value = result.data.ClinicalDocument.effectiveTime['@_value'];
    const yyyy = value.slice(0, 4);
    const mm = value.slice(4, 6);
    const dd = value.slice(6, 8);
    const date = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) {
      throw new RecordParseError('ccda', `invalid effectiveTime value: ${value}`);
    }
    return date;
  },
};
```

**Step 4: Run test — expected to pass**

```bash
pnpm test -- ccda
```

Expected: PASS.

**Step 5: Run full check**

```bash
pnpm check
```

Expected: green.

**Step 6: Commit**

```bash
git add src/records/ccda.ts src/records/ccda.test.ts
git commit
```

Message: `Add CCDA kind handler with effectiveTime extraction`

---

## Task 6: CCDA handler — date-only format

**Files:** Modify `src/records/ccda.test.ts`

**Step 1: Add the failing test**

Append to the `describe('ccdaKind', ...)` block:

```ts
it('extracts the date from a date-only effectiveTime', async () => {
  const bytes = await loadFixture('ccda-date-only.xml');
  const date = ccdaKind.extractObservationDate(bytes);
  expect(date.toISOString().slice(0, 10)).toBe('2020-10-15');
});
```

**Step 2: Run test**

```bash
pnpm test -- ccda
```

Expected: PASS without code changes — the existing slice logic handles 8-character values fine. If it fails, debug the parser config.

**Step 3: Run check**

```bash
pnpm check
```

Expected: green.

**Step 4: Commit**

```bash
git add src/records/ccda.test.ts
git commit
```

Message: `Test CCDA date-only effectiveTime extraction`

---

## Task 7: CCDA handler — error cases

**Files:** Modify `src/records/ccda.test.ts`

**Step 1: Add the failing tests**

Append:

```ts
it('throws RecordParseError for malformed XML', () => {
  const bytes = new TextEncoder().encode('<not really valid');
  expect(() => ccdaKind.extractObservationDate(bytes)).toThrow(/malformed XML/);
});

it('throws RecordParseError when effectiveTime is missing', async () => {
  const bytes = await loadFixture('ccda-missing-effective-time.xml');
  expect(() => ccdaKind.extractObservationDate(bytes)).toThrow(/not a valid CCDA/);
});

it('throws RecordParseError when root element is not ClinicalDocument', async () => {
  const bytes = await loadFixture('not-ccda.xml');
  expect(() => ccdaKind.extractObservationDate(bytes)).toThrow(/not a valid CCDA/);
});
```

**Step 2: Run tests**

```bash
pnpm test -- ccda
```

Expected: PASS. (`fast-xml-parser` may not throw on `<not really valid` — it sometimes returns an empty object instead. If so, the schema validation catches it as "not a valid CCDA"; update the regex in the malformed-XML test to match that path.)

**Step 3: Run check**

```bash
pnpm check
```

Expected: green.

**Step 4: Commit**

```bash
git add src/records/ccda.test.ts
git commit
```

Message: `Test CCDA parser error cases`

---

## Task 8: Wire `ccdaKind` into the registry

**Files:** Modify `src/records/kind-registry.ts`

**Step 1: Update the file**

```ts
import { z } from 'zod';

import { ccdaKind } from './ccda.js';

export interface KindHandler {
  readonly kind: string;
  readonly extension: string;
  readonly contentType: string;
  extractObservationDate(bytes: Uint8Array): Date;
}

export const kindRegistry = {
  ccda: ccdaKind,
} as const satisfies Record<string, KindHandler>;

export type Kind = keyof typeof kindRegistry;

const kindKeys = Object.keys(kindRegistry) as [Kind, ...Kind[]];

export const KindSchema = z.enum(kindKeys);
```

**Step 2: Run check**

```bash
pnpm check
```

Expected: green.

**Step 3: Commit**

```bash
git add src/records/kind-registry.ts
git commit
```

Message: `Wire ccda into kind registry; export Kind type and KindSchema`

---

## Task 9: Ingest orchestrator — happy path

**Files:** Create `src/records/ingest.test.ts`, `src/records/ingest.ts`

**Step 1: Write the failing test**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryBlobStore, readProvenance } from '../storage/index.js';
import { ingestRecord } from './ingest.js';

describe('ingestRecord', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vitals-ingest-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const fixture = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20201015143211-0500"/>
</ClinicalDocument>`;

  const passthroughValidator = async (p: string) => p;

  it('writes blob + provenance and returns a date-partitioned key', async () => {
    const filePath = join(tmpDir, 'visit.xml');
    await writeFile(filePath, fixture, 'utf8');
    const store = new MemoryBlobStore();

    const result = await ingestRecord(store, passthroughValidator, {
      path: filePath,
      kind: 'ccda',
      source: 'portal-export',
    });

    expect(result.kind).toBe('ccda');
    expect(result.observation_date).toBe('2020-10-15');
    expect(result.key).toMatch(/^ccda\/2020\/10\/15\/[0-9a-f]{12}\.xml$/);

    const meta = await store.head(result.key);
    expect(meta).not.toBeNull();
    expect(meta?.size).toBe(new TextEncoder().encode(fixture).byteLength);

    const provenance = await readProvenance(store, result.key);
    expect(provenance).not.toBeNull();
    expect(provenance?.source).toBe('portal-export');
    expect(provenance?.original_filename).toBe('visit.xml');
    expect(provenance?.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
```

**Step 2: Run test — expected to fail**

```bash
pnpm test -- ingest
```

Expected: FAIL — `ingestRecord` is not defined.

**Step 3: Write `src/records/ingest.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { BlobStore } from '../storage/index.js';
import { hashBytes, writeProvenance } from '../storage/index.js';
import { FileNotFoundError, UnsupportedKindError } from './errors.js';
import { kindRegistry, type Kind } from './kind-registry.js';

export interface IngestInput {
  path: string;
  kind: string;
  source: string;
  original_filename?: string;
}

export interface IngestResult {
  key: string;
  kind: Kind;
  observation_date: string;
}

export async function ingestRecord(
  store: BlobStore,
  validatePath: (path: string) => Promise<string>,
  input: IngestInput,
): Promise<IngestResult> {
  if (!Object.prototype.hasOwnProperty.call(kindRegistry, input.kind)) {
    throw new UnsupportedKindError(input.kind, Object.keys(kindRegistry));
  }
  const handler = kindRegistry[input.kind as Kind];

  const realPath = await validatePath(input.path);

  let bytes: Uint8Array;
  try {
    bytes = await readFile(realPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new FileNotFoundError(input.path);
    throw err;
  }

  const date = handler.extractObservationDate(bytes);
  const fullHash = hashBytes(bytes);
  const shortHash = fullHash.slice('sha256:'.length, 'sha256:'.length + 12);
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const key = `${handler.kind}/${yyyy}/${mm}/${dd}/${shortHash}.${handler.extension}`;

  await store.put(key, bytes, handler.contentType);
  await writeProvenance(store, key, {
    source: input.source,
    ingested_at: new Date().toISOString(),
    original_filename: input.original_filename ?? basename(input.path),
    content_hash: fullHash,
  });

  return { key, kind: handler.kind as Kind, observation_date: `${yyyy}-${mm}-${dd}` };
}
```

**Step 4: Run test**

```bash
pnpm test -- ingest
```

Expected: PASS.

**Step 5: Run check**

```bash
pnpm check
```

Expected: green.

**Step 6: Commit**

```bash
git add src/records/ingest.ts src/records/ingest.test.ts
git commit
```

Message: `Add ingestRecord orchestrator with date-partitioned keys`

---

## Task 10: Ingest orchestrator — idempotency

**Files:** Modify `src/records/ingest.test.ts`

**Step 1: Add the test**

```ts
it('is idempotent: same bytes produce the same key', async () => {
  const filePath = join(tmpDir, 'visit.xml');
  await writeFile(filePath, fixture, 'utf8');
  const store = new MemoryBlobStore();

  const first = await ingestRecord(store, passthroughValidator, {
    path: filePath,
    kind: 'ccda',
    source: 'portal-export',
  });
  const second = await ingestRecord(store, passthroughValidator, {
    path: filePath,
    kind: 'ccda',
    source: 'portal-export-rerun',
  });

  expect(second.key).toBe(first.key);

  const entries: string[] = [];
  for await (const entry of store.list('ccda/')) entries.push(entry.key);
  // one blob + one provenance sidecar — same bytes never produce two
  expect(entries.filter((k) => k.endsWith('.xml')).length).toBe(1);
});
```

**Step 2: Run test**

```bash
pnpm test -- ingest
```

Expected: PASS without code changes.

**Step 3: Run check**

```bash
pnpm check
```

Expected: green.

**Step 4: Commit**

```bash
git add src/records/ingest.test.ts
git commit
```

Message: `Test ingestRecord idempotency on repeated bytes`

---

## Task 11: Ingest orchestrator — error cases

**Files:** Modify `src/records/ingest.test.ts`

**Step 1: Add the tests**

```ts
it('throws UnsupportedKindError for an unknown kind', async () => {
  const store = new MemoryBlobStore();
  await expect(
    ingestRecord(store, passthroughValidator, {
      path: '/anywhere',
      kind: 'unknown-kind',
      source: 'x',
    }),
  ).rejects.toThrow(/unsupported kind/);
});

it('surfaces validator failures (e.g., path outside roots)', async () => {
  const store = new MemoryBlobStore();
  const rejecting = async (_p: string) => {
    throw new Error('outside roots');
  };
  await expect(
    ingestRecord(store, rejecting, { path: '/nope', kind: 'ccda', source: 'x' }),
  ).rejects.toThrow(/outside roots/);
});

it('throws FileNotFoundError when the file does not exist', async () => {
  const store = new MemoryBlobStore();
  await expect(
    ingestRecord(store, passthroughValidator, {
      path: join(tmpDir, 'does-not-exist.xml'),
      kind: 'ccda',
      source: 'x',
    }),
  ).rejects.toThrow(/file not found/);
});

it('surfaces RecordParseError when bytes are not valid CCDA', async () => {
  const filePath = join(tmpDir, 'garbage.xml');
  await writeFile(filePath, '<NotCCDA/>', 'utf8');
  const store = new MemoryBlobStore();
  await expect(
    ingestRecord(store, passthroughValidator, {
      path: filePath,
      kind: 'ccda',
      source: 'x',
    }),
  ).rejects.toThrow(/parse failed for ccda/);
});
```

**Step 2: Run tests**

```bash
pnpm test -- ingest
```

Expected: PASS without code changes.

**Step 3: Run check**

```bash
pnpm check
```

Expected: green.

**Step 4: Commit**

```bash
git add src/records/ingest.test.ts
git commit
```

Message: `Test ingestRecord error paths`

---

## Task 12: Records public surface

**Files:** Create `src/records/index.ts`

**Step 1: Write the file**

```ts
export {
  FileNotFoundError,
  PathOutsideRootsError,
  RecordParseError,
  UnsupportedKindError,
} from './errors.js';
export { ingestRecord } from './ingest.js';
export type { IngestInput, IngestResult } from './ingest.js';
export { KindSchema, kindRegistry } from './kind-registry.js';
export type { Kind, KindHandler } from './kind-registry.js';
```

**Step 2: Run check**

```bash
pnpm check
```

Expected: green.

**Step 3: Commit**

```bash
git add src/records/index.ts
git commit
```

Message: `Add records module public surface`

---

## Task 13: Extract `bootstrap.ts`

**Files:** Create `src/bootstrap.ts`, modify `src/index.ts`

The MCP entry needs the same config + `BlobStore` construction the HTTP entry has. Pull it into a shared helper before adding the MCP entry.

**Step 1: Write `src/bootstrap.ts`**

```ts
import pino from 'pino';
import type { Logger } from 'pino';

import { loadConfig } from './config.js';
import type { BlobStore } from './storage/index.js';
import { createBlobStore } from './storage/index.js';

export interface Core {
  config: ReturnType<typeof loadConfig>;
  logger: Logger;
  store: BlobStore;
}

export interface BuildCoreOptions {
  logTo?: 'stdout' | 'stderr';
}

export function buildCore(options: BuildCoreOptions = {}): Core {
  const config = loadConfig();
  const destination = options.logTo === 'stderr' ? pino.destination(2) : undefined;
  const logger = destination
    ? pino({ level: config.LOG_LEVEL }, destination)
    : pino({ level: config.LOG_LEVEL });
  const store = createBlobStore(config.storage);
  return { config, logger, store };
}
```

**Step 2: Update `src/index.ts` to use `buildCore`**

```ts
import { serve } from '@hono/node-server';

import { buildCore } from './bootstrap.js';
import { createApp } from './http/app.js';

const { config, logger, store } = buildCore();
logger.info({ driver: config.storage.driver }, 'storage backend initialized');

const app = createApp();

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info(
    { port: info.port, storageDriver: config.storage.driver },
    'vitals service listening',
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});

void store;
```

**Step 3: Run `pnpm dev` smoke**

In another shell:

```bash
VITALS_STORAGE_URL=file:///tmp/vitals-bootstrap-smoke pnpm run dev
```

Then `curl http://localhost:3000/health` should return `{"status":"ok"}`. Stop the server.

**Step 4: Run check**

```bash
pnpm check
```

Expected: green.

**Step 5: Commit**

```bash
git add src/bootstrap.ts src/index.ts
git commit
```

Message: `Extract buildCore helper for shared config + storage construction`

---

## Task 14: MCP roots — happy path

**Files:** Create `src/mcp/roots.test.ts`, `src/mcp/roots.ts`

The roots state will eventually subscribe to MCP `notifications/roots/list_changed`. For now, design it so the path-validation logic is unit-testable with a manually-set list of roots; the SDK wiring lands in Task 17.

**Step 1: Write the failing test**

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RootsState } from './roots.js';

describe('RootsState', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vitals-roots-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('accepts a path inside an advertised root', async () => {
    const root = join(tmpDir, 'allowed');
    await mkdir(root);
    const filePath = join(root, 'file.xml');
    await writeFile(filePath, 'x', 'utf8');

    const state = new RootsState();
    await state.setRoots([`file://${root}`]);

    const real = await state.validatePath(filePath);
    expect(real).toBe(filePath);
  });
});
```

**Step 2: Run test — expected to fail**

```bash
pnpm test -- roots
```

Expected: FAIL.

**Step 3: Write `src/mcp/roots.ts`**

```ts
import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PathOutsideRootsError } from '../records/index.js';

export class RootsState {
  private rootRealPaths: ReadonlySet<string> = new Set();

  async setRoots(uris: readonly string[]): Promise<void> {
    const resolved = await Promise.all(uris.map(async (uri) => realpath(fileURLToPath(uri))));
    this.rootRealPaths = new Set(resolved);
  }

  async validatePath(absolutePath: string): Promise<string> {
    let real: string;
    try {
      real = await realpath(absolutePath);
    } catch {
      throw new PathOutsideRootsError(absolutePath);
    }
    for (const root of this.rootRealPaths) {
      if (real === root || real.startsWith(root + sep)) return real;
    }
    throw new PathOutsideRootsError(absolutePath);
  }
}
```

**Step 4: Run test**

```bash
pnpm test -- roots
```

Expected: PASS.

**Step 5: Run check**

```bash
pnpm check
```

Expected: green.

**Step 6: Commit**

```bash
git add src/mcp/roots.ts src/mcp/roots.test.ts
git commit
```

Message: `Add RootsState with path validation against advertised roots`

---

## Task 15: MCP roots — boundary and traversal cases

**Files:** Modify `src/mcp/roots.test.ts`

**Step 1: Add tests**

```ts
import { symlink } from 'node:fs/promises';

it('rejects a path outside any root', async () => {
  const root = join(tmpDir, 'allowed');
  const outside = join(tmpDir, 'other');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'leak.xml'), 'x', 'utf8');

  const state = new RootsState();
  await state.setRoots([`file://${root}`]);

  await expect(state.validatePath(join(outside, 'leak.xml'))).rejects.toThrow(
    /not inside any advertised root/,
  );
});

it('rejects a sibling path that shares a prefix but is not a child', async () => {
  // root /tmp/.../foo must not match /tmp/.../foobar
  const root = join(tmpDir, 'foo');
  const sibling = join(tmpDir, 'foobar');
  await mkdir(root);
  await mkdir(sibling);
  const sneaky = join(sibling, 'leak.xml');
  await writeFile(sneaky, 'x', 'utf8');

  const state = new RootsState();
  await state.setRoots([`file://${root}`]);

  await expect(state.validatePath(sneaky)).rejects.toThrow(/not inside any advertised root/);
});

it('rejects a symlink that escapes the root', async () => {
  const root = join(tmpDir, 'allowed');
  const outside = join(tmpDir, 'secret');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.xml'), 'x', 'utf8');
  // create a symlink inside root pointing outside
  const escapeLink = join(root, 'escape.xml');
  await symlink(join(outside, 'secret.xml'), escapeLink);

  const state = new RootsState();
  await state.setRoots([`file://${root}`]);

  await expect(state.validatePath(escapeLink)).rejects.toThrow(/not inside any advertised root/);
});

it('rejects when no roots have been advertised', async () => {
  const filePath = join(tmpDir, 'file.xml');
  await writeFile(filePath, 'x', 'utf8');
  const state = new RootsState();
  await expect(state.validatePath(filePath)).rejects.toThrow(/not inside any advertised root/);
});
```

**Step 2: Run tests**

```bash
pnpm test -- roots
```

Expected: PASS without code changes.

**Step 3: Run check**

```bash
pnpm check
```

Expected: green.

**Step 4: Commit**

```bash
git add src/mcp/roots.test.ts
git commit
```

Message: `Test RootsState boundary, traversal, and symlink-escape cases`

---

## Task 16: MCP server scaffolding (no tools yet)

**Files:** Create `src/mcp/server.ts`

The MCP TS SDK exports both a high-level `McpServer` (ergonomic for tool registration) and a low-level `Server` (full protocol access). We'll use `McpServer` for tools and reach through `mcpServer.server` for the `roots/list` request and the change-notification handler.

Reference: <https://github.com/modelcontextprotocol/typescript-sdk> README. If the API has shifted from this scaffold, adapt and document the divergence in a code comment.

**Step 1: Write `src/mcp/server.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListRootsRequestSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { buildCore } from '../bootstrap.js';
import { RootsState } from './roots.js';

export async function startMcpServer(): Promise<void> {
  const { logger } = buildCore({ logTo: 'stderr' });

  const mcp = new McpServer({ name: 'vitals', version: '0.0.0' });
  const roots = new RootsState();

  mcp.server.oninitialized = () => {
    void refreshRoots();
  };
  mcp.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    await refreshRoots();
  });

  async function refreshRoots(): Promise<void> {
    try {
      const result = await mcp.server.request({ method: 'roots/list' }, ListRootsRequestSchema);
      await roots.setRoots(result.roots.map((r) => r.uri));
      logger.info({ count: result.roots.length }, 'roots refreshed');
    } catch (err) {
      logger.warn({ err }, 'failed to refresh roots');
    }
  }

  await mcp.connect(new StdioServerTransport());
  logger.info('mcp server connected over stdio');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
```

> **Note on SDK shape:** if `ListRootsRequestSchema` is the wrong export name in the installed SDK version, search the `@modelcontextprotocol/sdk` types for "Roots" and adapt. The shape of `roots/list`'s response is `{ roots: { uri: string; name?: string }[] }`.

**Step 2: Boot smoke**

```bash
pnpm exec tsx src/mcp/server.ts < /dev/null
```

Expected: process starts, writes a single startup log line to stderr, then waits on stdin. Kill it with Ctrl-C. (It will exit with non-zero on EOF — that's fine; we just want to confirm it boots without throwing during construction.)

If `loadConfig()` complains about `VITALS_STORAGE_URL`, set one for the smoke:

```bash
VITALS_STORAGE_URL=file:///tmp/vitals-mcp-smoke pnpm exec tsx src/mcp/server.ts < /dev/null
```

**Step 3: Run check**

```bash
pnpm check
```

Expected: green.

**Step 4: Commit**

```bash
git add src/mcp/server.ts
git commit
```

Message: `Add MCP server scaffolding with stdio transport and roots wiring`

---

## Task 17: Register `ingest_record` tool

**Files:** Modify `src/mcp/server.ts`

**Step 1: Add the tool registration inside `startMcpServer`**, after the `RootsState` is constructed and the notification handler is set, but before `mcp.connect`:

```ts
import { z } from 'zod';

import {
  FileNotFoundError,
  PathOutsideRootsError,
  RecordParseError,
  UnsupportedKindError,
  ingestRecord,
  KindSchema,
} from '../records/index.js';

const InputSchema = z.object({
  path: z.string().min(1),
  kind: KindSchema,
  source: z.string().min(1),
  original_filename: z.string().min(1).optional(),
});

mcp.tool(
  'ingest_record',
  'Ingest a health-data record into the vitals archive. The path must be inside a directory advertised by the client as a root. Supported kinds: ccda.',
  InputSchema.shape,
  async (input) => {
    try {
      const result = await ingestRecord(store, (p) => roots.validatePath(p), input);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const code = mapError(err);
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code, message }) }],
      };
    }
  },
);

function mapError(err: unknown): string {
  if (err instanceof PathOutsideRootsError) return 'path_outside_roots';
  if (err instanceof FileNotFoundError) return 'file_not_found';
  if (err instanceof UnsupportedKindError) return 'unsupported_kind';
  if (err instanceof RecordParseError) return 'parse_failed';
  return 'internal_error';
}
```

(`store` comes from the existing `buildCore` destructure — add `store` to the destructured names if it isn't already.)

**Step 2: Run check**

```bash
pnpm check
```

Expected: green.

**Step 3: Commit**

```bash
git add src/mcp/server.ts
git commit
```

Message: `Register ingest_record MCP tool with structured error mapping`

---

## Task 18: End-to-end MCP test (in-memory transport)

**Files:** Create `src/mcp/server.test.ts`

The MCP SDK ships an in-memory transport pair (typically `InMemoryTransport` or paired client/server transports built from `EventEmitter`s). Use it to wire a `Client` to the server in-process, advertise a roots list from the client, and exercise `ingest_record` end-to-end.

Reference: <https://github.com/modelcontextprotocol/typescript-sdk> tests directory for the canonical pattern.

**Step 1: Write the test**

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  FileNotFoundError,
  PathOutsideRootsError,
  RecordParseError,
  UnsupportedKindError,
  ingestRecord,
  KindSchema,
} from '../records/index.js';
import { MemoryBlobStore } from '../storage/index.js';
import { RootsState } from './roots.js';

const fixture = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20201015143211-0500"/>
</ClinicalDocument>`;

async function buildHarness(rootsToAdvertise: readonly string[]) {
  const store = new MemoryBlobStore();
  const mcp = new McpServer({ name: 'vitals', version: 'test' });
  const roots = new RootsState();

  mcp.server.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: rootsToAdvertise.map((uri) => ({ uri })),
  }));

  // ... register ingest_record (extracted helper or inline copy of Task 17)
  const InputSchema = z.object({
    path: z.string().min(1),
    kind: KindSchema,
    source: z.string().min(1),
    original_filename: z.string().min(1).optional(),
  });

  mcp.tool('ingest_record', 'test', InputSchema.shape, async (input) => {
    try {
      const result = await ingestRecord(store, (p) => roots.validatePath(p), input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      const code =
        err instanceof PathOutsideRootsError
          ? 'path_outside_roots'
          : err instanceof FileNotFoundError
            ? 'file_not_found'
            : err instanceof UnsupportedKindError
              ? 'unsupported_kind'
              : err instanceof RecordParseError
                ? 'parse_failed'
                : 'internal_error';
      return {
        isError: true,
        content: [
          { type: 'text', text: JSON.stringify({ code, message: (err as Error).message }) },
        ],
      };
    }
  });

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'test-client', version: 'test' },
    { capabilities: { roots: { listChanged: true } } },
  );

  await Promise.all([mcp.connect(serverT), client.connect(clientT)]);

  // Make the client respond to roots/list with our advertised list.
  // Some SDK versions expose this via client.setRequestHandler on the client side; if not,
  // hard-set the list via roots.setRoots and skip the round-trip in tests.
  await roots.setRoots(rootsToAdvertise);

  return { client, store, dispose: async () => Promise.all([client.close(), mcp.close()]) };
}

describe('MCP ingest_record', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vitals-mcp-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a record and returns a structured key', async () => {
    const root = join(tmpDir, 'allowed');
    await mkdir(root);
    const filePath = join(root, 'visit.xml');
    await writeFile(filePath, fixture, 'utf8');

    const { client, store, dispose } = await buildHarness([`file://${root}`]);
    try {
      const res = await client.callTool({
        name: 'ingest_record',
        arguments: { path: filePath, kind: 'ccda', source: 'portal-export' },
      });
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      const result = JSON.parse(text) as { key: string; observation_date: string };
      expect(result.key).toMatch(/^ccda\/2020\/10\/15\/[0-9a-f]{12}\.xml$/);
      expect(result.observation_date).toBe('2020-10-15');
      expect(await store.head(result.key)).not.toBeNull();
    } finally {
      await dispose();
    }
  });

  it('returns path_outside_roots when path is not inside an advertised root', async () => {
    const filePath = join(tmpDir, 'leak.xml');
    await writeFile(filePath, fixture, 'utf8');

    const otherRoot = join(tmpDir, 'allowed');
    await mkdir(otherRoot);

    const { client, dispose } = await buildHarness([`file://${otherRoot}`]);
    try {
      const res = await client.callTool({
        name: 'ingest_record',
        arguments: { path: filePath, kind: 'ccda', source: 'x' },
      });
      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(JSON.parse(text)).toMatchObject({ code: 'path_outside_roots' });
    } finally {
      await dispose();
    }
  });

  it('returns parse_failed when the bytes are not a valid CCDA', async () => {
    const root = join(tmpDir, 'allowed');
    await mkdir(root);
    const filePath = join(root, 'bogus.xml');
    await writeFile(filePath, '<NotCCDA/>', 'utf8');

    const { client, dispose } = await buildHarness([`file://${root}`]);
    try {
      const res = await client.callTool({
        name: 'ingest_record',
        arguments: { path: filePath, kind: 'ccda', source: 'x' },
      });
      expect(res.isError).toBe(true);
      const text = (res.content[0] as { type: 'text'; text: string }).text;
      expect(JSON.parse(text)).toMatchObject({ code: 'parse_failed' });
    } finally {
      await dispose();
    }
  });
});
```

> **SDK API caveats:** the exact import paths (`@modelcontextprotocol/sdk/inMemory.js` vs `.../shared/inMemory.js` etc.) depend on the installed version. If imports fail, run `pnpm exec node -e "console.log(require.resolve('@modelcontextprotocol/sdk'))"` and inspect the package's `dist/` to find the right paths. Note any divergence from this scaffold in commit message body so future readers know.

**Step 2: Run tests**

```bash
pnpm test -- mcp/server
```

Expected: PASS. If they don't, the most likely issues are SDK API drift (import names) or how tool error responses are returned (some versions wrap errors differently). Adapt the test, not the source — the tool handler shape from Task 17 is what we want to validate.

**Step 3: Run check**

```bash
pnpm check
```

Expected: green.

**Step 4: Commit**

```bash
git add src/mcp/server.test.ts
git commit
```

Message: `Test MCP ingest_record end-to-end with in-memory transport`

---

## Task 19: Refactor server.ts to share tool registration with the test

**Files:** Modify `src/mcp/server.ts`

The duplication between Task 17's production wiring and Task 18's test harness is real. Extract the tool registration into a small helper that both call.

**Step 1: Extract `registerIngestRecordTool`**

```ts
// new exported helper in src/mcp/server.ts
export function registerIngestRecordTool(
  mcp: McpServer,
  store: BlobStore,
  roots: RootsState,
): void {
  // moves the body from Task 17's `mcp.tool(...)` call into here
}
```

**Step 2: Update `startMcpServer` and `src/mcp/server.test.ts`** to call `registerIngestRecordTool` instead of inlining it.

**Step 3: Run tests + check**

```bash
pnpm test -- mcp
pnpm check
```

Expected: green.

**Step 4: Commit**

```bash
git add src/mcp/server.ts src/mcp/server.test.ts
git commit
```

Message: `Extract registerIngestRecordTool helper to share with tests`

---

## Task 20: Add `start:mcp` and `dev:mcp` scripts

**Files:** Modify `package.json`

**Step 1: Add scripts**

In the `"scripts"` block, add:

```json
"dev:mcp": "tsx src/mcp/server.ts",
"start:mcp": "node dist/mcp/server.js"
```

**Step 2: Smoke**

```bash
VITALS_STORAGE_URL=file:///tmp/vitals-smoke pnpm run dev:mcp < /dev/null
```

Expected: stderr shows the startup log lines; process waits on stdin (kill with Ctrl-C). No errors on stderr.

**Step 3: Build + start smoke**

```bash
pnpm run build
VITALS_STORAGE_URL=file:///tmp/vitals-smoke pnpm run start:mcp < /dev/null
```

Same expectation.

**Step 4: Run check**

```bash
pnpm check
```

Expected: green.

**Step 5: Commit**

```bash
git add package.json
git commit
```

Message: `Add dev:mcp and start:mcp scripts`

---

## Task 21: Final acceptance + README note

**Files:** Modify `README.md`

**Step 1: Update README.md scripts table** to include `dev:mcp` and `start:mcp` rows. Add a brief paragraph under "Status" noting that ingestion is reachable via MCP now, with a sample of how to wire the server into Claude Desktop / Claude Code (path to `dist/mcp/server.js`, env var `VITALS_STORAGE_URL`).

**Step 2: Final acceptance run**

```bash
pnpm check
```

Expected: green across format, lint, typecheck, forbid-junk-object-types, and tests. Total tests should be ~20+ passing (existing storage tests + new records + roots + mcp).

**Step 3: Commit**

```bash
git add README.md
git commit
```

Message: `Document MCP entry point in README`

---

## Done

After Task 21, the worktree contains the full ingestion path: storage layer untouched, records layer with CCDA support, MCP server with `ingest_record` tool, roots-based path validation, idempotent date-partitioned keys.

Use **superpowers:finishing-a-development-branch** to decide between merging the worktree to `main` or opening a PR.
