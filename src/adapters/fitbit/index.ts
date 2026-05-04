import { z } from 'zod';

import {
  GOOGLE_HEALTH_CREDENTIALS_KEY,
  type GoogleHealthAuthConfig,
} from '../googlehealth/auth-config.js';
import { refreshAccessTokenAtomic } from '../oauth.js';
import { writeStateError, writeStateSuccess } from '../state.js';
import type { Adapter, AdapterContext, SyncResult } from '../types.js';
import { SyncError } from '../types.js';
import { fetchIntradayHeartRate, refreshGoogleHealthToken } from './api.js';
import { parseFitbitIntradayDay } from './parser.js';
import type { FitbitDayInsertion, FitbitStore } from './storage.js';
import { createFitbitStore } from './storage.js';

const FITBIT_NAME = 'fitbit';

export const FitbitParameterSchema = z.object({
  window_days: z.number().int().min(1).max(31).default(8),
});

export type FitbitParameters = z.infer<typeof FitbitParameterSchema>;

export function lastNDays(today: Date, windowDays: number): string[] {
  const days: string[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

export function buildFitbitAdapter(config: GoogleHealthAuthConfig): Adapter {
  return {
    name: FITBIT_NAME,
    description:
      'Sync Fitbit heart-rate samples (intraday, native sample resolution) for a recent window of days. Uses Google Health API.',
    parameter_schema: FitbitParameterSchema,
    requires_auth: true,
    sync: async (params: unknown, ctx: AdapterContext): Promise<SyncResult> => {
      const parsed = FitbitParameterSchema.parse(params);
      try {
        return await runFitbitSync(config, parsed, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeStateError(ctx.db, FITBIT_NAME, message);
        throw err;
      }
    },
  };
}

async function runFitbitSync(
  config: GoogleHealthAuthConfig,
  params: FitbitParameters,
  ctx: AdapterContext,
): Promise<SyncResult> {
  const tokens = await refreshAccessTokenAtomic(ctx.db, GOOGLE_HEALTH_CREDENTIALS_KEY, (rt) =>
    refreshGoogleHealthToken(config, rt),
  );
  const days = lastNDays(new Date(), params.window_days);
  const lastDay = days.at(-1);
  if (lastDay === undefined) throw new SyncError('parse_error', 'window_days produced no dates');
  const fitbitStore = createFitbitStore(ctx.db, ctx.store);
  const counts = await pullDays(fitbitStore, tokens.access_token, days);
  writeStateSuccess(ctx.db, FITBIT_NAME, `${lastDay}T23:59:59Z`);
  return { adapter: FITBIT_NAME, ...counts, last_synced_at: new Date().toISOString() };
}

async function pullDays(fitbitStore: FitbitStore, accessToken: string, days: readonly string[]) {
  let days_pulled = 0;
  let samples_added = 0;
  let samples_existing = 0;
  for (const day of days) {
    const insert = await pullDayIfFresh(fitbitStore, accessToken, day);
    if (insert === null) {
      samples_existing += 1;
    } else {
      days_pulled += 1;
      samples_added += insert.samples_added;
    }
  }
  return { days_pulled, samples_added, samples_existing };
}

async function pullDayIfFresh(
  fitbitStore: FitbitStore,
  accessToken: string,
  day: string,
): Promise<FitbitDayInsertion | null> {
  if (fitbitStore.alreadyIngested(day)) return null;
  const result = await fetchIntradayHeartRate(accessToken, day);
  const observations = parseFitbitIntradayDay(day, result);
  return fitbitStore.insertDay(day, result.raw, observations);
}
