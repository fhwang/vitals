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
import type { FitbitDayInsertion } from './storage.js';
import { FitbitStore } from './storage.js';

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

class FitbitSyncRun {
  daysPulled = 0;
  samplesAdded = 0;
  samplesExisting = 0;

  constructor(
    private readonly store: FitbitStore,
    private readonly accessToken: string,
  ) {}

  async syncDay(date: string): Promise<void> {
    if (this.store.alreadyIngested(date)) {
      this.samplesExisting += 1;
      return;
    }
    const result = await fetchIntradayHeartRate(this.accessToken, date);
    const observations = parseFitbitIntradayDay(date, result);
    const insert = await this.store.insertDay(date, result.raw, observations);
    this.recordInsertion(insert);
  }

  private recordInsertion(insert: FitbitDayInsertion): void {
    this.daysPulled += 1;
    this.samplesAdded += insert.samples_added;
  }

  toResult(): Omit<SyncResult, 'last_synced_at' | 'adapter'> {
    return {
      days_pulled: this.daysPulled,
      samples_added: this.samplesAdded,
      samples_existing: this.samplesExisting,
    };
  }
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
  if (lastDay === undefined) {
    throw new SyncError('parse_error', 'window_days produced no dates');
  }
  const fitbitStore = new FitbitStore(ctx.db, ctx.store);
  const run = new FitbitSyncRun(fitbitStore, tokens.access_token);
  for (const day of days) await run.syncDay(day);
  writeStateSuccess(ctx.db, FITBIT_NAME, `${lastDay}T23:59:59Z`);
  return {
    adapter: FITBIT_NAME,
    ...run.toResult(),
    last_synced_at: new Date().toISOString(),
  };
}
