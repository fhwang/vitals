import { z } from 'zod';

import {
  GOOGLE_HEALTH_CREDENTIALS_KEY,
  type GoogleHealthAuthConfig,
} from '../googlehealth/auth-config.js';
import { refreshAccessTokenAtomic } from '../oauth.js';
import {
  updateFrontierAfterTick,
  writeStateError,
  writeStateSuccess,
  type SyncErrorRecord,
} from '../state.js';
import type { Adapter, AdapterContext, SyncResult } from '../types.js';
import { SyncError } from '../types.js';
import { fetchIntradayHeartRate, refreshGoogleHealthToken, type IntradayResult } from './api.js';
import { parseFitbitIntradayDay } from './parser.js';
import type { FitbitDayInsertion, FitbitStore } from './storage.js';
import { createFitbitStore } from './storage.js';

const FITBIT_NAME = 'fitbit';

// Recent days are force-refreshed every sync so late-arriving samples (data
// that propagated from phone → Fitbit cloud → Google after a prior partial
// pull) get picked up. Older days inside the outer window use the
// skip-if-ingested fast path so historical data isn't rewritten on every tick.
export const FORCE_REFRESH_DAYS = 5;

export const FitbitParameterSchema = z.object({
  window_days: z.number().int().min(1).max(31).default(8),
});

export type FitbitParameters = z.infer<typeof FitbitParameterSchema>;

export type FetchDay = (day: string) => Promise<IntradayResult>;

export function lastNDays(today: Date, windowDays: number): string[] {
  const days: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

// A day is within the force-refresh window if it is among the last
// FORCE_REFRESH_DAYS dates ending today (inclusive). Older days in the outer
// pull window use skip-if-ingested.
export function isWithinForceRefreshWindow(today: Date, day: string): boolean {
  const forceRefresh = new Set(lastNDays(today, FORCE_REFRESH_DAYS));
  return forceRefresh.has(day);
}

export const FITBIT_NOTIFICATION_PROFILE = {
  display_name: 'Fitbit',
  auth_failure_body:
    'Google Health rejected the access token. Run pnpm connect:googlehealth to renew it.',
  frontier_stuck_body:
    'No new Fitbit samples have arrived in ~48 hours. Open the Fitbit app on your phone to flush pending data.',
} as const;

export function buildFitbitAdapter(config: GoogleHealthAuthConfig): Adapter {
  return {
    name: FITBIT_NAME,
    description:
      'Sync Fitbit heart-rate samples (intraday, native sample resolution) for a recent window of days. Uses Google Health API.',
    parameter_schema: FitbitParameterSchema,
    requires_auth: true,
    notification_profile: FITBIT_NOTIFICATION_PROFILE,
    sync: async (params: unknown, ctx: AdapterContext): Promise<SyncResult> => {
      const parsed = FitbitParameterSchema.parse(params);
      try {
        return await runFitbitSync(config, parsed, ctx);
      } catch (err) {
        writeStateError(ctx.db, FITBIT_NAME, toErrorRecord(err));
        throw err;
      }
    },
  };
}

function toErrorRecord(err: unknown): SyncErrorRecord {
  if (err instanceof SyncError) {
    return { message: err.message, reason: err.reason };
  }
  return { message: err instanceof Error ? err.message : String(err), reason: null };
}

async function runFitbitSync(
  config: GoogleHealthAuthConfig,
  params: FitbitParameters,
  ctx: AdapterContext,
): Promise<SyncResult> {
  const tokens = await refreshAccessTokenAtomic(ctx.db, GOOGLE_HEALTH_CREDENTIALS_KEY, (rt) =>
    refreshGoogleHealthToken(config, rt),
  );
  const today = new Date();
  const days = lastNDays(today, params.window_days);
  const lastDay = days.at(-1);
  if (lastDay === undefined) throw new SyncError('parse_error', 'window_days produced no dates');
  const pullCtx: PullContext = {
    store: createFitbitStore(ctx.db, ctx.store),
    today,
    fetchDay: (day) => fetchIntradayHeartRate(tokens.access_token, day),
  };
  const result = await pullDays(pullCtx, days);
  writeStateSuccess(ctx.db, FITBIT_NAME, `${lastDay}T23:59:59Z`);
  updateFrontierAfterTick(ctx.db, FITBIT_NAME, result.max_sample_at);
  return { adapter: FITBIT_NAME, ...toSyncResult(result) };
}

function toSyncResult(
  result: PullDaysResult,
): Pick<SyncResult, 'days_pulled' | 'samples_added' | 'samples_existing' | 'last_synced_at'> {
  return {
    days_pulled: result.days_pulled,
    samples_added: result.samples_added,
    samples_existing: result.samples_existing,
    last_synced_at: new Date().toISOString(),
  };
}

export interface PullContext {
  store: FitbitStore;
  fetchDay: FetchDay;
  today: Date;
}

export interface PullDaysResult {
  days_pulled: number;
  samples_added: number;
  samples_existing: number;
  max_sample_at: string | null;
}

const EMPTY_PULL_RESULT: PullDaysResult = {
  days_pulled: 0,
  samples_added: 0,
  samples_existing: 0,
  max_sample_at: null,
};

export async function pullDays(ctx: PullContext, days: readonly string[]): Promise<PullDaysResult> {
  let result: PullDaysResult = EMPTY_PULL_RESULT;
  for (const day of days) {
    result = mergeInsertion(result, await pullDay(ctx, day));
  }
  return result;
}

function mergeInsertion(acc: PullDaysResult, insertion: FitbitDayInsertion | null): PullDaysResult {
  if (insertion === null) {
    return { ...acc, samples_existing: acc.samples_existing + 1 };
  }
  return {
    days_pulled: acc.days_pulled + 1,
    samples_added: acc.samples_added + insertion.samples_added,
    samples_existing: acc.samples_existing,
    max_sample_at: laterTimestamp(acc.max_sample_at, insertion.max_sample_at),
  };
}

function laterTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return b > a ? b : a;
}

// Pulls one day. Within FORCE_REFRESH_DAYS of today: always re-fetch and
// drop-replace any existing ingestion (late-arriving samples are picked up).
// Outside that window: skip if already ingested (historical data is immutable
// in practice). Returns null when the day was skipped.
async function pullDay(ctx: PullContext, day: string): Promise<FitbitDayInsertion | null> {
  const forceRefresh = isWithinForceRefreshWindow(ctx.today, day);
  if (!forceRefresh && ctx.store.alreadyIngested(day)) return null;
  const result = await ctx.fetchDay(day);
  const observations = parseFitbitIntradayDay(day, result);
  if (forceRefresh) ctx.store.dropDay(day);
  const insertion = await ctx.store.insertDay(day, result.raw, observations);
  ctx.store.writeDayState(day, insertion.samples_added);
  return insertion;
}
