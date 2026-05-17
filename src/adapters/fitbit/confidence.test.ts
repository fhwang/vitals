import { describe, expect, it } from 'vitest';

import { openDatabase } from '#db';
import { MemoryBlobStore } from '#storage';

import { updateFrontierAfterTick, writeStateSuccess } from '../state.js';
import { buildConfidenceByDate, getFitbitDayConfidence } from './confidence.js';
import { FORCE_REFRESH_DAYS } from './index.js';
import { createFitbitStore } from './storage.js';

const FITBIT = 'fitbit';

describe('getFitbitDayConfidence', () => {
  it('returns confirmed for dates outside the force-refresh window', () => {
    const db = openDatabase(':memory:');
    const today = new Date('2026-04-30T12:00:00Z');
    expect(getFitbitDayConfidence(db, today, '2026-01-01')).toBe('confirmed');
  });

  it('returns provisional inside the window when no frontier has been written', () => {
    const db = openDatabase(':memory:');
    const today = new Date('2026-04-30T12:00:00Z');
    expect(getFitbitDayConfidence(db, today, '2026-04-30')).toBe('provisional');
  });

  it('returns provisional inside the window when the frontier has not passed day+36h', () => {
    const db = openDatabase(':memory:');
    writeStateSuccess(db, FITBIT, '2026-04-30T23:59:59Z');
    // Date 2026-04-29 needs frontier ≥ 2026-04-30T12:00:00Z. Setting frontier
    // to 2026-04-30T08:00:00Z is earlier than the buffer → still provisional.
    updateFrontierAfterTick(db, FITBIT, '2026-04-30T08:00:00Z');
    const today = new Date('2026-04-30T12:00:00Z');
    expect(getFitbitDayConfidence(db, today, '2026-04-29')).toBe('provisional');
  });

  it('returns provisional when the frontier has passed but no day-state row exists', () => {
    const db = openDatabase(':memory:');
    writeStateSuccess(db, FITBIT, '2026-04-30T23:59:59Z');
    updateFrontierAfterTick(db, FITBIT, '2026-04-30T15:00:00Z');
    const today = new Date('2026-04-30T18:00:00Z');
    expect(getFitbitDayConfidence(db, today, '2026-04-29')).toBe('provisional');
  });

  it('returns provisional on the first pull (samples_count_prev is null)', () => {
    const db = openDatabase(':memory:');
    const store = createFitbitStore(db, new MemoryBlobStore());
    writeStateSuccess(db, FITBIT, '2026-04-30T23:59:59Z');
    updateFrontierAfterTick(db, FITBIT, '2026-04-30T15:00:00Z');
    store.writeDayState('2026-04-29', 1000);
    const today = new Date('2026-04-30T18:00:00Z');
    expect(getFitbitDayConfidence(db, today, '2026-04-29')).toBe('provisional');
  });

  it('returns provisional when sample count keeps changing', () => {
    const db = openDatabase(':memory:');
    const store = createFitbitStore(db, new MemoryBlobStore());
    writeStateSuccess(db, FITBIT, '2026-04-30T23:59:59Z');
    updateFrontierAfterTick(db, FITBIT, '2026-04-30T15:00:00Z');
    store.writeDayState('2026-04-29', 1000);
    store.writeDayState('2026-04-29', 1050);
    const today = new Date('2026-04-30T18:00:00Z');
    expect(getFitbitDayConfidence(db, today, '2026-04-29')).toBe('provisional');
  });

  it('returns confirmed when frontier has passed AND sample count has stabilized', () => {
    const db = openDatabase(':memory:');
    const store = createFitbitStore(db, new MemoryBlobStore());
    writeStateSuccess(db, FITBIT, '2026-04-30T23:59:59Z');
    updateFrontierAfterTick(db, FITBIT, '2026-04-30T15:00:00Z');
    store.writeDayState('2026-04-29', 1000);
    store.writeDayState('2026-04-29', 1000);
    const today = new Date('2026-04-30T18:00:00Z');
    expect(getFitbitDayConfidence(db, today, '2026-04-29')).toBe('confirmed');
  });
});

describe('buildConfidenceByDate', () => {
  it('returns one entry per date in the inclusive range', () => {
    const db = openDatabase(':memory:');
    const today = new Date('2026-04-30T12:00:00Z');
    const result = buildConfidenceByDate(db, today, ['2026-04-28', '2026-04-30']);
    expect(result.map((r) => r.date)).toEqual(['2026-04-28', '2026-04-29', '2026-04-30']);
  });

  it('marks recent dates provisional and older dates confirmed by default', () => {
    const db = openDatabase(':memory:');
    const today = new Date('2026-04-30T12:00:00Z');
    expect(FORCE_REFRESH_DAYS).toBe(5);
    const result = buildConfidenceByDate(db, today, ['2026-04-20', '2026-04-30']);
    const byDate = Object.fromEntries(result.map((r) => [r.date, r.confidence]));
    expect(byDate['2026-04-20']).toBe('confirmed');
    expect(byDate['2026-04-25']).toBe('confirmed');
    expect(byDate['2026-04-30']).toBe('provisional');
  });
});
