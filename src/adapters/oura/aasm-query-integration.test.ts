import { describe, expect, it } from 'vitest';

import { createCodingRegistry } from '#adapters';
import { openDatabase } from '#db';
import { createSqliteArchive } from '#query';
import { AASM_SLEEP_STAGE, AASM_SLEEP_STAGE_CODE, AASM_SLEEP_STAGE_SYSTEM } from '#records';
import { MemoryBlobStore } from '#storage';

import { updateFrontierAfterTick, writeStateSuccess } from '../state.js';
import type { OuraFetcher, OuraSleepSession } from './api.js';
import { ouraCodingRegistration } from './coding-registration.js';
import { writeOuraCredentials } from './credentials.js';
import { pullSessions } from './index.js';
import { createOuraStore } from './storage.js';

// Builds a session whose duration matches the stage string length.
function session(
  id: string,
  bedtimeStart: string,
  stageString: string,
  overrides: Partial<OuraSleepSession> = {},
): OuraSleepSession {
  const startMs = Date.parse(bedtimeStart);
  const endMs = startMs + stageString.length * 5 * 60 * 1000;
  // Reconstruct the same -04:00 offset to keep the local-end-date stable.
  const localEnd = new Date(endMs - 4 * 60 * 60 * 1000).toISOString().slice(0, 19);
  return {
    id,
    day: bedtimeStart.slice(0, 10),
    bedtime_start: bedtimeStart,
    bedtime_end: `${localEnd}-04:00`,
    type: 'long_sleep',
    sleep_phase_5_min: stageString,
    ...overrides,
  };
}

function fakeFetcher(sessions: OuraSleepSession[]): OuraFetcher {
  return () => Promise.resolve({ sessions, raw: { data: sessions } });
}

describe('getLongestContinuousPeriodInValueRange via AASM canonical coding', () => {
  it("answers the harness's V1 query end-to-end against Oura-native observations", async () => {
    const db = openDatabase(':memory:');
    const blobs = new MemoryBlobStore();
    writeOuraCredentials(db, { access_token: 'test-pat' });

    // Synthesize a sleep session: 8 hours, all "light" (Oura code 2 → AASM {N1,N2})
    // Stage string: 96 epochs of '2' → 480 minutes of light/N1/N2.
    const sessions = [session('s-light', '2026-05-16T23:00:00-04:00', '2'.repeat(96))];
    const store = createOuraStore(db, blobs);
    await pullSessions(fakeFetcher(sessions), store, ['2026-05-16', '2026-05-17']);

    const codings = createCodingRegistry();
    codings.register(ouraCodingRegistration(db));
    const archive = createSqliteArchive(db, blobs, codings);

    // Query the canonical AASM coding for "any asleep" (N1..REM = 1..4)
    const result = archive.getLongestContinuousPeriodInValueRange({
      coding: { system: AASM_SLEEP_STAGE_SYSTEM, code: AASM_SLEEP_STAGE_CODE },
      start_date: '2026-05-16',
      end_date: '2026-05-17',
      min_value: AASM_SLEEP_STAGE.n1,
      max_value: AASM_SLEEP_STAGE.rem,
      bucket: 'day',
      gap_seconds: 0,
    });

    if (!('per_bucket' in result)) throw new Error('expected per_bucket');
    expect(result.per_bucket).toHaveLength(1);
    expect(result.per_bucket[0]?.bucket_start).toBe('2026-05-17'); // night ends on May 17
    expect(result.per_bucket[0]?.longest_minutes).toBe(480); // 8 hours
  });

  it('returns no matching native stages for AASM {N1} alone (Oura cannot prove N1-only)', async () => {
    const db = openDatabase(':memory:');
    const blobs = new MemoryBlobStore();
    writeOuraCredentials(db, { access_token: 'test-pat' });
    const sessions = [session('s', '2026-05-16T23:00:00-04:00', '2'.repeat(96))];
    const store = createOuraStore(db, blobs);
    await pullSessions(fakeFetcher(sessions), store, ['2026-05-16', '2026-05-17']);

    const codings = createCodingRegistry();
    codings.register(ouraCodingRegistration(db));
    const archive = createSqliteArchive(db, blobs, codings);

    const result = archive.getLongestContinuousPeriodInValueRange({
      coding: { system: AASM_SLEEP_STAGE_SYSTEM, code: AASM_SLEEP_STAGE_CODE },
      start_date: '2026-05-16',
      end_date: '2026-05-17',
      min_value: AASM_SLEEP_STAGE.n1,
      max_value: AASM_SLEEP_STAGE.n1,
      bucket: 'none',
      gap_seconds: 0,
    });

    if ('per_bucket' in result) throw new Error('expected total result');
    expect(result.longest_minutes).toBe(0);
  });

  it('reports an Oura-routed freshness frontier in the response', () => {
    const db = openDatabase(':memory:');
    const blobs = new MemoryBlobStore();
    writeOuraCredentials(db, { access_token: 'test-pat' });

    // The runOuraSync flow writes both; pullSessions alone doesn't update
    // adapter_state, so we write it explicitly here to exercise the
    // freshness-frontier routing through the coding registry.
    writeStateSuccess(db, 'oura', '2026-05-17T23:59:59Z');
    updateFrontierAfterTick(db, 'oura', '2026-05-17T07:00:00Z');

    const codings = createCodingRegistry();
    codings.register(ouraCodingRegistration(db));
    const archive = createSqliteArchive(db, blobs, codings);

    const result = archive.getLongestContinuousPeriodInValueRange({
      coding: { system: AASM_SLEEP_STAGE_SYSTEM, code: AASM_SLEEP_STAGE_CODE },
      start_date: '2026-05-16',
      end_date: '2026-05-17',
      min_value: AASM_SLEEP_STAGE.n1,
      max_value: AASM_SLEEP_STAGE.rem,
      bucket: 'none',
      gap_seconds: 0,
    });
    expect(result.freshness_frontier_at).toBe('2026-05-17T07:00:00Z');
  });
});
