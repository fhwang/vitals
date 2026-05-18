import { describe, expect, it } from 'vitest';

import { SYSTEM_LOINC } from '#records';

import { SyncError } from '../types.js';
import type { OuraSleepSession } from './api.js';
import { parseOuraSleepSession } from './parser.js';
import { OURA_SLEEP_STAGE, OURA_SLEEP_STAGE_CODE, OURA_SLEEP_STAGE_SYSTEM } from './sleep-stage.js';

// Default session is 90 minutes (18 × 5-min epochs), all awake. Override
// `sleep_phase_5_min` to change shape but match `bedtime_end` to length × 5min.
function buildSession(overrides: Partial<OuraSleepSession> = {}): OuraSleepSession {
  return {
    id: 'session-1',
    day: '2026-05-17',
    bedtime_start: '2026-05-16T23:00:00-04:00',
    bedtime_end: '2026-05-17T00:30:00-04:00',
    type: 'long_sleep',
    sleep_phase_5_min: '4'.repeat(18),
    ...overrides,
  };
}

// Builds a session whose bedtime_end is derived from the stage string length
// (so the epoch invariant holds by construction). Lets tests focus on stage
// content without manually computing session duration.
function buildSessionForStages(
  stageString: string,
  overrides: Partial<OuraSleepSession> = {},
): OuraSleepSession {
  const startIso = '2026-05-16T23:00:00-04:00';
  const startMs = Date.parse(startIso);
  const endMs = startMs + stageString.length * 5 * 60 * 1000;
  // Format as local time with the same -04:00 offset for clarity.
  const localEnd = new Date(endMs - 4 * 60 * 60 * 1000).toISOString().slice(0, 19);
  return buildSession({
    bedtime_start: startIso,
    bedtime_end: `${localEnd}-04:00`,
    sleep_phase_5_min: stageString,
    ...overrides,
  });
}

describe('parseOuraSleepSession', () => {
  it('extracts the local end date from bedtime_end', () => {
    const result = parseOuraSleepSession(buildSession());
    expect(result.end_local_date).toBe('2026-05-17');
  });

  it('extracts the TZ offset in minutes (negative for west)', () => {
    const result = parseOuraSleepSession(buildSession());
    expect(result.start_tz_offset_minutes).toBe(-240);
  });

  it('handles positive offsets', () => {
    const result = parseOuraSleepSession(
      buildSession({
        bedtime_start: '2026-05-16T23:00:00+05:30',
        bedtime_end: '2026-05-17T00:30:00+05:30',
      }),
    );
    expect(result.start_tz_offset_minutes).toBe(330);
  });

  it('handles UTC (Z) offset', () => {
    const result = parseOuraSleepSession(
      buildSession({
        bedtime_start: '2026-05-16T23:00:00Z',
        bedtime_end: '2026-05-17T00:30:00Z',
      }),
    );
    expect(result.start_tz_offset_minutes).toBe(0);
  });

  it('maps Oura type to category', () => {
    expect(parseOuraSleepSession(buildSession({ type: 'long_sleep' })).category).toBe('main');
    expect(parseOuraSleepSession(buildSession({ type: 'sleep' })).category).toBe('main');
    expect(parseOuraSleepSession(buildSession({ type: 'late_nap' })).category).toBe('nap');
    expect(parseOuraSleepSession(buildSession({ type: 'rest' })).category).toBe('rest');
    expect(parseOuraSleepSession(buildSession({ type: 'something_new' })).category).toBe('other');
  });

  it('collapses adjacent same-stage epochs into one run', () => {
    // 18 epochs (90 minutes): 3×awake, 3×light, 4×deep, 2×REM, 6×awake
    const result = parseOuraSleepSession(buildSessionForStages('444222111133444444'));
    const stageRuns = result.observations.filter(
      (o) => o.coding.system === OURA_SLEEP_STAGE_SYSTEM,
    );
    expect(stageRuns).toHaveLength(5);
    expect(stageRuns.map((r) => r.value)).toEqual([
      OURA_SLEEP_STAGE.awake,
      OURA_SLEEP_STAGE.light,
      OURA_SLEEP_STAGE.deep,
      OURA_SLEEP_STAGE.rem,
      OURA_SLEEP_STAGE.awake,
    ]);
  });

  it('produces contiguous run boundaries (effective_end === next.effective_start)', () => {
    const result = parseOuraSleepSession(buildSessionForStages('11223344'));
    const stageRuns = result.observations.filter(
      (o) => o.coding.system === OURA_SLEEP_STAGE_SYSTEM,
    );
    for (let i = 0; i < stageRuns.length - 1; i++) {
      expect(stageRuns[i]?.effective_end).toBe(stageRuns[i + 1]?.effective_start);
    }
  });

  it('emits each stage run with the Oura native coding and {stage} unit', () => {
    const result = parseOuraSleepSession(buildSessionForStages('1'));
    const stageRuns = result.observations.filter(
      (o) => o.coding.system === OURA_SLEEP_STAGE_SYSTEM,
    );
    expect(stageRuns).toHaveLength(1);
    expect(stageRuns[0]?.coding.code).toBe(OURA_SLEEP_STAGE_CODE);
    expect(stageRuns[0]?.unit).toBe('{stage}');
    expect(stageRuns[0]?.value).toBe(OURA_SLEEP_STAGE.deep);
  });

  it('emits LOINC aggregate observations when Oura provides them', () => {
    const result = parseOuraSleepSession(
      buildSession({
        total_sleep_duration: 28800, // 480 min
        rem_sleep_duration: 6000, // 100 min
        light_sleep_duration: 14400, // 240 min
        deep_sleep_duration: 7200, // 120 min
        awake_time: 1200, // 20 min
      }),
    );
    const loincObs = result.observations.filter((o) => o.coding.system === SYSTEM_LOINC);
    const byCode = Object.fromEntries(loincObs.map((o) => [o.coding.code, o.value]));
    expect(byCode['93832-4']).toBe(480); // TST
    expect(byCode['93829-0']).toBe(100); // REM
    expect(byCode['93830-8']).toBe(240); // Light
    expect(byCode['93831-6']).toBe(120); // Deep
    expect(byCode['103215-0']).toBe(20); // WASO
  });

  it('skips LOINC aggregate observations when fields are absent', () => {
    const result = parseOuraSleepSession(buildSession());
    const loincObs = result.observations.filter((o) => o.coding.system === SYSTEM_LOINC);
    expect(loincObs).toHaveLength(0);
  });

  it('throws parse_error when sleep_phase_5_min length does not match session duration', () => {
    // 18 epochs × 5 min = 90 min, but session is 60 min
    expect(() =>
      parseOuraSleepSession(
        buildSession({
          bedtime_start: '2026-05-16T23:00:00-04:00',
          bedtime_end: '2026-05-17T00:00:00-04:00', // 60-min session
          sleep_phase_5_min: '4'.repeat(18), // 90-min epoch string
        }),
      ),
    ).toThrow(SyncError);
  });

  it('tolerates one-epoch slack in the epoch invariant', () => {
    // Session is 90 min; string is 91 min. Within tolerance.
    const result = parseOuraSleepSession(
      buildSession({
        bedtime_start: '2026-05-16T23:00:00-04:00',
        bedtime_end: '2026-05-17T00:30:00-04:00',
        sleep_phase_5_min: '4'.repeat(19),
      }),
    );
    expect(
      result.observations.filter((o) => o.coding.system === OURA_SLEEP_STAGE_SYSTEM),
    ).toHaveLength(1);
  });

  it('throws on unrecognized stage characters', () => {
    expect(() =>
      parseOuraSleepSession(buildSession({ sleep_phase_5_min: '5'.repeat(18) })),
    ).toThrow(SyncError);
  });

  it('emits the same date on every observation (end_local_date)', () => {
    const result = parseOuraSleepSession(buildSession());
    for (const obs of result.observations) {
      expect(obs.date).toBe(result.end_local_date);
    }
  });
});
