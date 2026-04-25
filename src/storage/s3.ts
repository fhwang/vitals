import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
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
        ...(contentType === undefined ? {} : { ContentType: contentType }),
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    assertValidKey(key);
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (result.Body === undefined) {
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
      return headResultToMeta(result);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async *list(prefix: string): AsyncIterable<BlobEntry> {
    let token: string | undefined;
    do {
      const page = await this.pageOnce(prefix, token);
      for (const entry of page.entries) {
        yield entry;
      }
      token = page.nextToken;
    } while (token !== undefined && token !== '');
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  private async pageOnce(
    prefix: string,
    token: string | undefined,
  ): Promise<{ entries: BlobEntry[]; nextToken: string | undefined }> {
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ...(token === undefined ? {} : { ContinuationToken: token }),
      }),
    );
    const entries: BlobEntry[] = [];
    for (const obj of result.Contents ?? []) {
      if (obj.Key === undefined) continue;
      entries.push({
        key: obj.Key,
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ?? new Date(0),
      });
    }
    return { entries, nextToken: result.NextContinuationToken };
  }
}

function headResultToMeta(result: HeadObjectCommandOutput): BlobMeta {
  const meta: BlobMeta = {
    size: result.ContentLength ?? 0,
    lastModified: result.LastModified ?? new Date(0),
  };
  if (result.ContentType !== undefined) {
    meta.contentType = result.ContentType;
  }
  return meta;
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
