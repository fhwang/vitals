import type { Db } from '../db/index.js';
import type { TokenSet } from './credentials.js';
import { AdapterCredentialsStore } from './credentials.js';
import { SyncError } from './types.js';

export type RefreshFn = (refreshToken: string) => Promise<TokenSet>;

// Refresh tokens atomically via revision-based optimistic locking. Two
// processes that both read the same revision and both call the refresh
// function will race; the loser's UPDATE matches zero rows and gets a
// transient error. In practice the upstream API (e.g., Fitbit) also enforces
// single-use refresh tokens, so the loser's HTTP call typically fails before
// the DB check anyway.
export async function refreshAccessTokenAtomic(
  db: Db,
  adapterName: string,
  refresh: RefreshFn,
): Promise<TokenSet> {
  const store = new AdapterCredentialsStore(db);
  const current = store.read(adapterName);
  if (current === null) {
    throw new SyncError('no_credentials', `no credentials for ${adapterName}`);
  }
  const fresh = await refresh(current.tokens.refresh_token);
  const updated = store.updateAtRevision(adapterName, current.revision, fresh);
  if (updated === null) {
    throw new SyncError(
      'transient',
      `concurrent credential refresh detected for ${adapterName}; retry`,
    );
  }
  return updated.tokens;
}
