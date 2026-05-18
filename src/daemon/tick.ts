import type { Logger } from 'pino';

import {
  readState,
  SyncError,
  type Adapter,
  type AdapterContext,
  type AdapterRegistry,
  type AdapterState,
  type SyncResult,
} from '#adapters';
import type { Db } from '#db';
import { evaluateAndNotify, type ConditionsInput, type NotificationChannel } from '#notifications';
import type { BlobStore } from '#storage';

import { readHeartbeatMtime, writeHeartbeat } from './heartbeat.js';

// Wraps everything a single daemon tick needs. The daemon assembles this
// once at startup; tests build it directly with mocks.
export interface DaemonTickDeps {
  db: Db;
  store: BlobStore;
  logger: Logger;
  channel: NotificationChannel;
  adapters: AdapterRegistry;
  heartbeatPath: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const FITBIT_NAME = 'fitbit';
const OURA_NAME = 'oura';

export async function runDaemonTick(deps: DaemonTickDeps): Promise<void> {
  const ctx: AdapterContext = { db: deps.db, store: deps.store, logger: deps.logger };
  for (const adapter of deps.adapters.list()) {
    await syncOneAdapter(adapter, ctx);
  }
  const now = new Date();
  const input = buildConditionsInput(deps.db, deps.heartbeatPath, now);
  await evaluateAndNotify({ db: deps.db, channel: deps.channel }, input);
  writeHeartbeat(deps.heartbeatPath, now);
}

async function syncOneAdapter(adapter: Adapter, ctx: AdapterContext): Promise<void> {
  try {
    await syncWithRetries(adapter, ctx);
  } catch (err) {
    ctx.logger.warn({ err, adapter: adapter.name }, 'sync terminally failed');
  }
}

// Retries transient errors with exponential backoff. Terminal errors (auth,
// parse, etc.) are re-thrown immediately so callers can decide what to do —
// the per-adapter error handling already happened inside adapter.sync (state
// row written).
export async function syncWithRetries(
  adapter: Adapter,
  ctx: AdapterContext,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
): Promise<SyncResult> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await adapter.sync({}, ctx);
    } catch (err) {
      if (isRetryable(err) && attempt < maxAttempts) {
        await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    }
  }
}

function isRetryable(err: unknown): boolean {
  return err instanceof SyncError && err.reason === 'transient';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function buildConditionsInput(db: Db, heartbeatPath: string, now: Date): ConditionsInput {
  const fitbitState = readState(db, FITBIT_NAME);
  const ouraState = readState(db, OURA_NAME);
  return {
    fitbit_auth_expired: isAuthExpired(fitbitState),
    fitbit_consecutive_failures: getConsecutiveFailures(fitbitState),
    fitbit_frontier_stuck_ticks: getStuckTicks(fitbitState),
    oura_auth_invalid: isAuthExpired(ouraState),
    oura_consecutive_failures: getConsecutiveFailures(ouraState),
    heartbeat_mtime: readHeartbeatMtime(heartbeatPath),
    now,
  };
}

function isAuthExpired(state: AdapterState): boolean {
  return state.status === 'error' && state.last_error_reason === 'reauth_required';
}

function getConsecutiveFailures(state: AdapterState): number {
  if (state.status === 'never_synced') return 0;
  return state.consecutive_sync_failures;
}

function getStuckTicks(state: AdapterState): number {
  if (state.status !== 'success') return 0;
  return state.successful_ticks_since_frontier_advance;
}
