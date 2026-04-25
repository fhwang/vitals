import { S3Client } from '@aws-sdk/client-s3';
import { describe, it } from 'vitest';

import { runBlobStoreContract } from './blob-store.contract.js';
import { S3BlobStore } from './s3.js';

const bucket = process.env['VITALS_TEST_S3_BUCKET'];
const region = process.env['VITALS_TEST_S3_REGION'] ?? 'us-east-1';

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
