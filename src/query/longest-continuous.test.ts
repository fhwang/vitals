import { describe, expect, it } from 'vitest';

import {
  computeDailyLongest,
  computeLongestRun,
  type MatchingPeriodRow,
} from './longest-continuous.js';

function row(start: string, end: string): MatchingPeriodRow {
  return { effective_start: start, effective_end: end };
}

describe('computeLongestRun', () => {
  it('returns zero for empty input', () => {
    expect(computeLongestRun([], 0)).toEqual({
      longest_minutes: 0,
      longest_start: null,
      longest_end: null,
    });
  });

  it('returns a single row as its own run', () => {
    const result = computeLongestRun([row('2026-05-17T00:00:00Z', '2026-05-17T00:30:00Z')], 0);
    expect(result.longest_minutes).toBe(30);
    expect(result.longest_start).toBe('2026-05-17T00:00:00Z');
    expect(result.longest_end).toBe('2026-05-17T00:30:00Z');
  });

  it('merges strictly-adjacent rows into one run (gap=0)', () => {
    // Two 30-minute runs back-to-back: total 60 minutes
    const result = computeLongestRun(
      [
        row('2026-05-17T00:00:00Z', '2026-05-17T00:30:00Z'),
        row('2026-05-17T00:30:00Z', '2026-05-17T01:00:00Z'),
      ],
      0,
    );
    expect(result.longest_minutes).toBe(60);
    expect(result.longest_end).toBe('2026-05-17T01:00:00Z');
  });

  it('does NOT merge rows separated by a gap (gap=0)', () => {
    // 30 minute run, 1 minute gap, 60 minute run → max is 60
    const result = computeLongestRun(
      [
        row('2026-05-17T00:00:00Z', '2026-05-17T00:30:00Z'),
        row('2026-05-17T00:31:00Z', '2026-05-17T01:31:00Z'),
      ],
      0,
    );
    expect(result.longest_minutes).toBe(60);
    expect(result.longest_start).toBe('2026-05-17T00:31:00Z');
  });

  it('respects gap_seconds tolerance to merge near-adjacent rows', () => {
    // 30 min + 60s gap + 30 min → with gap=60, merges into one 60-min+60s≈61 run
    const result = computeLongestRun(
      [
        row('2026-05-17T00:00:00Z', '2026-05-17T00:30:00Z'),
        row('2026-05-17T00:31:00Z', '2026-05-17T01:01:00Z'),
      ],
      60,
    );
    expect(result.longest_minutes).toBe(61);
  });

  it('picks the longest of multiple separate runs', () => {
    // 30 min run, gap, 90 min run, gap, 60 min run → max is 90
    const result = computeLongestRun(
      [
        row('2026-05-17T00:00:00Z', '2026-05-17T00:30:00Z'),
        row('2026-05-17T02:00:00Z', '2026-05-17T03:30:00Z'),
        row('2026-05-17T05:00:00Z', '2026-05-17T06:00:00Z'),
      ],
      0,
    );
    expect(result.longest_minutes).toBe(90);
    expect(result.longest_start).toBe('2026-05-17T02:00:00Z');
    expect(result.longest_end).toBe('2026-05-17T03:30:00Z');
  });

  it('handles a typical sleep stage timeline (8 hours, mid-night awakening)', () => {
    // Stages map: 11:00pm → 3:30am (4.5h asleep) → 3:45am wake → 4:00am asleep → 7:00am wake
    // Asleep rows (filtered to value=asleep): two runs of 270min and 180min
    const result = computeLongestRun(
      [
        // First asleep block: 11pm to 3:30am (270 min, but in 30-min sub-runs)
        row('2026-05-16T23:00:00Z', '2026-05-17T01:00:00Z'), // 120 min
        row('2026-05-17T01:00:00Z', '2026-05-17T03:30:00Z'), // 150 min — adjacent
        // Awakening
        // Second asleep block: 4am to 7am (180 min)
        row('2026-05-17T04:00:00Z', '2026-05-17T07:00:00Z'),
      ],
      0,
    );
    expect(result.longest_minutes).toBe(270); // first block, merged
  });
});

describe('computeDailyLongest', () => {
  it('returns empty for empty input', () => {
    expect(computeDailyLongest([], 0)).toEqual([]);
  });

  it('attributes each run to the UTC date of its end', () => {
    // Cross-midnight run: 11pm UTC May 16 → 7am UTC May 17. End-date is May 17.
    const result = computeDailyLongest(
      [
        row('2026-05-16T23:00:00Z', '2026-05-17T02:00:00Z'),
        row('2026-05-17T02:00:00Z', '2026-05-17T07:00:00Z'),
      ],
      0,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.bucket_start).toBe('2026-05-17');
    expect(result[0]?.longest_minutes).toBe(480); // 8 hours
  });

  it('returns one entry per distinct end-date', () => {
    const result = computeDailyLongest(
      [
        // Run ending on May 16
        row('2026-05-16T01:00:00Z', '2026-05-16T08:00:00Z'),
        // Run ending on May 17
        row('2026-05-16T23:00:00Z', '2026-05-17T06:00:00Z'),
      ],
      0,
    );
    expect(result.map((r) => r.bucket_start)).toEqual(['2026-05-16', '2026-05-17']);
    expect(result[0]?.longest_minutes).toBe(420); // 7 hours
    expect(result[1]?.longest_minutes).toBe(420); // 7 hours
  });

  it('picks the longest run per bucket when multiple runs end on the same date', () => {
    const result = computeDailyLongest(
      [
        // First run: 60 min ending May 17 morning
        row('2026-05-17T01:00:00Z', '2026-05-17T02:00:00Z'),
        // Second run: 4 hours ending May 17 evening — longer, wins
        row('2026-05-17T15:00:00Z', '2026-05-17T19:00:00Z'),
      ],
      0,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.longest_minutes).toBe(240);
  });
});
