import { describe, expect, it } from 'vitest';

import { openDatabase } from '../db/index.js';
import { readState, writeStateError, writeStateSuccess } from './state.js';

describe('adapter state', () => {
  it('reports never_synced for an unwritten adapter', () => {
    const db = openDatabase(':memory:');
    const state = readState(db, 'fitbit');
    expect(state).toEqual({ adapter_name: 'fitbit', status: 'never_synced' });
  });

  it('writes and reads success state', () => {
    const db = openDatabase(':memory:');
    writeStateSuccess(db, 'fitbit', '2026-04-29T00:00:00Z');
    const state = readState(db, 'fitbit');
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.last_synced_window_end).toBe('2026-04-29T00:00:00Z');
    expect(state.last_sync_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('writes and reads error state', () => {
    const db = openDatabase(':memory:');
    writeStateError(db, 'fitbit', 'rate limited');
    const state = readState(db, 'fitbit');
    if (state.status !== 'error') throw new Error('expected error');
    expect(state.last_error_message).toBe('rate limited');
  });

  it('overwrites prior state on second write', () => {
    const db = openDatabase(':memory:');
    writeStateError(db, 'fitbit', 'first');
    writeStateSuccess(db, 'fitbit', '2026-04-29T00:00:00Z');
    expect(readState(db, 'fitbit').status).toBe('success');
  });
});
