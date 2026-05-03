import { createHash } from 'node:crypto';

export function hashBytes(bytes: Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(bytes);
  return `sha256:${hash.digest('hex')}`;
}
