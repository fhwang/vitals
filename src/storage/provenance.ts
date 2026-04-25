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
  if (meta === null) return null;
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
