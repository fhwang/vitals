import { describe, expect, it } from 'vitest';

import { parseStorageUrl } from './url.js';

describe('parseStorageUrl', () => {
  it('parses a file:// URL with an absolute path', () => {
    expect(parseStorageUrl('file:///var/vitals')).toEqual({
      driver: 'local',
      root: '/var/vitals',
    });
  });

  it('parses an s3:// URL with required region', () => {
    expect(parseStorageUrl('s3://my-bucket?region=us-east-1')).toEqual({
      driver: 's3',
      bucket: 'my-bucket',
      region: 'us-east-1',
    });
  });

  it('parses an s3:// URL with optional endpoint', () => {
    expect(
      parseStorageUrl('s3://my-bucket?region=auto&endpoint=https://abc.r2.cloudflarestorage.com'),
    ).toEqual({
      driver: 's3',
      bucket: 'my-bucket',
      region: 'auto',
      endpoint: 'https://abc.r2.cloudflarestorage.com',
    });
  });

  it('rejects malformed URLs', () => {
    expect(() => parseStorageUrl('not a url')).toThrow();
  });

  it('rejects unsupported protocols', () => {
    expect(() => parseStorageUrl('ftp://server/path')).toThrow(/file:\/\/ or s3:\/\//);
  });

  it('rejects an s3:// URL without region', () => {
    expect(() => parseStorageUrl('s3://my-bucket')).toThrow(/region/);
  });

  it('rejects an s3:// URL without bucket', () => {
    expect(() => parseStorageUrl('s3://?region=us-east-1')).toThrow(/bucket/);
  });
});
