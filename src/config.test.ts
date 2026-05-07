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
    process.env['VITALS_DB_PATH'] = '/var/vitals.db';
    const config = loadConfig();
    expect(config.storage).toEqual({
      driver: 's3',
      bucket: 'bucket-x',
      region: 'us-west-2',
    });
  });

  it('defaults dbPath to <storage_root>/vitals.db when storage is local', () => {
    process.env['VITALS_STORAGE_URL'] = 'file:///var/vitals';
    delete process.env['VITALS_DB_PATH'];
    const config = loadConfig();
    expect(config.dbPath).toBe('/var/vitals/vitals.db');
  });

  it('honors VITALS_DB_PATH override when provided', () => {
    process.env['VITALS_STORAGE_URL'] = 'file:///var/vitals';
    process.env['VITALS_DB_PATH'] = '/custom/path/db.sqlite';
    const config = loadConfig();
    expect(config.dbPath).toBe('/custom/path/db.sqlite');
  });

  it('exits when storage is non-local and VITALS_DB_PATH is missing', () => {
    process.env['VITALS_STORAGE_URL'] = 's3://bucket-x?region=us-west-2';
    delete process.env['VITALS_DB_PATH'];
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
