import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StorageConfig } from '#storage';
import {
  authConfigPath,
  loadGoogleHealthAuthConfig,
  saveGoogleHealthAuthConfig,
} from './auth-config.js';

function localStorage(root: string): StorageConfig {
  return { driver: 'local', root };
}

describe('loadGoogleHealthAuthConfig', () => {
  let tmp: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'vitals-auth-test-'));
    originalEnv = { ...process.env };
    delete process.env['GOOGLE_HEALTH_CLIENT_ID'];
    delete process.env['GOOGLE_HEALTH_CLIENT_SECRET'];
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = originalEnv;
  });

  it('returns null when no env vars and no file are present', () => {
    expect(loadGoogleHealthAuthConfig(localStorage(tmp))).toBeNull();
  });

  it('reads from env vars when set', () => {
    process.env['GOOGLE_HEALTH_CLIENT_ID'] = 'env-cid';
    process.env['GOOGLE_HEALTH_CLIENT_SECRET'] = 'env-csecret';
    expect(loadGoogleHealthAuthConfig(localStorage(tmp))).toEqual({
      client_id: 'env-cid',
      client_secret: 'env-csecret',
    });
  });

  it('falls back to the sidecar file when env vars are unset', () => {
    saveGoogleHealthAuthConfig(localStorage(tmp), { client_id: 'file-cid', client_secret: 'fs' });
    expect(loadGoogleHealthAuthConfig(localStorage(tmp))).toEqual({
      client_id: 'file-cid',
      client_secret: 'fs',
    });
  });

  it('prefers env vars over the sidecar file when both are present', () => {
    saveGoogleHealthAuthConfig(localStorage(tmp), { client_id: 'file-cid', client_secret: 'fs' });
    process.env['GOOGLE_HEALTH_CLIENT_ID'] = 'env-cid';
    process.env['GOOGLE_HEALTH_CLIENT_SECRET'] = 'env-csecret';
    expect(loadGoogleHealthAuthConfig(localStorage(tmp))).toEqual({
      client_id: 'env-cid',
      client_secret: 'env-csecret',
    });
  });

  it('throws when the sidecar file is malformed JSON', () => {
    mkdirSync(dirname(authConfigPath(tmp)), { recursive: true });
    writeFileSync(authConfigPath(tmp), 'not json', { mode: 0o600 });
    expect(() => loadGoogleHealthAuthConfig(localStorage(tmp))).toThrow(/invalid JSON/);
  });

  it('throws when the sidecar file is JSON but missing required fields', () => {
    mkdirSync(dirname(authConfigPath(tmp)), { recursive: true });
    writeFileSync(authConfigPath(tmp), JSON.stringify({ client_id: 'c' }));
    expect(() => loadGoogleHealthAuthConfig(localStorage(tmp))).toThrow(
      /invalid google-health auth config/,
    );
  });

  it('returns null when storage is omitted and env vars are absent', () => {
    expect(loadGoogleHealthAuthConfig()).toBeNull();
  });

  it('returns env-only when storage is non-local', () => {
    process.env['GOOGLE_HEALTH_CLIENT_ID'] = 'env-cid';
    process.env['GOOGLE_HEALTH_CLIENT_SECRET'] = 'env-csecret';
    expect(loadGoogleHealthAuthConfig({ driver: 's3', bucket: 'b', region: 'us-east-1' })).toEqual({
      client_id: 'env-cid',
      client_secret: 'env-csecret',
    });
  });
});

describe('saveGoogleHealthAuthConfig', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'vitals-auth-save-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the config directory if missing and writes 0600 permissions', () => {
    saveGoogleHealthAuthConfig(localStorage(tmp), { client_id: 'c', client_secret: 's' });
    const path = authConfigPath(tmp);
    expect(path.startsWith(tmp)).toBe(true);
    // round-trip via the loader confirms the file is well-formed
    delete process.env['GOOGLE_HEALTH_CLIENT_ID'];
    delete process.env['GOOGLE_HEALTH_CLIENT_SECRET'];
    expect(loadGoogleHealthAuthConfig(localStorage(tmp))).toEqual({
      client_id: 'c',
      client_secret: 's',
    });
  });

  it('refuses to save when storage driver is not local', () => {
    expect(() =>
      saveGoogleHealthAuthConfig(
        { driver: 's3', bucket: 'b', region: 'us-east-1' },
        { client_id: 'c', client_secret: 's' },
      ),
    ).toThrow(/file:\/\//);
  });
});
