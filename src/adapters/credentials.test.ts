import { describe, expect, it } from 'vitest';

import { openDatabase } from '../db/index.js';
import { createAdapterCredentialsStore } from './credentials.js';

const sampleTokens = {
  access_token: 'AT',
  refresh_token: 'RT',
  expires_at: '2026-04-30T00:00:00Z',
};

describe('createAdapterCredentialsStore', () => {
  it('reads null when no credentials are stored', () => {
    const store = createAdapterCredentialsStore(openDatabase(':memory:'));
    expect(store.read('fitbit')).toBeNull();
  });

  it('inserts and reads back credentials at revision 0', () => {
    const store = createAdapterCredentialsStore(openDatabase(':memory:'));
    store.insert('fitbit', sampleTokens);
    const row = store.read('fitbit');
    expect(row?.tokens.access_token).toBe('AT');
    expect(row?.tokens.refresh_token).toBe('RT');
    expect(row?.revision).toBe(0);
  });

  it('updates and bumps revision when revision matches', () => {
    const store = createAdapterCredentialsStore(openDatabase(':memory:'));
    store.insert('fitbit', sampleTokens);
    const updated = store.updateAtRevision({
      adapterName: 'fitbit',
      expectedRevision: 0,
      tokens: { access_token: 'AT2', refresh_token: 'RT2', expires_at: '2026-04-30T01:00:00Z' },
    });
    expect(updated?.revision).toBe(1);
    expect(store.read('fitbit')?.tokens.access_token).toBe('AT2');
  });

  it('returns null when expected revision is stale', () => {
    const store = createAdapterCredentialsStore(openDatabase(':memory:'));
    store.insert('fitbit', sampleTokens);
    store.updateAtRevision({
      adapterName: 'fitbit',
      expectedRevision: 0,
      tokens: { access_token: 'AT2', refresh_token: 'RT2', expires_at: '2026-04-30T01:00:00Z' },
    });
    const result = store.updateAtRevision({
      adapterName: 'fitbit',
      expectedRevision: 0,
      tokens: { access_token: 'AT3', refresh_token: 'RT3', expires_at: '2026-04-30T02:00:00Z' },
    });
    expect(result).toBeNull();
    expect(store.read('fitbit')?.tokens.access_token).toBe('AT2');
  });

  it('upserts a new row at revision 0', () => {
    const store = createAdapterCredentialsStore(openDatabase(':memory:'));
    const row = store.upsert('googlehealth', sampleTokens);
    expect(row.revision).toBe(0);
    expect(store.read('googlehealth')?.tokens.access_token).toBe('AT');
  });

  it('upsert replaces existing tokens and resets revision to 0', () => {
    const store = createAdapterCredentialsStore(openDatabase(':memory:'));
    store.insert('googlehealth', sampleTokens);
    store.updateAtRevision({
      adapterName: 'googlehealth',
      expectedRevision: 0,
      tokens: { access_token: 'AT2', refresh_token: 'RT2', expires_at: '2026-04-30T01:00:00Z' },
    });
    expect(store.read('googlehealth')?.revision).toBe(1);

    const replaced = store.upsert('googlehealth', {
      access_token: 'NEW_AT',
      refresh_token: 'NEW_RT',
      expires_at: '2026-05-03T00:00:00Z',
    });
    expect(replaced.revision).toBe(0);
    const after = store.read('googlehealth');
    expect(after?.revision).toBe(0);
    expect(after?.tokens.access_token).toBe('NEW_AT');
    expect(after?.tokens.refresh_token).toBe('NEW_RT');
  });
});
