import { SYSTEM_LOINC, type Observation } from '#records';
import type { HeartRateSample, IntradayResult } from './api.js';

const HR_CODE = '8867-4';
const HR_DISPLAY = 'Heart rate';
const HR_UNIT = '/min';
const DEFAULT_INTERVAL_SECONDS = 60;
const GAP_CAP_SECONDS = 90;

// Google Health heart-rate dataPoints are sample-shaped (point timestamps), not
// interval-shaped. We synthesize intervals: each sample covers up to its
// successor's timestamp, capped at 90s. A gap >90s means the device stopped
// reporting (off-wrist, dead battery), so we attribute only the default 60s
// to the sample and leave the rest unattributed.
export function parseFitbitIntradayDay(date: string, result: IntradayResult): Observation[] {
  const sorted = [...result.samples].sort((a, b) => a.physical_time.localeCompare(b.physical_time));
  return sorted.map((sample, i) => sampleToObservation(date, sample, sorted[i + 1]));
}

function sampleToObservation(
  date: string,
  sample: HeartRateSample,
  next: HeartRateSample | undefined,
): Observation {
  const start = normalizeIso(sample.physical_time);
  const nextStart = next === undefined ? undefined : normalizeIso(next.physical_time);
  return {
    coding: { system: SYSTEM_LOINC, code: HR_CODE, display: HR_DISPLAY },
    date,
    effective_start: start,
    effective_end: computeEnd(start, nextStart),
    value: sample.beats_per_minute,
    unit: HR_UNIT,
    ref_range: null,
    interpretation: null,
    source_document_key: '',
  };
}

function computeEnd(start: string, nextStart: string | undefined): string {
  if (nextStart === undefined) return addSeconds(start, DEFAULT_INTERVAL_SECONDS);
  const gapSeconds = (Date.parse(nextStart) - Date.parse(start)) / 1000;
  if (gapSeconds <= GAP_CAP_SECONDS) return nextStart;
  return addSeconds(start, DEFAULT_INTERVAL_SECONDS);
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function normalizeIso(iso: string): string {
  return new Date(Date.parse(iso)).toISOString();
}
