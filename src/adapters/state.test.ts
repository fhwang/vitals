import { describe, expect, it } from 'vitest';

import { openDatabase } from '#db';
import { readState, updateFrontierAfterTick, writeStateError, writeStateSuccess } from './state.js';

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
    expect(state.freshness_frontier_at).toBeNull();
    expect(state.successful_ticks_since_frontier_advance).toBe(0);
  });

  it('writes and reads error state', () => {
    const db = openDatabase(':memory:');
    writeStateError(db, 'fitbit', { message: 'rate limited', reason: 'transient' });
    const state = readState(db, 'fitbit');
    if (state.status !== 'error') throw new Error('expected error');
    expect(state.last_error_message).toBe('rate limited');
  });

  it('overwrites prior state on second write', () => {
    const db = openDatabase(':memory:');
    writeStateError(db, 'fitbit', { message: 'first', reason: null });
    writeStateSuccess(db, 'fitbit', '2026-04-29T00:00:00Z');
    expect(readState(db, 'fitbit').status).toBe('success');
  });
});

describe('updateFrontierAfterTick', () => {
  it('advances the frontier and resets the tick counter when observed is later', () => {
    const db = openDatabase(':memory:');
    writeStateSuccess(db, 'fitbit', '2026-04-29T00:00:00Z');
    updateFrontierAfterTick(db, 'fitbit', '2026-04-29T18:00:00Z');
    const state = readState(db, 'fitbit');
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.freshness_frontier_at).toBe('2026-04-29T18:00:00Z');
    expect(state.successful_ticks_since_frontier_advance).toBe(0);
  });

  it('increments the tick counter when observed is not later', () => {
    const db = openDatabase(':memory:');
    writeStateSuccess(db, 'fitbit', '2026-04-29T00:00:00Z');
    updateFrontierAfterTick(db, 'fitbit', '2026-04-29T18:00:00Z');
    updateFrontierAfterTick(db, 'fitbit', '2026-04-29T17:00:00Z');
    updateFrontierAfterTick(db, 'fitbit', '2026-04-29T18:00:00Z');
    const state = readState(db, 'fitbit');
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.freshness_frontier_at).toBe('2026-04-29T18:00:00Z');
    expect(state.successful_ticks_since_frontier_advance).toBe(2);
  });

  it('increments the tick counter when observed is null', () => {
    const db = openDatabase(':memory:');
    writeStateSuccess(db, 'fitbit', '2026-04-29T00:00:00Z');
    updateFrontierAfterTick(db, 'fitbit', '2026-04-29T12:00:00Z');
    updateFrontierAfterTick(db, 'fitbit', null);
    const state = readState(db, 'fitbit');
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.freshness_frontier_at).toBe('2026-04-29T12:00:00Z');
    expect(state.successful_ticks_since_frontier_advance).toBe(1);
  });

  it('accepts the first observation when no frontier exists yet', () => {
    const db = openDatabase(':memory:');
    writeStateSuccess(db, 'fitbit', '2026-04-29T00:00:00Z');
    updateFrontierAfterTick(db, 'fitbit', '2026-04-29T08:00:00Z');
    const state = readState(db, 'fitbit');
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.freshness_frontier_at).toBe('2026-04-29T08:00:00Z');
    expect(state.successful_ticks_since_frontier_advance).toBe(0);
  });
});
