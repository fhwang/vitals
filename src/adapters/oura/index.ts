import { z } from 'zod';

import {
  updateFrontierAfterTick,
  writeStateError,
  writeStateSuccess,
  type SyncErrorRecord,
} from '../state.js';
import type { Adapter, AdapterContext, SyncResult } from '../types.js';
import { SyncError } from '../types.js';
import { buildOuraFetcher, type OuraFetcher, type OuraSleepSession } from './api.js';
import { OURA_ADAPTER_NAME, readOuraCredentials } from './credentials.js';
import { parseOuraSleepSession } from './parser.js';
import { createOuraStore, type OuraSessionInsertion, type OuraStore } from './storage.js';

export const OuraParameterSchema = z.object({
  window_days: z.number().int().min(1).max(31).default(8),
});

export type OuraParameters = z.infer<typeof OuraParameterSchema>;

export function buildOuraAdapter(): Adapter {
  return {
    name: OURA_ADAPTER_NAME,
    description:
      'Sync Oura Ring sleep sessions (AASM-aligned stage timeline + per-session aggregates) for a recent window of days.',
    parameter_schema: OuraParameterSchema,
    requires_auth: true,
    sync: async (params: unknown, ctx: AdapterContext): Promise<SyncResult> => {
      const parsed = OuraParameterSchema.parse(params);
      try {
        return await runOuraSync(parsed, ctx);
      } catch (err) {
        writeStateError(ctx.db, OURA_ADAPTER_NAME, toErrorRecord(err));
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

async function runOuraSync(params: OuraParameters, ctx: AdapterContext): Promise<SyncResult> {
  const credentials = readOuraCredentials(ctx.db);
  if (credentials === null) {
    throw new SyncError('no_credentials', 'no credentials for oura');
  }
  const window = sleepWindow(new Date(), params.window_days);
  const fetcher = buildOuraFetcher(credentials.access_token);
  const store = createOuraStore(ctx.db, ctx.store);
  const result = await pullSessions(fetcher, store, window);
  recordSyncState(ctx.db, window, result.max_session_end_at);
  return toSyncResult(result);
}

function recordSyncState(
  db: AdapterContext['db'],
  window: readonly [string, string],
  maxSessionEndAt: string | null,
): void {
  writeStateSuccess(db, OURA_ADAPTER_NAME, `${window[1]}T23:59:59Z`);
  if (maxSessionEndAt !== null) {
    updateFrontierAfterTick(db, OURA_ADAPTER_NAME, maxSessionEndAt);
  }
}

function toSyncResult(result: PullResult): SyncResult {
  return {
    adapter: OURA_ADAPTER_NAME,
    days_pulled: result.sessions_added,
    samples_added: result.observations_added,
    samples_existing: result.sessions_existing,
    last_synced_at: new Date().toISOString(),
  };
}

export interface PullResult {
  sessions_added: number;
  sessions_existing: number;
  observations_added: number;
  max_session_end_at: string | null;
}

const EMPTY_PULL_RESULT: PullResult = {
  sessions_added: 0,
  sessions_existing: 0,
  observations_added: 0,
  max_session_end_at: null,
};

// Wraps an OuraStore and an in-progress PullResult so the per-session merge
// step doesn't need to thread (acc, store) through positional arguments. The
// closure factory pattern avoids both max-params and single-use struct types.
function createSessionMerger(store: OuraStore) {
  return async (acc: PullResult, session: OuraSleepSession): Promise<PullResult> => {
    if (store.alreadyIngested(session.id)) {
      return { ...acc, sessions_existing: acc.sessions_existing + 1 };
    }
    const parsed = parseOuraSleepSession(session);
    const inserted: OuraSessionInsertion = await store.insertSession(parsed, session);
    return mergeInsertion(acc, inserted);
  };
}

function mergeInsertion(acc: PullResult, inserted: OuraSessionInsertion): PullResult {
  return {
    sessions_added: acc.sessions_added + 1,
    sessions_existing: acc.sessions_existing,
    observations_added: acc.observations_added + inserted.observations_added,
    max_session_end_at: laterIso(acc.max_session_end_at, inserted.max_session_end_at),
  };
}

export async function pullSessions(
  fetcher: OuraFetcher,
  store: OuraStore,
  window: readonly [string, string],
): Promise<PullResult> {
  const fetched = await fetcher(window[0], window[1]);
  const mergeSession = createSessionMerger(store);
  let acc = EMPTY_PULL_RESULT;
  for (const session of fetched.sessions) {
    acc = await mergeSession(acc, session);
  }
  return acc;
}

function laterIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return b > a ? b : a;
}

// Returns the [startDate, endDate] string pair for a window of `windowDays`
// ending on `today` (inclusive of today's calendar date in UTC). Mirrors
// Fitbit's `lastNDays` shape but returns endpoints, not the full date list,
// since the Oura API takes a range.
export function sleepWindow(today: Date, windowDays: number): readonly [string, string] {
  const end = today.toISOString().slice(0, 10);
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));
  return [start.toISOString().slice(0, 10), end];
}
