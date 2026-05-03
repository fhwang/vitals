import { gunzipSync, gzipSync } from 'node:zlib';

import type { BlobStore } from './blob-store.js';

const GZIP_SUFFIX = '.gz';
const GZIP_CONTENT_TYPE = 'application/gzip';

export function gzipKey(key: string): string {
  return key.endsWith(GZIP_SUFFIX) ? key : `${key}${GZIP_SUFFIX}`;
}

export async function putGzipped(
  store: BlobStore,
  key: string,
  bytes: Uint8Array,
): Promise<string> {
  const finalKey = gzipKey(key);
  const compressed = gzipSync(bytes);
  await store.put(finalKey, new Uint8Array(compressed), GZIP_CONTENT_TYPE);
  return finalKey;
}

export async function getInflated(store: BlobStore, key: string): Promise<Uint8Array> {
  const compressed = await store.get(key);
  if (!key.endsWith(GZIP_SUFFIX)) return compressed;
  return new Uint8Array(gunzipSync(compressed));
}
