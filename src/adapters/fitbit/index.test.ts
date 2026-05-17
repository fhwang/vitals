import { describe, expect, it } from 'vitest';

import { openDatabase } from '#db';
import type { Observation } from '#records';
import { MemoryBlobStore } from '#storage';

import type { IntradayResult } from './api.js';
import { FORCE_REFRESH_DAYS, isWithinForceRefreshWindow, lastNDays, pullDays } from './index.js';
import { createFitbitStore } from './storage.js';

describe('lastNDays', () => {
  it('returns the requested number of days ending today (UTC)', () => {
    const today = new Date('2026-04-30T12:00:00Z');
    const days = lastNDays(today, 3);
    expect(days).toEqual(['2026-04-28', '2026-04-29', '2026-04-30']);
  });

  it('handles a window of 1', () => {
    const today = new Date('2026-04-30T12:00:00Z');
    expect(lastNDays(today, 1)).toEqual(['2026-04-30']);
  });

  it('handles month boundaries', () => {
    const today = new Date('2026-05-01T12:00:00Z');
    expect(lastNDays(today, 3)).toEqual(['2026-04-29', '2026-04-30', '2026-05-01']);
  });
});

describe('isWithinForceRefreshWindow', () => {
  it('returns true for each of the last FORCE_REFRESH_DAYS days', () => {
    const today = new Date('2026-04-30T12:00:00Z');
    for (const day of lastNDays(today, FORCE_REFRESH_DAYS)) {
      expect(isWithinForceRefreshWindow(today, day)).toBe(true);
    }
  });

  it('returns false for days older than the window', () => {
    const today = new Date('2026-04-30T12:00:00Z');
    const older = lastNDays(today, FORCE_REFRESH_DAYS + 1)[0]!;
    expect(isWithinForceRefreshWindow(today, older)).toBe(false);
  });
});

const HR_CODING = { system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' } as const;

function sample(date: string, hour: number, minute: number, bpm: number): Observation {
  const stamp = `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
  return {
    coding: { ...HR_CODING },
    date,
    effective_start: stamp,
    effective_end: null,
    value: bpm,
    unit: '/min',
    ref_range: null,
    interpretation: null,
    source_document_key: `fitbit/intraday-hr/${date}.json`,
  };
}

function intradayResultFor(samples: readonly Observation[]): IntradayResult {
  return {
    samples: samples.map((s) => ({
      physical_time: s.effective_start,
      beats_per_minute: typeof s.value === 'number' ? s.value : Number(s.value),
    })),
    raw: samples.map((s) => ({ stamp: s.effective_start, bpm: s.value })),
  };
}

interface FakeFetchTrace {
  calls: string[];
}

function stubFetch(perDay: Record<string, readonly Observation[]>): {
  fetch: (day: string) => Promise<IntradayResult>;
  trace: FakeFetchTrace;
} {
  const trace: FakeFetchTrace = { calls: [] };
  return {
    fetch: (day: string) => {
      trace.calls.push(day);
      return Promise.resolve(intradayResultFor(perDay[day] ?? []));
    },
    trace,
  };
}

// pullDays does the network fetch via the injected stub and writes through
// the real parser, so the test must hand it samples whose `effective_start`
// matches the day under test — `parseFitbitIntradayDay` drops samples whose
// date prefix doesn't match.
describe('pullDays', () => {
  it('refetches days inside the force-refresh window even when previously ingested', async () => {
    const db = openDatabase(':memory:');
    const store = createFitbitStore(db, new MemoryBlobStore());
    const today = new Date('2026-04-30T12:00:00Z');
    const day = '2026-04-30';
    const initial = stubFetch({ [day]: [sample(day, 7, 0, 62)] });
    await pullDays({ store, fetchDay: initial.fetch, today }, [day]);
    const updated = stubFetch({ [day]: [sample(day, 7, 0, 62), sample(day, 8, 0, 64)] });
    const result = await pullDays({ store, fetchDay: updated.fetch, today }, [day]);
    expect(updated.trace.calls).toEqual([day]);
    expect(result.samples_added).toBe(2);
    expect(store.readDayState(day)?.samples_count).toBe(2);
    expect(store.readDayState(day)?.samples_count_prev).toBe(1);
  });

  it('skips ingested days outside the force-refresh window', async () => {
    const db = openDatabase(':memory:');
    const store = createFitbitStore(db, new MemoryBlobStore());
    const today = new Date('2026-04-30T12:00:00Z');
    const olderDay = lastNDays(today, FORCE_REFRESH_DAYS + 1)[0]!;
    const initial = stubFetch({ [olderDay]: [sample(olderDay, 7, 0, 62)] });
    await pullDays({ store, fetchDay: initial.fetch, today }, [olderDay]);
    const refetch = stubFetch({ [olderDay]: [sample(olderDay, 9, 0, 70)] });
    const result = await pullDays({ store, fetchDay: refetch.fetch, today }, [olderDay]);
    expect(refetch.trace.calls).toEqual([]);
    expect(result.days_pulled).toBe(0);
    expect(result.samples_existing).toBe(1);
  });

  it('aggregates max_sample_at across all pulled days', async () => {
    const db = openDatabase(':memory:');
    const store = createFitbitStore(db, new MemoryBlobStore());
    const today = new Date('2026-04-30T12:00:00Z');
    const days = lastNDays(today, 3);
    const [first, second, third] = days as [string, string, string];
    const fetch = stubFetch({
      [first]: [sample(first, 8, 0, 60)],
      [second]: [sample(second, 22, 30, 95)],
      [third]: [sample(third, 7, 15, 70)],
    });
    const result = await pullDays({ store, fetchDay: fetch.fetch, today }, days);
    // Latest sample timestamp wins regardless of which day's samples it came
    // from — third day at 07:15 beats second day at 22:30 because the date is
    // later. Parser normalizes to millisecond precision.
    expect(result.max_sample_at).toBe(`${third}T07:15:00.000Z`);
  });
});
