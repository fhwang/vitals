import { describe, expect, it } from 'vitest';

import { SYSTEM_LOINC } from '#records';
import type { IntradayResult } from './api.js';
import { parseFitbitIntradayDay } from './parser.js';

function build(samples: { physical_time: string; beats_per_minute: number }[]): IntradayResult {
  return { samples, raw: [] };
}

describe('parseFitbitIntradayDay', () => {
  it('returns an empty array when there are no samples', () => {
    expect(parseFitbitIntradayDay('2026-05-02', build([]))).toEqual([]);
  });

  it('emits one observation per sample with HR coding and unit', () => {
    const obs = parseFitbitIntradayDay(
      '2026-05-02',
      build([
        { physical_time: '2026-05-02T10:00:00Z', beats_per_minute: 72 },
        { physical_time: '2026-05-02T10:00:15Z', beats_per_minute: 75 },
      ]),
    );
    expect(obs).toHaveLength(2);
    expect(obs[0]?.coding).toEqual({
      system: SYSTEM_LOINC,
      code: '8867-4',
      display: 'Heart rate',
    });
    expect(obs[0]?.unit).toBe('/min');
    expect(obs[0]?.date).toBe('2026-05-02');
    expect(obs[0]?.value).toBe(72);
  });

  it('synthesizes intervals: each sample ends at the next sample (when gap <= 90s)', () => {
    const obs = parseFitbitIntradayDay(
      '2026-05-02',
      build([
        { physical_time: '2026-05-02T10:00:00Z', beats_per_minute: 100 },
        { physical_time: '2026-05-02T10:00:15Z', beats_per_minute: 105 },
        { physical_time: '2026-05-02T10:01:00Z', beats_per_minute: 110 },
      ]),
    );
    expect(obs[0]?.effective_start).toBe('2026-05-02T10:00:00.000Z');
    expect(obs[0]?.effective_end).toBe('2026-05-02T10:00:15.000Z');
    expect(obs[1]?.effective_start).toBe('2026-05-02T10:00:15.000Z');
    expect(obs[1]?.effective_end).toBe('2026-05-02T10:01:00.000Z');
  });

  it('caps at 60s when the gap to the next sample exceeds 90s', () => {
    const obs = parseFitbitIntradayDay(
      '2026-05-02',
      build([
        { physical_time: '2026-05-02T10:00:00Z', beats_per_minute: 70 },
        { physical_time: '2026-05-02T11:00:00Z', beats_per_minute: 80 },
      ]),
    );
    expect(obs[0]?.effective_end).toBe('2026-05-02T10:01:00.000Z');
    expect(obs[1]?.effective_end).toBe('2026-05-02T11:01:00.000Z');
  });

  it('treats a gap of exactly 90s as within the cap (end at next)', () => {
    const obs = parseFitbitIntradayDay(
      '2026-05-02',
      build([
        { physical_time: '2026-05-02T10:00:00Z', beats_per_minute: 70 },
        { physical_time: '2026-05-02T10:01:30Z', beats_per_minute: 80 },
      ]),
    );
    expect(obs[0]?.effective_end).toBe('2026-05-02T10:01:30.000Z');
  });

  it('uses a 60s default end for the last sample of the day', () => {
    const obs = parseFitbitIntradayDay(
      '2026-05-02',
      build([{ physical_time: '2026-05-02T23:59:00Z', beats_per_minute: 60 }]),
    );
    expect(obs[0]?.effective_start).toBe('2026-05-02T23:59:00.000Z');
    expect(obs[0]?.effective_end).toBe('2026-05-03T00:00:00.000Z');
  });

  it('sorts out-of-order input ascending before computing intervals', () => {
    const obs = parseFitbitIntradayDay(
      '2026-05-02',
      build([
        { physical_time: '2026-05-02T10:00:30Z', beats_per_minute: 75 },
        { physical_time: '2026-05-02T10:00:00Z', beats_per_minute: 72 },
      ]),
    );
    expect(obs[0]?.effective_start).toBe('2026-05-02T10:00:00.000Z');
    expect(obs[0]?.value).toBe(72);
    expect(obs[0]?.effective_end).toBe('2026-05-02T10:00:30.000Z');
  });
});
