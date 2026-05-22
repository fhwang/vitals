import type { CodingRegistry, QueryPlanSlot } from '#adapters';
import type { Db } from '#db';

import {
  computeDailyLongest,
  computeLongestRun,
  fetchMatchingPeriods,
  type DailyLongestRow,
  type LongestContinuousNativeQuery,
  type LongestRunResult,
} from './longest-continuous.js';
import type {
  LongestContinuousQuery,
  LongestContinuousResult,
  PeriodDurationMeta,
} from './sqlite-archive.js';

// Orchestrator for getLongestContinuousPeriodInValueRange: routes
// confidence/freshness via the coding registry, fans out the query across
// each per-adapter plan slot, and aggregates the per-slot results into a
// single response. Lives in its own file so sqlite-archive.ts stays under
// the file-length lint cap.

export function buildLongestContinuousResult(
  db: Db,
  codings: CodingRegistry,
  query: LongestContinuousQuery,
): LongestContinuousResult {
  const meta = buildMeta(codings, query);
  const slots = codings.planQuery(query.coding, {
    min: query.min_value,
    max: query.max_value,
  });
  if (query.bucket === 'none') {
    return { ...meta, ...longestAcrossSlotsTotal(db, query, slots) };
  }
  return { ...meta, per_bucket: longestAcrossSlotsDaily(db, query, slots) };
}

function buildMeta(codings: CodingRegistry, query: LongestContinuousQuery): PeriodDurationMeta {
  const provider = codings.getConfidenceProvider(query.coding);
  const now = new Date();
  return {
    confidence_by_date:
      provider?.buildConfidenceByDate(now, [query.start_date, query.end_date]) ?? [],
    freshness_frontier_at: provider?.getFreshnessFrontier() ?? null,
  };
}

function nativeQueryFor(
  query: LongestContinuousQuery,
  slot: QueryPlanSlot,
): LongestContinuousNativeQuery {
  return {
    coding: slot.native_coding,
    start_date: query.start_date,
    end_date: query.end_date,
    min_value: slot.native_value_range.min,
    max_value: slot.native_value_range.max,
    gap_seconds: query.gap_seconds,
  };
}

function longestForSlot(
  db: Db,
  query: LongestContinuousQuery,
  slot: QueryPlanSlot,
): LongestRunResult {
  const rows = fetchMatchingPeriods(db, nativeQueryFor(query, slot));
  return computeLongestRun(rows, query.gap_seconds);
}

function dailyLongestForSlot(
  db: Db,
  query: LongestContinuousQuery,
  slot: QueryPlanSlot,
): readonly DailyLongestRow[] {
  const rows = fetchMatchingPeriods(db, nativeQueryFor(query, slot));
  return computeDailyLongest(rows, query.gap_seconds);
}

function longestAcrossSlotsTotal(
  db: Db,
  query: LongestContinuousQuery,
  slots: readonly QueryPlanSlot[],
): LongestRunResult {
  let best: LongestRunResult = { longest_minutes: 0, longest_start: null, longest_end: null };
  for (const slot of slots) {
    const slotBest = longestForSlot(db, query, slot);
    if (slotBest.longest_minutes > best.longest_minutes) best = slotBest;
  }
  return best;
}

function longestAcrossSlotsDaily(
  db: Db,
  query: LongestContinuousQuery,
  slots: readonly QueryPlanSlot[],
): DailyLongestRow[] {
  const perBucket = new Map<string, DailyLongestRow>();
  for (const slot of slots) {
    for (const row of dailyLongestForSlot(db, query, slot)) {
      mergeDailyRow(perBucket, row);
    }
  }
  return [...perBucket.values()].sort((a, b) => a.bucket_start.localeCompare(b.bucket_start));
}

function mergeDailyRow(perBucket: Map<string, DailyLongestRow>, row: DailyLongestRow): void {
  const existing = perBucket.get(row.bucket_start);
  if (existing === undefined || row.longest_minutes > existing.longest_minutes) {
    perBucket.set(row.bucket_start, row);
  }
}
