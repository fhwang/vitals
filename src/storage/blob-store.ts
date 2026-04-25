export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  head(key: string): Promise<BlobMeta | null>;
  list(prefix: string): AsyncIterable<BlobEntry>;
  delete(key: string): Promise<void>;
}

export interface BlobMeta {
  size: number;
  lastModified: Date;
  contentType?: string;
}

export interface BlobEntry {
  key: string;
  size: number;
  lastModified: Date;
}

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
