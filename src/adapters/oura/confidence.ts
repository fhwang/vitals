import type { Db } from '#db';

import { enumerateDates, type ConfidenceByDate, type ConfidenceProvider } from '../confidence.js';
import { readState } from '../state.js';
import { OURA_ADAPTER_NAME } from './credentials.js';

// Sleep confidence rule (see design doc, section "Confidence model"):
//
//   provisional if end_local_date is within 24h of `now`
//   confirmed   otherwise
//
// Pure time-based — does not consider session presence. Reason: a
// session-presence rule would mark dates with no recorded sleep (user took
// the ring off) as permanently provisional, leaving the harness unable to
// distinguish "still arriving" from "no data, finalized." After 24h every
// date settles regardless of whether data exists.

const PROVISIONAL_WINDOW_HOURS = 24;

export function getOuraSleepDayConfidence(now: Date, date: string): 'confirmed' | 'provisional' {
  const dateEndMs = new Date(`${date}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000;
  const provisionalUntilMs = dateEndMs + PROVISIONAL_WINDOW_HOURS * 60 * 60 * 1000;
  return now.getTime() < provisionalUntilMs ? 'provisional' : 'confirmed';
}

export function buildOuraSleepConfidenceByDate(
  now: Date,
  range: readonly [string, string],
): ConfidenceByDate[] {
  const [startDate, endDate] = range;
  return enumerateDates(startDate, endDate).map((date) => ({
    date,
    confidence: getOuraSleepDayConfidence(now, date),
  }));
}

export function getOuraFreshnessFrontier(db: Db): string | null {
  const state = readState(db, OURA_ADAPTER_NAME);
  return state.status === 'success' ? state.freshness_frontier_at : null;
}

export function createOuraConfidenceProvider(db: Db): ConfidenceProvider {
  return {
    buildConfidenceByDate: (now, dateRange) => buildOuraSleepConfidenceByDate(now, dateRange),
    getFreshnessFrontier: () => getOuraFreshnessFrontier(db),
  };
}
