import { z } from 'zod';

import type { TokenSet } from '../credentials.js';
import type { GoogleHealthAuthConfig } from '../googlehealth/auth-config.js';
import { SyncError } from '../types.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DATAPOINTS_URL = 'https://health.googleapis.com/v4/users/me/dataTypes/heart-rate/dataPoints';
const PAGE_SIZE = 10000;
const HR_FILTER_FIELD = 'heart_rate.sample_time.physical_time';

export interface HeartRateSample {
  physical_time: string;
  beats_per_minute: number;
}

export interface IntradayResult {
  samples: HeartRateSample[];
  raw: unknown[];
}

const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
});

const HeartRateDataPointSchema = z.object({
  heartRate: z.object({
    sampleTime: z.object({ physicalTime: z.string() }),
    beatsPerMinute: z.union([z.string(), z.number()]),
  }),
});

const DataPointsResponseSchema = z.object({
  dataPoints: z.array(HeartRateDataPointSchema).optional(),
  nextPageToken: z.string().optional(),
});

function classifyHttpError(status: number, body: string): SyncError {
  if (status === 401) {
    return new SyncError('reauth_required', `Google Health returned 401: ${body}`);
  }
  if (status === 429 || status >= 500) {
    return new SyncError('transient', `Google Health returned ${status}: ${body}`);
  }
  return new SyncError('parse_error', `Google Health returned ${status}: ${body}`);
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function postTokenRequest(
  config: GoogleHealthAuthConfig,
  refreshToken: string,
): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.client_id,
    client_secret: config.client_secret,
  });
  try {
    return await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    throw new SyncError('transient', `Google token refresh network error: ${String(err)}`);
  }
}

export async function refreshGoogleHealthToken(
  config: GoogleHealthAuthConfig,
  refreshToken: string,
): Promise<TokenSet> {
  const response = await postTokenRequest(config, refreshToken);
  if (!response.ok) {
    throw classifyHttpError(response.status, await readBody(response));
  }
  const raw: unknown = await response.json();
  const parsed = TokenResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SyncError('parse_error', `Google token response unexpected: ${parsed.error.message}`);
  }
  return {
    access_token: parsed.data.access_token,
    refresh_token: refreshToken,
    expires_at: new Date(Date.now() + parsed.data.expires_in * 1000).toISOString(),
  };
}

function nextDay(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return new Date(ms + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

function buildDataPointsUrl(date: string, pageToken: string | null): string {
  const filter =
    `${HR_FILTER_FIELD} >= "${date}T00:00:00Z" AND ` +
    `${HR_FILTER_FIELD} < "${nextDay(date)}T00:00:00Z"`;
  const params = new URLSearchParams({ pageSize: String(PAGE_SIZE), filter });
  if (pageToken !== null) params.set('pageToken', pageToken);
  return `${DATAPOINTS_URL}?${params.toString()}`;
}

async function fetchPage(accessToken: string, url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (err) {
    throw new SyncError('transient', `Google Health network error: ${String(err)}`);
  }
  if (!response.ok) {
    throw classifyHttpError(response.status, await readBody(response));
  }
  return response.json();
}

function extractSamples(parsed: z.infer<typeof DataPointsResponseSchema>): HeartRateSample[] {
  if (parsed.dataPoints === undefined) return [];
  const samples: HeartRateSample[] = [];
  for (const dp of parsed.dataPoints) {
    const rawBpm = dp.heartRate.beatsPerMinute;
    const bpm = typeof rawBpm === 'number' ? rawBpm : Number.parseInt(rawBpm, 10);
    if (!Number.isInteger(bpm)) continue;
    samples.push({
      physical_time: dp.heartRate.sampleTime.physicalTime,
      beats_per_minute: bpm,
    });
  }
  return samples;
}

function nextPageTokenOf(parsed: z.infer<typeof DataPointsResponseSchema>): string | null {
  const tok = parsed.nextPageToken;
  return tok !== undefined && tok !== '' ? tok : null;
}

async function fetchAndParsePage(
  accessToken: string,
  url: string,
): Promise<[HeartRateSample[], unknown, string | null]> {
  const json = await fetchPage(accessToken, url);
  const parsed = DataPointsResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new SyncError(
      'parse_error',
      `Google Health dataPoints response shape unexpected: ${parsed.error.message}`,
    );
  }
  return [extractSamples(parsed.data), json, nextPageTokenOf(parsed.data)];
}

export async function fetchIntradayHeartRate(
  accessToken: string,
  date: string,
): Promise<IntradayResult> {
  const samples: HeartRateSample[] = [];
  const raw: unknown[] = [];
  let pageToken: string | null = null;
  do {
    const url = buildDataPointsUrl(date, pageToken);
    const [pageSamples, pageRaw, nextToken] = await fetchAndParsePage(accessToken, url);
    samples.push(...pageSamples);
    raw.push(pageRaw);
    pageToken = nextToken;
  } while (pageToken !== null);
  return { samples, raw };
}
