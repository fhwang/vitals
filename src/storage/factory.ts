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
