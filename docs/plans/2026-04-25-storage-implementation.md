# Storage Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use superpowers:test-driven-development for any task that has tests.

**Goal:** Build the pluggable `BlobStore` abstraction with three adapters (in-memory, local-fs, S3), provenance sidecar helpers, URL-shaped config, and boot wiring — exactly as specified in `docs/plans/2026-04-25-storage-design.md`.

**Architecture:** Five-method `BlobStore` interface (`put`/`get`/`head`/`list`/`delete`) implemented by three adapters. Single shared contract test runs against each adapter. Operator selects driver via `VITALS_STORAGE_URL` env var parsed into a discriminated `StorageConfig`. Boot constructs a `BlobStore` and injects it; nothing reaches into env at use sites.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import suffix), Vitest, Zod, `@aws-sdk/client-s3`, `node:fs/promises`, `node:crypto`.

**Working directory:** This plan executes inside the worktree at `.claude/worktrees/feat-storage/` on branch `worktree-feat-storage`. All file paths below are relative to the worktree root.

**Verification:** After each task, run `pnpm check` (format + lint + typecheck + test). Don't commit until it's green.

**Commit style:** Match recent history (`Add ...`, `Scaffold ...`). One commit per task. Co-author trailer per the project default.

---

## Task 1: Add `@aws-sdk/client-s3` dependency

**Files:**

- Modify: `package.json`, `pnpm-lock.yaml`

**Step 1: Install**

```bash
pnpm add @aws-sdk/client-s3
```

**Step 2: Verify install**

```bash
pnpm list @aws-sdk/client-s3
```

Expected: shows version 3.x.

**Step 3: Run check**

```bash
pnpm check
```

Expected: green.

**Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit
```

Message: `Add @aws-sdk/client-s3 dependency for S3 storage adapter`

---

## Task 2: Define `BlobStore` interface and key validator

**Files:**

- Create: `src/storage/blob-store.ts`

No test — pure types + a tiny validator. The validator is exercised by every adapter's contract test in later tasks.

**Step 1: Write `src/storage/blob-store.ts`**

```ts
export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  head(key: string): Promise<BlobMeta | null>;
  list(prefix: string): AsyncIterable<BlobEntry>;
  delete(key: string): Promise<void>;
}

export type BlobMeta = {
  size: number;
  lastModified: Date;
  contentType?: string;
};

export type BlobEntry = {
  key: string;
  size: number;
  lastModified: Date;
};

export function assertValidKey(key: string): void {
  if (key.length === 0) {
    throw new Error('blob key must not be empty');
  }
  if (key.startsWith('/')) {
    throw new Error(`blob key must not start with /: ${key}`);
  }
  if (key.split('/').includes('..')) {
    throw new Error(`blob key must not contain ..: ${key}`);
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
git add src/storage/blob-store.ts
git commit
```

Message: `Add BlobStore interface and key validator`

---

## Task 3: Write the shared contract test runner

**Files:**

- Create: `src/storage/blob-store.contract.ts`

The runner exports a function used by per-adapter test files. The runner itself is not a `*.test.ts` and isn't picked up by vitest directly. Each adapter will get its own `*.test.ts` that calls into this runner — those tests are added in later tasks.

**Step 1: Write `src/storage/blob-store.contract.ts`**

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import type { BlobEntry, BlobStore } from './blob-store.js';

export function runBlobStoreContract(
  name: string,
  factory: () => Promise<BlobStore> | BlobStore,
): void {
  describe(`BlobStore contract: ${name}`, () => {
    let store: BlobStore;

    beforeEach(async () => {
      store = await factory();
    });

    it('round-trips bytes via put + get', async () => {
      const bytes = new TextEncoder().encode('hello');
      await store.put('a/b.txt', bytes, 'text/plain');
      const got = await store.get('a/b.txt');
      expect(new TextDecoder().decode(got)).toBe('hello');
    });

    it('preserves binary payloads exactly', async () => {
      const bytes = new Uint8Array([0, 1, 2, 254, 255]);
      await store.put('bin/payload', bytes);
      const got = await store.get('bin/payload');
      expect(Array.from(got)).toEqual(Array.from(bytes));
    });

    it('head returns size and lastModified for an existing key', async () => {
      await store.put('m/x.txt', new TextEncoder().encode('xyz'));
      const meta = await store.head('m/x.txt');
      expect(meta).not.toBeNull();
      expect(meta?.size).toBe(3);
      expect(meta?.lastModified).toBeInstanceOf(Date);
    });

    it('head returns null for a missing key', async () => {
      const meta = await store.head('does/not/exist');
      expect(meta).toBeNull();
    });

    it('list returns all entries under a prefix', async () => {
      await store.put('p/one.txt', new TextEncoder().encode('1'));
      await store.put('p/two.txt', new TextEncoder().encode('22'));
      await store.put('q/three.txt', new TextEncoder().encode('333'));
      const collected: BlobEntry[] = [];
      for await (const entry of store.list('p/')) {
        collected.push(entry);
      }
      const keys = collected.map((e) => e.key).sort();
      expect(keys).toEqual(['p/one.txt', 'p/two.txt']);
      const sizesByKey = new Map(collected.map((e) => [e.key, e.size]));
      expect(sizesByKey.get('p/one.txt')).toBe(1);
      expect(sizesByKey.get('p/two.txt')).toBe(2);
    });

    it('list returns empty for a prefix with no matches', async () => {
      await store.put('x/file.txt', new TextEncoder().encode('x'));
      const collected: BlobEntry[] = [];
      for await (const entry of store.list('z/')) {
        collected.push(entry);
      }
      expect(collected).toEqual([]);
    });

    it('delete removes only the named key', async () => {
      await store.put('d/a.txt', new TextEncoder().encode('a'));
      await store.put('d/b.txt', new TextEncoder().encode('b'));
      await store.delete('d/a.txt');
      expect(await store.head('d/a.txt')).toBeNull();
      expect(await store.head('d/b.txt')).not.toBeNull();
    });

    it('delete on a missing key does not throw', async () => {
      await expect(store.delete('nope/missing.txt')).resolves.toBeUndefined();
    });

    it('rejects keys containing ..', async () => {
      await expect(store.put('../escape.txt', new TextEncoder().encode('x'))).rejects.toThrow();
    });

    it('rejects keys with leading /', async () => {
      await expect(store.put('/abs.txt', new TextEncoder().encode('x'))).rejects.toThrow();
    });
  });
}
```

**Step 2: Run check**

```bash
pnpm check
```

Expected: green (file compiles; no `*.test.ts` yet, no tests run from this file).

**Step 3: Commit**

```bash
git add src/storage/blob-store.contract.ts
git commit
```

Message: `Add shared BlobStore contract test runner`

---

## Task 4: Implement `MemoryBlobStore` (TDD against the contract)

**Files:**

- Create: `src/storage/memory.ts`
- Create: `src/storage/memory.test.ts`

**Step 1: Write the failing test**

`src/storage/memory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { runBlobStoreContract } from './blob-store.contract.js';
import { MemoryBlobStore } from './memory.js';

runBlobStoreContract('MemoryBlobStore', () => new MemoryBlobStore());

describe('MemoryBlobStore specifics', () => {
  it('preserves contentType across put and head', async () => {
    const store = new MemoryBlobStore();
    await store.put('a.json', new TextEncoder().encode('{}'), 'application/json');
    const meta = await store.head('a.json');
    expect(meta?.contentType).toBe('application/json');
  });

  it('isolates put bytes from later mutation by the caller', async () => {
    const store = new MemoryBlobStore();
    const bytes = new Uint8Array([1, 2, 3]);
    await store.put('iso', bytes);
    bytes[0] = 99;
    const got = await store.get('iso');
    expect(Array.from(got)).toEqual([1, 2, 3]);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test src/storage/memory.test.ts
```

Expected: fails to import / module not found for `./memory.js`.

**Step 3: Write `src/storage/memory.ts`**

```ts
import type { BlobEntry, BlobMeta, BlobStore } from './blob-store.js';
import { assertValidKey } from './blob-store.js';

type Stored = {
  bytes: Uint8Array;
  contentType?: string;
  lastModified: Date;
};

export class MemoryBlobStore implements BlobStore {
  private readonly objects = new Map<string, Stored>();

  put(key: string, bytes: Uint8Array, contentType?: string): Promise<void> {
    assertValidKey(key);
    this.objects.set(key, {
      bytes: new Uint8Array(bytes),
      contentType,
      lastModified: new Date(),
    });
    return Promise.resolve();
  }

  get(key: string): Promise<Uint8Array> {
    const stored = this.objects.get(key);
    if (!stored) {
      return Promise.reject(new Error(`blob not found: ${key}`));
    }
    return Promise.resolve(new Uint8Array(stored.bytes));
  }

  head(key: string): Promise<BlobMeta | null> {
    const stored = this.objects.get(key);
    if (!stored) return Promise.resolve(null);
    return Promise.resolve({
      size: stored.bytes.byteLength,
      lastModified: stored.lastModified,
      contentType: stored.contentType,
    });
  }

  async *list(prefix: string): AsyncIterable<BlobEntry> {
    for (const [key, stored] of this.objects) {
      if (key.startsWith(prefix)) {
        yield {
          key,
          size: stored.bytes.byteLength,
          lastModified: stored.lastModified,
        };
      }
    }
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}
```

**Step 4: Run check**

```bash
pnpm check
```

Expected: green. All contract tests + memory specifics pass.

**Step 5: Commit**

```bash
git add src/storage/memory.ts src/storage/memory.test.ts
git commit
```

Message: `Add MemoryBlobStore implementation and tests`

---

## Task 5: Implement `LocalFsBlobStore` (TDD against contract + fs specifics)

**Files:**

- Create: `src/storage/local-fs.ts`
- Create: `src/storage/local-fs.test.ts`

**Step 1: Write the failing test**

`src/storage/local-fs.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runBlobStoreContract } from './blob-store.contract.js';
import { LocalFsBlobStore } from './local-fs.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vitals-fs-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

runBlobStoreContract('LocalFsBlobStore', () => new LocalFsBlobStore(root));

describe('LocalFsBlobStore specifics', () => {
  it('rejects a non-absolute root in the constructor', () => {
    expect(() => new LocalFsBlobStore('relative/path')).toThrow(/absolute/);
  });

  it('auto-creates parent directories on put', async () => {
    const store = new LocalFsBlobStore(root);
    await store.put('deep/nested/path/file.txt', new TextEncoder().encode('x'));
    const meta = await store.head('deep/nested/path/file.txt');
    expect(meta?.size).toBe(1);
  });

  it('list returns no entries when the root is empty', async () => {
    const store = new LocalFsBlobStore(root);
    const collected: string[] = [];
    for await (const entry of store.list('')) {
      collected.push(entry.key);
    }
    expect(collected).toEqual([]);
  });
});
```

**Step 2: Run to verify it fails**

```bash
pnpm test src/storage/local-fs.test.ts
```

Expected: import failure for `./local-fs.js`.

**Step 3: Write `src/storage/local-fs.ts`**

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { BlobEntry, BlobMeta, BlobStore } from './blob-store.js';
import { assertValidKey } from './blob-store.js';

export class LocalFsBlobStore implements BlobStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) {
      throw new Error(`LocalFsBlobStore root must be absolute: ${root}`);
    }
  }

  async put(key: string, bytes: Uint8Array, _contentType?: string): Promise<void> {
    assertValidKey(key);
    const filePath = this.resolve(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    assertValidKey(key);
    const data = await fs.readFile(this.resolve(key));
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  async head(key: string): Promise<BlobMeta | null> {
    assertValidKey(key);
    try {
      const stat = await fs.stat(this.resolve(key));
      return { size: stat.size, lastModified: stat.mtime };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async *list(prefix: string): AsyncIterable<BlobEntry> {
    for await (const entry of walk(this.root, this.root)) {
      if (prefix === '' || entry.key.startsWith(prefix)) {
        yield entry;
      }
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    try {
      await fs.unlink(this.resolve(key));
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  }

  private resolve(key: string): string {
    const full = path.normalize(path.join(this.root, key));
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (!full.startsWith(rootWithSep) && full !== this.root) {
      throw new Error(`blob key escapes root: ${key}`);
    }
    return full;
  }
}

async function* walk(root: string, dir: string): AsyncIterable<BlobEntry> {
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(root, full);
    } else if (entry.isFile()) {
      const stat = await fs.stat(full);
      const key = path.relative(root, full).split(path.sep).join('/');
      yield { key, size: stat.size, lastModified: stat.mtime };
    }
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'ENOENT'
  );
}
```

**Note:** the `_contentType` parameter is intentionally unused — local-fs does not persist content-type, the HTTP layer derives it from the key extension at serve time. The leading underscore satisfies `@typescript-eslint/no-unused-vars`. If the lint rule is configured to forbid even underscore-prefixed unused args, drop the parameter (omit the rest argument from the signature instead — it's still type-compatible with the interface since `contentType` is optional).

**Step 4: Run check**

```bash
pnpm check
```

Expected: green.

**Step 5: Commit**

```bash
git add src/storage/local-fs.ts src/storage/local-fs.test.ts
git commit
```

Message: `Add LocalFsBlobStore implementation and tests`

---

## Task 6: Implement provenance schema and helpers

**Files:**

- Create: `src/storage/provenance.ts`
- Create: `src/storage/provenance.test.ts`

**Step 1: Write the failing test**

`src/storage/provenance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { MemoryBlobStore } from './memory.js';
import {
  ProvenanceSchema,
  hashBytes,
  provenanceKey,
  readProvenance,
  writeProvenance,
  type Provenance,
} from './provenance.js';

describe('provenanceKey', () => {
  it('appends .provenance.json to the blob key', () => {
    expect(provenanceKey('ccda/2020-10-15-encounter.xml')).toBe(
      'ccda/2020-10-15-encounter.xml.provenance.json',
    );
  });
});

describe('hashBytes', () => {
  it('returns sha256: prefix + 64 hex chars', () => {
    const result = hashBytes(new TextEncoder().encode('hello'));
    expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces a stable digest for the same bytes', () => {
    const bytes = new TextEncoder().encode('hello');
    expect(hashBytes(bytes)).toBe(hashBytes(bytes));
  });
});

describe('ProvenanceSchema', () => {
  const validHash = `sha256:${'a'.repeat(64)}`;

  it('rejects content_hash without sha256: prefix', () => {
    expect(() =>
      ProvenanceSchema.parse({
        source: 'a',
        ingested_at: '2026-04-25T00:00:00Z',
        original_filename: 'x.xml',
        content_hash: 'abc123',
      }),
    ).toThrow();
  });

  it('rejects empty source', () => {
    expect(() =>
      ProvenanceSchema.parse({
        source: '',
        ingested_at: '2026-04-25T00:00:00Z',
        original_filename: 'x.xml',
        content_hash: validHash,
      }),
    ).toThrow();
  });
});

describe('readProvenance / writeProvenance', () => {
  const sample: Provenance = {
    source: 'portal-export',
    ingested_at: '2026-04-25T14:32:11Z',
    original_filename: 'visit.xml',
    content_hash: `sha256:${'a'.repeat(64)}`,
  };

  it('round-trips a Provenance via the BlobStore', async () => {
    const store = new MemoryBlobStore();
    await writeProvenance(store, 'ccda/visit.xml', sample);
    const got = await readProvenance(store, 'ccda/visit.xml');
    expect(got).toEqual(sample);
  });

  it('returns null when the sidecar does not exist', async () => {
    const store = new MemoryBlobStore();
    expect(await readProvenance(store, 'ccda/missing.xml')).toBeNull();
  });
});
```

**Step 2: Run to verify it fails**

```bash
pnpm test src/storage/provenance.test.ts
```

Expected: import failure for `./provenance.js`.

**Step 3: Write `src/storage/provenance.ts`**

```ts
import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { BlobStore } from './blob-store.js';

export const ProvenanceSchema = z.object({
  source: z.string().min(1),
  ingested_at: z.string().min(1),
  original_filename: z.string().min(1),
  content_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export type Provenance = z.infer<typeof ProvenanceSchema>;

export function provenanceKey(blobKey: string): string {
  return `${blobKey}.provenance.json`;
}

export function hashBytes(bytes: Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(bytes);
  return `sha256:${hash.digest('hex')}`;
}

export async function readProvenance(
  store: BlobStore,
  blobKey: string,
): Promise<Provenance | null> {
  const key = provenanceKey(blobKey);
  const meta = await store.head(key);
  if (!meta) return null;
  const bytes = await store.get(key);
  const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return ProvenanceSchema.parse(json);
}

export async function writeProvenance(
  store: BlobStore,
  blobKey: string,
  provenance: Provenance,
): Promise<void> {
  const validated = ProvenanceSchema.parse(provenance);
  const bytes = new TextEncoder().encode(`${JSON.stringify(validated, null, 2)}\n`);
  await store.put(provenanceKey(blobKey), bytes, 'application/json');
}
```

**Step 4: Run check**

```bash
pnpm check
```

Expected: green.

**Step 5: Commit**

```bash
git add src/storage/provenance.ts src/storage/provenance.test.ts
git commit
```

Message: `Add provenance sidecar schema and helpers`

---

## Task 7: Implement URL parser

**Files:**

- Create: `src/storage/url.ts`
- Create: `src/storage/url.test.ts`

**Step 1: Write the failing test**

`src/storage/url.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { parseStorageUrl } from './url.js';

describe('parseStorageUrl', () => {
  it('parses a file:// URL with an absolute path', () => {
    expect(parseStorageUrl('file:///var/vitals')).toEqual({
      driver: 'local',
      root: '/var/vitals',
    });
  });

  it('parses an s3:// URL with required region', () => {
    expect(parseStorageUrl('s3://my-bucket?region=us-east-1')).toEqual({
      driver: 's3',
      bucket: 'my-bucket',
      region: 'us-east-1',
    });
  });

  it('parses an s3:// URL with optional endpoint', () => {
    expect(
      parseStorageUrl('s3://my-bucket?region=auto&endpoint=https://abc.r2.cloudflarestorage.com'),
    ).toEqual({
      driver: 's3',
      bucket: 'my-bucket',
      region: 'auto',
      endpoint: 'https://abc.r2.cloudflarestorage.com',
    });
  });

  it('rejects malformed URLs', () => {
    expect(() => parseStorageUrl('not a url')).toThrow();
  });

  it('rejects unsupported protocols', () => {
    expect(() => parseStorageUrl('ftp://server/path')).toThrow(/file:\/\/ or s3:\/\//);
  });

  it('rejects an s3:// URL without region', () => {
    expect(() => parseStorageUrl('s3://my-bucket')).toThrow(/region/);
  });

  it('rejects an s3:// URL without bucket', () => {
    expect(() => parseStorageUrl('s3://?region=us-east-1')).toThrow(/bucket/);
  });
});
```

**Step 2: Run to verify it fails**

```bash
pnpm test src/storage/url.test.ts
```

Expected: import failure for `./url.js`.

**Step 3: Write `src/storage/url.ts`**

```ts
import * as path from 'node:path';

export type StorageConfig =
  | { driver: 'local'; root: string }
  | { driver: 's3'; bucket: string; region: string; endpoint?: string };

export function parseStorageUrl(input: string): StorageConfig {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`VITALS_STORAGE_URL is not a valid URL: ${input}`);
  }

  if (url.protocol === 'file:') {
    const root = url.pathname;
    if (!path.isAbsolute(root)) {
      throw new Error(`VITALS_STORAGE_URL file:// path must be absolute: ${input}`);
    }
    return { driver: 'local', root };
  }

  if (url.protocol === 's3:') {
    const bucket = url.hostname;
    if (bucket === '') {
      throw new Error(`VITALS_STORAGE_URL s3:// requires a bucket: ${input}`);
    }
    const region = url.searchParams.get('region');
    if (region === null || region === '') {
      throw new Error(`VITALS_STORAGE_URL s3:// requires ?region=...: ${input}`);
    }
    const endpointParam = url.searchParams.get('endpoint');
    const endpoint = endpointParam === null || endpointParam === '' ? undefined : endpointParam;
    return endpoint === undefined
      ? { driver: 's3', bucket, region }
      : { driver: 's3', bucket, region, endpoint };
  }

  throw new Error(`VITALS_STORAGE_URL must use file:// or s3://, got: ${url.protocol} (${input})`);
}
```

**Step 4: Run check**

```bash
pnpm check
```

Expected: green.

**Step 5: Commit**

```bash
git add src/storage/url.ts src/storage/url.test.ts
git commit
```

Message: `Add VITALS_STORAGE_URL parser`

---

## Task 8: Implement `S3BlobStore` (no CI test, opt-in)

**Files:**

- Create: `src/storage/s3.ts`
- Create: `src/storage/s3.test.ts`

The test file exists but the contract suite only runs when `VITALS_TEST_S3_BUCKET` is set. CI does not set it; the file produces 0 tests in CI and passes trivially.

**Step 1: Write the (mostly skipped) test**

`src/storage/s3.test.ts`:

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { describe, it } from 'vitest';

import { runBlobStoreContract } from './blob-store.contract.js';
import { S3BlobStore } from './s3.js';

const bucket = process.env.VITALS_TEST_S3_BUCKET;
const region = process.env.VITALS_TEST_S3_REGION ?? 'us-east-1';

if (bucket !== undefined && bucket !== '') {
  const client = new S3Client({ region });
  runBlobStoreContract('S3BlobStore', () => new S3BlobStore(client, bucket));
} else {
  describe('S3BlobStore', () => {
    it.skip('skipped: set VITALS_TEST_S3_BUCKET to run', () => {
      // intentionally empty
    });
  });
}
```

**Step 2: Run to verify it fails (or skips cleanly)**

```bash
pnpm test src/storage/s3.test.ts
```

Expected: import failure for `./s3.js`.

**Step 3: Write `src/storage/s3.ts`**

```ts
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

import type { BlobEntry, BlobMeta, BlobStore } from './blob-store.js';
import { assertValidKey } from './blob-store.js';

export class S3BlobStore implements BlobStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, bytes: Uint8Array, contentType?: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    assertValidKey(key);
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) {
      throw new Error(`S3 returned empty body for ${key}`);
    }
    return await result.Body.transformToByteArray();
  }

  async head(key: string): Promise<BlobMeta | null> {
    assertValidKey(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: result.ContentLength ?? 0,
        lastModified: result.LastModified ?? new Date(0),
        contentType: result.ContentType,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async *list(prefix: string): AsyncIterable<BlobEntry> {
    let token: string | undefined;
    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of result.Contents ?? []) {
        if (obj.Key === undefined) continue;
        yield {
          key: obj.Key,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified ?? new Date(0),
        };
      }
      token = result.NextContinuationToken;
    } while (token !== undefined && token !== '');
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ('name' in err && (err as { name: string }).name === 'NotFound') return true;
  if ('$metadata' in err) {
    const md = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
    return md?.httpStatusCode === 404;
  }
  return false;
}
```

**Step 4: Run check**

```bash
pnpm check
```

Expected: green. The S3 test skips in CI absent `VITALS_TEST_S3_BUCKET`.

**Step 5: Commit**

```bash
git add src/storage/s3.ts src/storage/s3.test.ts
git commit
```

Message: `Add S3BlobStore implementation with opt-in contract test`

---

## Task 9: Implement factory and public surface

**Files:**

- Create: `src/storage/factory.ts`
- Create: `src/storage/index.ts`

No tests — factory is a 4-line dispatcher; `index.ts` only re-exports.

**Step 1: Write `src/storage/factory.ts`**

```ts
import { S3Client } from '@aws-sdk/client-s3';

import type { BlobStore } from './blob-store.js';
import { LocalFsBlobStore } from './local-fs.js';
import { S3BlobStore } from './s3.js';
import type { StorageConfig } from './url.js';

export function createBlobStore(config: StorageConfig): BlobStore {
  if (config.driver === 'local') {
    return new LocalFsBlobStore(config.root);
  }
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
  });
  return new S3BlobStore(client, config.bucket);
}
```

**Step 2: Write `src/storage/index.ts`**

```ts
export type { BlobEntry, BlobMeta, BlobStore } from './blob-store.js';
export { assertValidKey } from './blob-store.js';
export { createBlobStore } from './factory.js';
export { MemoryBlobStore } from './memory.js';
export type { Provenance } from './provenance.js';
export {
  ProvenanceSchema,
  hashBytes,
  provenanceKey,
  readProvenance,
  writeProvenance,
} from './provenance.js';
export type { StorageConfig } from './url.js';
export { parseStorageUrl } from './url.js';
```

**Step 3: Run check**

```bash
pnpm check
```

Expected: green.

**Step 4: Commit**

```bash
git add src/storage/factory.ts src/storage/index.ts
git commit
```

Message: `Add storage factory and public surface`

---

## Task 10: Extend `src/config.ts` to parse `VITALS_STORAGE_URL`

**Files:**

- Modify: `src/config.ts`
- Create: `src/config.test.ts`

**Step 1: Write the failing test**

`src/config.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('loadConfig', () => {
  it('parses a file:// storage URL into a local StorageConfig', () => {
    process.env.VITALS_STORAGE_URL = 'file:///var/vitals';
    const config = loadConfig();
    expect(config.storage).toEqual({ driver: 'local', root: '/var/vitals' });
  });

  it('parses an s3:// storage URL into an s3 StorageConfig', () => {
    process.env.VITALS_STORAGE_URL = 's3://bucket-x?region=us-west-2';
    const config = loadConfig();
    expect(config.storage).toEqual({
      driver: 's3',
      bucket: 'bucket-x',
      region: 'us-west-2',
    });
  });

  it('exits on missing VITALS_STORAGE_URL', () => {
    delete process.env.VITALS_STORAGE_URL;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadConfig()).toThrow(/exit 1/);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
```

Add `vi` to the import:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
```

**Step 2: Run to verify it fails**

```bash
pnpm test src/config.test.ts
```

Expected: existing `loadConfig` returns `{ PORT, NODE_ENV, LOG_LEVEL }` with no `storage` field — first two assertions fail.

**Step 3: Modify `src/config.ts`**

Replace contents with:

```ts
import { z } from 'zod';

import { parseStorageUrl, type StorageConfig } from './storage/url.js';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  VITALS_STORAGE_URL: z
    .string()
    .min(1)
    .transform((url, ctx) => {
      try {
        return parseStorageUrl(url);
      } catch (err) {
        ctx.addIssue({
          code: 'custom',
          message: err instanceof Error ? err.message : String(err),
        });
        return z.NEVER;
      }
    }),
});

export type Config = {
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  storage: StorageConfig;
};

export function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:');
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  const { VITALS_STORAGE_URL, ...rest } = parsed.data;
  return { ...rest, storage: VITALS_STORAGE_URL };
}
```

**Step 4: Run check**

```bash
pnpm check
```

Expected: green. Note: existing `app.test.ts` doesn't call `loadConfig`, so unaffected.

**Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit
```

Message: `Add VITALS_STORAGE_URL to config schema`

---

## Task 11: Update `.env.example`

**Files:**

- Modify: `.env.example`

**Step 1: Read current contents**

```bash
cat .env.example
```

**Step 2: Append storage URL examples**

After the existing entries, add:

```
# Storage backend — pick exactly one form.
# Local filesystem (path must be absolute):
# VITALS_STORAGE_URL=file:///Users/you/vitals-archive
#
# AWS S3:
# VITALS_STORAGE_URL=s3://your-bucket?region=us-east-1
#
# S3-compatible (R2/B2/MinIO) — endpoint optional:
# VITALS_STORAGE_URL=s3://your-bucket?region=auto&endpoint=https://abc.r2.cloudflarestorage.com
```

**Step 3: Run check**

```bash
pnpm check
```

Expected: green.

**Step 4: Commit**

```bash
git add .env.example
git commit
```

Message: `Document VITALS_STORAGE_URL forms in .env.example`

---

## Task 12: Wire `BlobStore` into boot

**Files:**

- Modify: `src/index.ts`

No new test — `app.test.ts` exercises HTTP routing without booting `index.ts`. Manual smoke check verifies boot.

**Step 1: Modify `src/index.ts`**

Add the `createBlobStore` call after `loadConfig`. Final shape:

```ts
import { serve } from '@hono/node-server';
import pino from 'pino';

import { loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { createBlobStore } from './storage/index.js';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const storage = createBlobStore(config.storage);
logger.info({ driver: config.storage.driver }, 'storage backend initialized');

const app = createApp();

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port }, 'vitals service listening');
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
```

The `storage` constant is unused at top-level scope today (no HTTP routes yet); when the first route lands it will be passed into `createApp(storage)`. To prevent `no-unused-vars` from flagging it, also add an info log that references `storage`:

```ts
logger.debug({ keys: 'BlobStore ready' }, 'storage attached');
```

If lint still complains, suppress at this single site with a comment that explains why — but try the log line first.

**Alternative:** if eliminating the unused-var warning takes more than one nudge, leave the construction site behind a small helper that gets called from `createApp` later. For this task, prefer the inline log.

**Step 2: Manual smoke check**

```bash
mkdir -p /tmp/vitals-smoke
VITALS_STORAGE_URL=file:///tmp/vitals-smoke pnpm dev &
sleep 1
curl -s http://localhost:3000/health
kill %1 2>/dev/null
```

Expected: `/health` returns `{"status":"ok"}` and the log line `storage backend initialized` appears with `driver=local`.

Then:

```bash
VITALS_STORAGE_URL=s3://nonexistent?region=us-east-1 pnpm dev &
sleep 1
curl -s http://localhost:3000/health
kill %1 2>/dev/null
```

Expected: still 200 (we never hit S3 on `/health`); log line shows `driver=s3`.

Then:

```bash
pnpm dev
```

Expected: exits 1 with config error message about missing `VITALS_STORAGE_URL`.

**Step 3: Run check**

```bash
pnpm check
```

Expected: green.

**Step 4: Commit**

```bash
git add src/index.ts
git commit
```

Message: `Wire BlobStore initialization into service boot`

---

## Final verification

After Task 12:

```bash
pnpm check
git log --oneline origin/main..HEAD
git status
```

Expected:

- `pnpm check` green.
- 12 commits on the branch (one per task).
- Working tree clean.

The branch `worktree-feat-storage` is now ready for review and merge to `main`. Use superpowers:finishing-a-development-branch when ready to integrate.
