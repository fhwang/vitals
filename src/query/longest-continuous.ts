import { and, asc, between, eq, gte, lte, sql } from 'drizzle-orm';

import { observations, type Db } from '#db';
import type { Coding } from '#records';

// Query a single coding's observations, sorted by effective_start, that fall
// in the value range and have effective_end set. Used by the longest-
// continuous-period algorithm; per-slot queries thread through this helper.

export interface MatchingPeriodRow {
  effective_start: string;
  effective_end: string;
}

export interface LongestRunResult {
  longest_minutes: number;
  longest_start: string | null;
  longest_end: string | null;
}

export interface DailyLongestRow {
  bucket_start: string;
  longest_minutes: number;
  longest_start: string;
  longest_end: string;
}

export interface LongestContinuousNativeQuery {
  coding: Coding;
  start_date: string;
  end_date: string;
  min_value: number;
  max_value: number;
  gap_seconds: number;
}

export function fetchMatchingPeriods(
  db: Db,
  query: LongestContinuousNativeQuery,
): MatchingPeriodRow[] {
  return db
    .select({
      effective_start: observations.effective_start,
      effective_end: observations.effective_end,
    })
    .from(observations)
    .where(
      and(
        eq(observations.coding_system, query.coding.system),
        eq(observations.coding_code, query.coding.code),
        sql`${observations.effective_end} IS NOT NULL`,
        gte(observations.effective_start, `${query.start_date}T00:00:00Z`),
        lte(observations.effective_start, `${query.end_date}T23:59:59Z`),
        between(observations.value_quantity, query.min_value, query.max_value),
      ),
    )
    .orderBy(asc(observations.effective_start))
    .all() as MatchingPeriodRow[];
}

// Walks chronologically-sorted matching period observations and finds the
// longest contiguous run, where two adjacent observations are considered
// part of the same run if (next.start - prev.end) <= gap_seconds.
//
// `gap_seconds=0` enforces strict adjacency (the sleep-stage case: run-length
// encoded epoch observations are always tight by construction).
export function computeLongestRun(
  rows: readonly MatchingPeriodRow[],
  gapSeconds: number,
): LongestRunResult {
  let best: LongestRunResult = { longest_minutes: 0, longest_start: null, longest_end: null };
  let currentStart: string | null = null;
  let currentEnd: string | null = null;
  for (const row of rows) {
    if (currentEnd === null || gapBetween(currentEnd, row.effective_start) > gapSeconds) {
      [currentStart, currentEnd] = startRunFrom(row);
    } else {
      currentEnd = laterIso(currentEnd, row.effective_end);
    }
    best = preferLonger(best, currentStart, currentEnd);
  }
  return best;
}

function preferLonger(
  best: LongestRunResult,
  start: string | null,
  end: string | null,
): LongestRunResult {
  if (start === null || end === null) return best;
  const minutes = minutesBetween(start, end);
  if (minutes <= best.longest_minutes) return best;
  return { longest_minutes: minutes, longest_start: start, longest_end: end };
}

function gapBetween(prevEnd: string, nextStart: string): number {
  return (Date.parse(nextStart) - Date.parse(prevEnd)) / 1000;
}

function minutesBetween(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / 60000;
}

function laterIso(a: string, b: string): string {
  return b > a ? b : a;
}

// Per-bucket longest: walks the same chronological list, but attributes each
// completed run to the UTC calendar date of the run's end. (TZ-aware "local
// end date" attribution would require carrying the offset on each observation
// row, which V1 does not — see design doc, section "Confidence model".)
export function computeDailyLongest(
  rows: readonly MatchingPeriodRow[],
  gapSeconds: number,
): DailyLongestRow[] {
  const perBucket = new Map<string, LongestRunResult>();
  recordRunsByBucket(rows, gapSeconds, perBucket);
  return finalizeDailyLongest(perBucket);
}

function recordRunsByBucket(
  rows: readonly MatchingPeriodRow[],
  gapSeconds: number,
  perBucket: Map<string, LongestRunResult>,
): void {
  let currentStart: string | null = null;
  let currentEnd: string | null = null;
  for (const row of rows) {
    if (currentEnd === null || gapBetween(currentEnd, row.effective_start) > gapSeconds) {
      flushRun(perBucket, currentStart, currentEnd);
      [currentStart, currentEnd] = startRunFrom(row);
      continue;
    }
    currentEnd = laterIso(currentEnd, row.effective_end);
  }
  flushRun(perBucket, currentStart, currentEnd);
}

function startRunFrom(row: MatchingPeriodRow): readonly [string, string] {
  return [row.effective_start, row.effective_end];
}

function flushRun(
  perBucket: Map<string, LongestRunResult>,
  start: string | null,
  end: string | null,
): void {
  if (start === null || end === null) return;
  const bucket = end.slice(0, 10);
  const existing = perBucket.get(bucket) ?? {
    longest_minutes: 0,
    longest_start: null,
    longest_end: null,
  };
  perBucket.set(bucket, preferLonger(existing, start, end));
}

function finalizeDailyLongest(perBucket: Map<string, LongestRunResult>): DailyLongestRow[] {
  return [...perBucket.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([, run]) => run.longest_start !== null && run.longest_end !== null)
    .map(([bucket_start, run]) => ({
      bucket_start,
      longest_minutes: run.longest_minutes,
      longest_start: run.longest_start ?? '',
      longest_end: run.longest_end ?? '',
    }));
}
