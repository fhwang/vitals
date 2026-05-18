import { SYSTEM_LOINC, type Observation } from '#records';

import { SyncError } from '../types.js';
import type { OuraSleepSession } from './api.js';
import {
  OURA_EPOCH_SECONDS,
  OURA_SLEEP_STAGE_CODE,
  OURA_SLEEP_STAGE_SYSTEM,
  OURA_STAGE_CHAR_TO_VALUE,
  type OuraSleepStage,
} from './sleep-stage.js';

// AASM-standard per-session LOINC codings. Sleep efficiency and sleep onset
// latency codes are intentionally omitted from V1 pending direct verification
// against the LOINC database — Oura provides those values, but committing to
// the wrong code is worse than not coding them yet.
const LOINC_TST = '93832-4'; // Sleep duration (total sleep time)
const LOINC_REM_DURATION = '93829-0'; // REM sleep duration
const LOINC_LIGHT_DURATION = '93830-8'; // Light sleep duration
const LOINC_DEEP_DURATION = '93831-6'; // Deep sleep duration
const LOINC_WASO = '103215-0'; // Wake time after sleep onset

const MINUTE_UNIT = 'min';

export type SleepCategory = 'main' | 'nap' | 'rest' | 'other';

export interface ParsedSleepSession {
  session_id: string;
  bedtime_start: string;
  bedtime_end: string;
  end_local_date: string;
  start_tz_offset_minutes: number;
  category: SleepCategory;
  observations: Observation[];
}

// Parse one Oura sleep session response into the observation rows vitals will
// store. The parser is the only place that knows Oura's vocabulary; callers
// receive AASM-standard LOINC observations and Oura-native stage-run
// observations, both keyed to absolute timestamps.
export function parseOuraSleepSession(session: OuraSleepSession): ParsedSleepSession {
  const bedtimeStartMs = parseIsoOrThrow(session.bedtime_start, 'bedtime_start');
  const bedtimeEndMs = parseIsoOrThrow(session.bedtime_end, 'bedtime_end');
  verifyEpochInvariant(session, bedtimeStartMs, bedtimeEndMs);
  const startTzOffsetMinutes = extractOffsetMinutes(session.bedtime_start);
  const endLocalDate = extractLocalDate(session.bedtime_end);
  const category = mapCategory(session.type);

  const stageObservations = parseStageRuns(session.sleep_phase_5_min, bedtimeStartMs, endLocalDate);
  const aggregateObservations = parseAggregates(session, endLocalDate);

  return {
    session_id: session.id,
    bedtime_start: new Date(bedtimeStartMs).toISOString(),
    bedtime_end: new Date(bedtimeEndMs).toISOString(),
    end_local_date: endLocalDate,
    start_tz_offset_minutes: startTzOffsetMinutes,
    category,
    observations: [...stageObservations, ...aggregateObservations],
  };
}

function verifyEpochInvariant(
  session: OuraSleepSession,
  bedtimeStartMs: number,
  bedtimeEndMs: number,
): void {
  const sessionSeconds = (bedtimeEndMs - bedtimeStartMs) / 1000;
  const expectedSeconds = session.sleep_phase_5_min.length * OURA_EPOCH_SECONDS;
  // Tolerance: one full epoch. Oura's session end occasionally lands a few
  // seconds off the epoch boundary; anything larger is a real format break.
  const toleranceSeconds = OURA_EPOCH_SECONDS;
  if (Math.abs(sessionSeconds - expectedSeconds) > toleranceSeconds) {
    throw new SyncError(
      'parse_error',
      `oura: sleep_phase_5_min length × ${OURA_EPOCH_SECONDS}s (${expectedSeconds}s) ` +
        `does not match session duration (${sessionSeconds}s) for session ${session.id}`,
    );
  }
}

interface StageRun {
  value: OuraSleepStage;
  epochStartIndex: number;
  epochCount: number;
}

function stageValueAt(stageString: string, index: number): OuraSleepStage {
  const char = stageString[index];
  const value = char === undefined ? undefined : OURA_STAGE_CHAR_TO_VALUE[char];
  if (value === undefined) {
    throw new SyncError(
      'parse_error',
      `oura: unrecognized stage char '${char ?? ''}' at index ${index}`,
    );
  }
  return value;
}

function collapseStageRuns(stageString: string): StageRun[] {
  const values = Array.from(stageString, (_, i) => stageValueAt(stageString, i));
  return groupConsecutive(values);
}

function groupConsecutive(values: readonly OuraSleepStage[]): StageRun[] {
  const runs: StageRun[] = [];
  for (const [i, value] of values.entries()) {
    const last = runs.at(-1);
    if (last?.value === value) {
      last.epochCount += 1;
      continue;
    }
    runs.push({ value, epochStartIndex: i, epochCount: 1 });
  }
  return runs;
}

function parseStageRuns(
  stageString: string,
  bedtimeStartMs: number,
  endLocalDate: string,
): Observation[] {
  const runs = collapseStageRuns(stageString);
  return runs.map((run) => stageRunToObservation(run, bedtimeStartMs, endLocalDate));
}

function stageRunToObservation(
  run: StageRun,
  bedtimeStartMs: number,
  endLocalDate: string,
): Observation {
  const startMs = bedtimeStartMs + run.epochStartIndex * OURA_EPOCH_SECONDS * 1000;
  const endMs = startMs + run.epochCount * OURA_EPOCH_SECONDS * 1000;
  return {
    coding: {
      system: OURA_SLEEP_STAGE_SYSTEM,
      code: OURA_SLEEP_STAGE_CODE,
      display: 'Oura sleep stage',
    },
    date: endLocalDate,
    effective_start: new Date(startMs).toISOString(),
    effective_end: new Date(endMs).toISOString(),
    value: run.value,
    unit: '{stage}',
    ref_range: null,
    interpretation: null,
    source_document_key: '',
  };
}

// Each tuple is (seconds-value-from-Oura, LOINC code, human display). Tuples
// keep the list-of-aggregate-specs primitive-only so the iteration below
// doesn't need a single-use struct type.
type AggregateTuple = readonly [number | null | undefined, string, string];

function aggregateTuples(session: OuraSleepSession): readonly AggregateTuple[] {
  return [
    [session.total_sleep_duration, LOINC_TST, 'Sleep duration'],
    [session.rem_sleep_duration, LOINC_REM_DURATION, 'REM sleep duration'],
    [session.light_sleep_duration, LOINC_LIGHT_DURATION, 'Light sleep duration'],
    [session.deep_sleep_duration, LOINC_DEEP_DURATION, 'Deep sleep duration'],
    [session.awake_time, LOINC_WASO, 'Wake time after sleep onset'],
  ];
}

function parseAggregates(session: OuraSleepSession, endLocalDate: string): Observation[] {
  const start = new Date(parseIsoOrThrow(session.bedtime_start, 'bedtime_start')).toISOString();
  const end = new Date(parseIsoOrThrow(session.bedtime_end, 'bedtime_end')).toISOString();
  const build = (seconds: number, code: string, display: string): Observation => ({
    coding: { system: SYSTEM_LOINC, code, display },
    date: endLocalDate,
    effective_start: start,
    effective_end: end,
    value: Math.round(seconds / 60),
    unit: MINUTE_UNIT,
    ref_range: null,
    interpretation: null,
    source_document_key: '',
  });
  const out: Observation[] = [];
  for (const [seconds, code, display] of aggregateTuples(session)) {
    if (seconds === null || seconds === undefined) continue;
    out.push(build(seconds, code, display));
  }
  return out;
}

function mapCategory(ouraType: string): SleepCategory {
  switch (ouraType) {
    case 'long_sleep':
    case 'sleep':
      return 'main';
    case 'late_nap':
      return 'nap';
    case 'rest':
      return 'rest';
    default:
      return 'other';
  }
}

function parseIsoOrThrow(iso: string, field: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new SyncError('parse_error', `oura: invalid ISO timestamp in ${field}: ${iso}`);
  }
  return ms;
}

// Pulls the calendar date (YYYY-MM-DD) directly from the local-time portion of
// an offset-bearing ISO string. Oura's `bedtime_end` carries the user's local
// offset (e.g. `2026-05-17T07:30:00-04:00`), so the leading 10 characters are
// already the local date — no UTC conversion needed.
function extractLocalDate(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T/.exec(iso);
  if (match?.[1] === undefined) {
    throw new SyncError('parse_error', `oura: cannot extract local date from ${iso}`);
  }
  return match[1];
}

// Extracts the timezone offset (in minutes east of UTC) from an offset-bearing
// ISO string. `+05:30` → 330; `-04:00` → -240; `Z` → 0.
function extractOffsetMinutes(iso: string): number {
  if (iso.endsWith('Z')) return 0;
  const match = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (match === null) {
    throw new SyncError('parse_error', `oura: cannot extract TZ offset from ${iso}`);
  }
  const sign = match[1] === '+' ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  return sign * (hours * 60 + minutes);
}

export const ARCHIVE_PREFIX = 'oura/sleep/';

export function archiveKeyForSession(sessionId: string): string {
  return `${ARCHIVE_PREFIX}${sessionId}.json.gz`;
}
