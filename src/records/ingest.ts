import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { BlobStore, Provenance } from '../storage/index.js';
import { hashBytes, writeProvenance } from '../storage/index.js';
import { FileNotFoundError, UnsupportedKindError } from './errors.js';
import { kindRegistry, type Kind } from './kind-registry.js';

export interface IngestInput {
  path: string;
  kind: string;
  source: string;
  original_filename?: string;
}

async function readBytesOrThrow(realPath: string, originalPath: string): Promise<Uint8Array> {
  try {
    return await readFile(realPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new FileNotFoundError(originalPath);
    throw err;
  }
}

function resolveKind(kind: string): Kind {
  if (!Object.prototype.hasOwnProperty.call(kindRegistry, kind)) {
    throw new UnsupportedKindError(kind, Object.keys(kindRegistry));
  }
  return kind as Kind;
}

function buildProvenance(input: IngestInput, fullHash: string): Provenance {
  return {
    source: input.source,
    ingested_at: new Date().toISOString(),
    original_filename: input.original_filename ?? basename(input.path),
    content_hash: fullHash,
  };
}

function buildKey(kind: Kind, fullHash: string): string {
  const handler = kindRegistry[kind];
  const hex = fullHash.slice('sha256:'.length);
  return `${handler.kind}/${hex}.${handler.extension}`;
}

export async function ingestRecord(
  store: BlobStore,
  validatePath: (path: string) => Promise<string>,
  input: IngestInput,
) {
  const kind = resolveKind(input.kind);
  const realPath = await validatePath(input.path);
  const bytes = await readBytesOrThrow(realPath, input.path);
  kindRegistry[kind].validateBytes(bytes);
  kindRegistry[kind].parseDocument(bytes);
  const fullHash = hashBytes(bytes);
  const key = buildKey(kind, fullHash);
  await store.put(key, bytes, kindRegistry[kind].contentType);
  await writeProvenance(store, key, buildProvenance(input, fullHash));
  return { key, kind };
}
