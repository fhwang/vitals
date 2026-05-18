import type { Db } from '#db';

import {
  enumerateDates,
  type ConfidenceByDate,
  type ConfidenceProvider,
  type DayConfidence,
} from '../confidence.js';
import { readState } from '../state.js';
import { isWithinForceRefreshWindow } from './index.js';
import { readFitbitDayState } from './storage.js';

const FITBIT_NAME = 'fitbit';

// A day's data is `confirmed` only when (a) the day is outside the force-refresh
// window (we won't be re-pulling it), OR (b) the freshness frontier has moved
// well past the day's end AND the last two pulls returned the same sample
// count (stability check). Anything else is `provisional`.
//
// The day-end buffer is 12 hours past the start of the following day — i.e.,
// noon UTC the next day. Picked so that a sync that runs early in the morning
// after a busy late-night workout still has a chance to see the trailing data
// before the day flips to `confirmed`.
const DAY_END_BUFFER_HOURS = 36;

export function getFitbitDayConfidence(db: Db, today: Date, date: string): DayConfidence {
  if (!isWithinForceRefreshWindow(today, date)) return 'confirmed';
  const state = readState(db, FITBIT_NAME);
  if (state.status !== 'success') return 'provisional';
  if (state.freshness_frontier_at === null) return 'provisional';
  if (state.freshness_frontier_at < dayConfidenceThreshold(date)) return 'provisional';
  const dayState = readFitbitDayState(db, date);
  if (dayState === null) return 'provisional';
  if (dayState.samples_count_prev === null) return 'provisional';
  if (dayState.samples_count !== dayState.samples_count_prev) return 'provisional';
  return 'confirmed';
}

function dayConfidenceThreshold(date: string): string {
  const start = new Date(`${date}T00:00:00Z`);
  start.setUTCHours(start.getUTCHours() + DAY_END_BUFFER_HOURS);
  return start.toISOString();
}

// Returns one entry per date in [range[0], range[1]] (inclusive). Useful for
// query responses that need to tell the caller "this date's data is/isn't
// settled yet" for every day in the requested window — including days the
// query itself returned no rows for, since "zero matching observations" can
// mean either "nothing happened" or "data hasn't arrived yet."
//
// `range` is a [startDate, endDate] tuple (primitive bundle, per CLAUDE.md's
// guidance on avoiding inline object shapes for low-arity bundles).
export function buildFitbitConfidenceByDate(
  db: Db,
  today: Date,
  range: readonly [string, string],
): ConfidenceByDate[] {
  const [startDate, endDate] = range;
  return enumerateDates(startDate, endDate).map((date) => ({
    date,
    confidence: getFitbitDayConfidence(db, today, date),
  }));
}

export function getFitbitFreshnessFrontier(db: Db): string | null {
  const state = readState(db, FITBIT_NAME);
  return state.status === 'success' ? state.freshness_frontier_at : null;
}

// Per-coding ConfidenceProvider implementation for Fitbit-sourced observations.
// The query layer's confidence routing looks this up for codings produced by
// Fitbit (today: intraday heart rate via LOINC 8867-4).
export function createFitbitConfidenceProvider(db: Db): ConfidenceProvider {
  return {
    buildConfidenceByDate: (now, dateRange) => buildFitbitConfidenceByDate(db, now, dateRange),
    getFreshnessFrontier: () => getFitbitFreshnessFrontier(db),
  };
}
