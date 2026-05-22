import { describe, expect, it } from 'vitest';

import { openDatabase } from '#db';
import { MemoryBlobStore } from '#storage';

import type { OuraFetcher, OuraSleepSession } from './api.js';
import { pullSessions, sleepWindow } from './index.js';
import { createOuraStore } from './storage.js';

describe('sleepWindow', () => {
  it('returns the requested number of days ending today (UTC)', () => {
    const today = new Date('2026-05-17T12:00:00Z');
    expect(sleepWindow(today, 3)).toEqual(['2026-05-15', '2026-05-17']);
  });

  it('handles a window of 1 (start == end)', () => {
    const today = new Date('2026-05-17T12:00:00Z');
    expect(sleepWindow(today, 1)).toEqual(['2026-05-17', '2026-05-17']);
  });

  it('handles month boundaries', () => {
    const today = new Date('2026-05-01T12:00:00Z');
    expect(sleepWindow(today, 3)).toEqual(['2026-04-29', '2026-05-01']);
  });
});

function session(overrides: Partial<OuraSleepSession>): OuraSleepSession {
  return {
    id: overrides.id ?? 'session-1',
    day: overrides.day ?? '2026-05-17',
    bedtime_start: overrides.bedtime_start ?? '2026-05-16T23:00:00-04:00',
    bedtime_end: overrides.bedtime_end ?? '2026-05-17T00:30:00-04:00',
    type: overrides.type ?? 'long_sleep',
    sleep_phase_5_min: overrides.sleep_phase_5_min ?? '4'.repeat(18),
    ...overrides,
  };
}

function fakeFetcher(sessions: OuraSleepSession[]): OuraFetcher {
  return () => Promise.resolve({ sessions, raw: { data: sessions } });
}

describe('pullSessions', () => {
  it('inserts new sessions and counts observations', async () => {
    const db = openDatabase(':memory:');
    const store = createOuraStore(db, new MemoryBlobStore());
    const sessions = [session({ id: 's1' })];
    const result = await pullSessions(fakeFetcher(sessions), store, ['2026-05-15', '2026-05-17']);
    expect(result.sessions_added).toBe(1);
    expect(result.sessions_existing).toBe(0);
    expect(result.observations_added).toBeGreaterThan(0);
    expect(result.max_session_end_at).not.toBeNull();
  });

  it('skips already-ingested sessions by id', async () => {
    const db = openDatabase(':memory:');
    const store = createOuraStore(db, new MemoryBlobStore());
    const sessions = [session({ id: 's1' })];
    // First pull: insert
    await pullSessions(fakeFetcher(sessions), store, ['2026-05-15', '2026-05-17']);
    // Second pull (same session): skip
    const result = await pullSessions(fakeFetcher(sessions), store, ['2026-05-15', '2026-05-17']);
    expect(result.sessions_added).toBe(0);
    expect(result.sessions_existing).toBe(1);
  });

  it('handles multiple sessions in one pull (main + nap)', async () => {
    const db = openDatabase(':memory:');
    const store = createOuraStore(db, new MemoryBlobStore());
    const sessions = [
      session({ id: 'main', type: 'long_sleep' }),
      session({
        id: 'nap',
        type: 'late_nap',
        bedtime_start: '2026-05-17T14:00:00-04:00',
        bedtime_end: '2026-05-17T14:30:00-04:00',
        sleep_phase_5_min: '4'.repeat(6),
      }),
    ];
    const result = await pullSessions(fakeFetcher(sessions), store, ['2026-05-15', '2026-05-17']);
    expect(result.sessions_added).toBe(2);
  });

  it('advances max_session_end_at to the latest bedtime_end across new sessions', async () => {
    const db = openDatabase(':memory:');
    const store = createOuraStore(db, new MemoryBlobStore());
    const sessions = [
      session({ id: 'early', bedtime_end: '2026-05-17T00:30:00-04:00' }),
      session({
        id: 'late',
        bedtime_start: '2026-05-17T14:00:00-04:00',
        bedtime_end: '2026-05-17T14:30:00-04:00',
        sleep_phase_5_min: '4'.repeat(6),
      }),
    ];
    const result = await pullSessions(fakeFetcher(sessions), store, ['2026-05-15', '2026-05-17']);
    expect(result.max_session_end_at).toBe('2026-05-17T18:30:00.000Z');
  });
});
