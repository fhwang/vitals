import { type Dirent } from 'node:fs';
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

  async put(key: string, bytes: Uint8Array): Promise<void> {
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

async function readDirOrEmpty(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

async function* walk(root: string, dir: string): AsyncIterable<BlobEntry> {
  const entries = await readDirOrEmpty(dir);
  for (const entry of entries) {
    yield* visitEntry(root, dir, entry);
  }
}

async function* visitEntry(root: string, dir: string, entry: Dirent): AsyncIterable<BlobEntry> {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) {
    yield* walk(root, full);
  } else if (entry.isFile()) {
    const stat = await fs.stat(full);
    const key = path.relative(root, full).split(path.sep).join('/');
    yield { key, size: stat.size, lastModified: stat.mtime };
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
