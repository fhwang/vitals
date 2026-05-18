import { describe, expect, it } from 'vitest';

import { openDatabase } from '#db';

import { updateFrontierAfterTick, writeStateSuccess } from '../state.js';
import {
  buildOuraSleepConfidenceByDate,
  getOuraFreshnessFrontier,
  getOuraSleepDayConfidence,
} from './confidence.js';
import { OURA_ADAPTER_NAME } from './credentials.js';

describe('getOuraSleepDayConfidence', () => {
  it('returns provisional for the current date', () => {
    const now = new Date('2026-05-17T12:00:00Z');
    expect(getOuraSleepDayConfidence(now, '2026-05-17')).toBe('provisional');
  });

  it('returns provisional for yesterday when within 24h of its end', () => {
    // Date is 2026-05-16; the 24h provisional window after the date ends
    // (2026-05-17T00:00Z) extends to 2026-05-18T00:00Z. now is just within.
    const now = new Date('2026-05-17T23:00:00Z');
    expect(getOuraSleepDayConfidence(now, '2026-05-16')).toBe('provisional');
  });

  it('returns confirmed once more than 24h past the date end', () => {
    // 2026-05-16 ends at 2026-05-17T00:00Z; +24h is 2026-05-18T00:00Z.
    // now is past that → confirmed.
    const now = new Date('2026-05-18T01:00:00Z');
    expect(getOuraSleepDayConfidence(now, '2026-05-16')).toBe('confirmed');
  });

  it('returns confirmed for old dates', () => {
    const now = new Date('2026-05-18T01:00:00Z');
    expect(getOuraSleepDayConfidence(now, '2026-01-01')).toBe('confirmed');
  });
});

describe('buildOuraSleepConfidenceByDate', () => {
  it('returns one entry per date in the inclusive range', () => {
    const now = new Date('2026-05-18T12:00:00Z');
    const result = buildOuraSleepConfidenceByDate(now, ['2026-05-16', '2026-05-18']);
    expect(result.map((r) => r.date)).toEqual(['2026-05-16', '2026-05-17', '2026-05-18']);
  });

  it('marks recent dates provisional and older dates confirmed', () => {
    const now = new Date('2026-05-18T12:00:00Z');
    const result = buildOuraSleepConfidenceByDate(now, ['2026-05-10', '2026-05-18']);
    const byDate = Object.fromEntries(result.map((r) => [r.date, r.confidence]));
    expect(byDate['2026-05-10']).toBe('confirmed');
    expect(byDate['2026-05-15']).toBe('confirmed');
    expect(byDate['2026-05-17']).toBe('provisional');
    expect(byDate['2026-05-18']).toBe('provisional');
  });
});

describe('getOuraFreshnessFrontier', () => {
  it('returns null when no successful sync has happened', () => {
    const db = openDatabase(':memory:');
    expect(getOuraFreshnessFrontier(db)).toBeNull();
  });

  it('returns the frontier after a successful sync advances it', () => {
    const db = openDatabase(':memory:');
    writeStateSuccess(db, OURA_ADAPTER_NAME, '2026-05-17T23:59:59Z');
    updateFrontierAfterTick(db, OURA_ADAPTER_NAME, '2026-05-17T07:30:00Z');
    expect(getOuraFreshnessFrontier(db)).toBe('2026-05-17T07:30:00Z');
  });
});
