import type { BlobEntry, BlobMeta, BlobStore } from './blob-store.js';
import { assertValidKey } from './blob-store.js';

interface Stored {
  bytes: Uint8Array;
  contentType?: string;
  lastModified: Date;
}

export class MemoryBlobStore implements BlobStore {
  private readonly objects = new Map<string, Stored>();

  put(key: string, bytes: Uint8Array, contentType?: string): Promise<void> {
    try {
      assertValidKey(key);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const stored: Stored = {
      bytes: new Uint8Array(bytes),
      lastModified: new Date(),
    };
    if (contentType !== undefined) {
      stored.contentType = contentType;
    }
    this.objects.set(key, stored);
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
    const meta: BlobMeta = {
      size: stored.bytes.byteLength,
      lastModified: stored.lastModified,
    };
    if (stored.contentType !== undefined) {
      meta.contentType = stored.contentType;
    }
    return Promise.resolve(meta);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async generator parity with LocalFs/S3 adapters; this body has nothing to await today
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
