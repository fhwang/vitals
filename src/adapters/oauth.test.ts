import { describe, expect, it } from 'vitest';

import { openDatabase } from '../db/index.js';
import { createAdapterCredentialsStore } from './credentials.js';
import type { TokenSet } from './credentials.js';
import { refreshAccessTokenAtomic } from './oauth.js';
import { SyncError } from './types.js';

const initialTokens: TokenSet = {
  access_token: 'AT',
  refresh_token: 'RT',
  expires_at: '2026-04-30T00:00:00Z',
};

describe('refreshAccessTokenAtomic', () => {
  it('returns the new tokens and persists them', async () => {
    const db = openDatabase(':memory:');
    createAdapterCredentialsStore(db).insert('fitbit', initialTokens);
    const fresh: TokenSet = {
      access_token: 'AT2',
      refresh_token: 'RT2',
      expires_at: '2026-04-30T01:00:00Z',
    };
    const result = await refreshAccessTokenAtomic(db, 'fitbit', () => Promise.resolve(fresh));
    expect(result).toEqual(fresh);
    const stored = createAdapterCredentialsStore(db).read('fitbit');
    expect(stored?.tokens).toEqual(fresh);
    expect(stored?.revision).toBe(1);
  });

  it('throws no_credentials when no row exists', async () => {
    const db = openDatabase(':memory:');
    await expect(
      refreshAccessTokenAtomic(db, 'fitbit', () =>
        Promise.reject(new Error('should not be called')),
      ),
    ).rejects.toMatchObject({
      name: 'SyncError',
      reason: 'no_credentials',
    });
  });

  it('throws transient when revision changed mid-refresh', async () => {
    const db = openDatabase(':memory:');
    const store = createAdapterCredentialsStore(db);
    store.insert('fitbit', initialTokens);

    const racingRefresh = (): Promise<TokenSet> => {
      // Simulate a concurrent process committing a refresh while ours is in flight
      const winnerResult = store.updateAtRevision({
        adapterName: 'fitbit',
        expectedRevision: 0,
        tokens: {
          access_token: 'AT_winner',
          refresh_token: 'RT_winner',
          expires_at: '2026-04-30T01:00:00Z',
        },
      });
      expect(winnerResult).not.toBeNull();
      return Promise.resolve({
        access_token: 'AT_loser',
        refresh_token: 'RT_loser',
        expires_at: '2026-04-30T01:00:00Z',
      });
    };

    let caught: SyncError | undefined;
    try {
      await refreshAccessTokenAtomic(db, 'fitbit', racingRefresh);
    } catch (err) {
      caught = err instanceof SyncError ? err : undefined;
    }
    expect(caught?.reason).toBe('transient');
  });
});
