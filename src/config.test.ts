import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from './config.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('loadConfig', () => {
  it('parses a file:// storage URL into a local StorageConfig', () => {
    process.env['VITALS_STORAGE_URL'] = 'file:///var/vitals';
    const config = loadConfig();
    expect(config.storage).toEqual({ driver: 'local', root: '/var/vitals' });
  });

  it('parses an s3:// storage URL into an s3 StorageConfig', () => {
    process.env['VITALS_STORAGE_URL'] = 's3://bucket-x?region=us-west-2';
    const config = loadConfig();
    expect(config.storage).toEqual({
      driver: 's3',
      bucket: 'bucket-x',
      region: 'us-west-2',
    });
  });

  it('exits on missing VITALS_STORAGE_URL', () => {
    delete process.env['VITALS_STORAGE_URL'];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number): never => {
      throw new Error(`exit ${code ?? 'no-code'}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      // suppress
    });
    expect(() => loadConfig()).toThrow(/exit 1/);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
