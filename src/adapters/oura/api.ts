import { z } from 'zod';

import { SyncError } from '../types.js';

const SLEEP_URL = 'https://api.ouraring.com/v2/usercollection/sleep';

// Oura's sleep session response shape. Includes only the fields vitals uses;
// extra fields are ignored. Verified against
// https://cloud.ouraring.com/v2/docs as of the design date (2026-05-18).
const OuraSleepSessionSchema = z.object({
  id: z.string(),
  day: z.string(),
  bedtime_start: z.string(),
  bedtime_end: z.string(),
  type: z.string(),
  sleep_phase_5_min: z.string(),
  total_sleep_duration: z.number().int().nonnegative().nullable().optional(),
  time_in_bed: z.number().int().nonnegative().nullable().optional(),
  awake_time: z.number().int().nonnegative().nullable().optional(),
  latency: z.number().int().nonnegative().nullable().optional(),
  efficiency: z.number().nullable().optional(),
  rem_sleep_duration: z.number().int().nonnegative().nullable().optional(),
  light_sleep_duration: z.number().int().nonnegative().nullable().optional(),
  deep_sleep_duration: z.number().int().nonnegative().nullable().optional(),
});

const OuraSleepResponseSchema = z.object({
  data: z.array(OuraSleepSessionSchema),
  next_token: z.string().nullable().optional(),
});

export type OuraSleepSession = z.infer<typeof OuraSleepSessionSchema>;

export interface OuraSleepFetchResult {
  sessions: OuraSleepSession[];
  raw: unknown;
}

export type OuraFetcher = (startDate: string, endDate: string) => Promise<OuraSleepFetchResult>;

export function buildOuraFetcher(accessToken: string): OuraFetcher {
  return (startDate, endDate) => fetchOuraSleep(accessToken, startDate, endDate);
}

async function fetchOuraSleep(
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<OuraSleepFetchResult> {
  const url = sleepUrl(startDate, endDate);
  const response = await sendRequest(url, accessToken);
  if (!response.ok) {
    const body = await safeReadBody(response);
    throw classifyHttpError(response.status, body);
  }
  const raw = await readJson(response);
  return parseSleepResponse(raw);
}

function sleepUrl(startDate: string, endDate: string): string {
  return `${SLEEP_URL}?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`;
}

async function sendRequest(url: string, accessToken: string): Promise<Response> {
  try {
    return await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (err) {
    throw new SyncError('transient', `oura: network error: ${String(err)}`);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (err) {
    throw new SyncError('parse_error', `oura: invalid JSON: ${String(err)}`);
  }
}

function parseSleepResponse(raw: unknown): OuraSleepFetchResult {
  const parsed = OuraSleepResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SyncError(
      'parse_error',
      `oura: response did not match schema: ${parsed.error.message}`,
    );
  }
  return { sessions: parsed.data.data, raw };
}

function classifyHttpError(status: number, body: string): SyncError {
  if (status === 401 || status === 403) {
    return new SyncError('reauth_required', `oura: token rejected (HTTP ${status}): ${body}`);
  }
  if (status === 429 || status >= 500) {
    return new SyncError('transient', `oura: HTTP ${status}: ${body}`);
  }
  return new SyncError('parse_error', `oura: HTTP ${status}: ${body}`);
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
