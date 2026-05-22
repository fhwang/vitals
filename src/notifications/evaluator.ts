import type { AdapterNotificationProfile } from '#adapters';
import type { Db } from '#db';

import { appendNotificationLog } from './log.js';
import {
  readNotificationState,
  writeNotificationState,
  type NotificationStateRow,
} from './state.js';
import type { ConditionId, Notification, NotificationChannel } from './types.js';

// Per-adapter state snapshot the evaluator needs. The daemon collects one of
// these per registered adapter each tick. `frontier_stuck_ticks` is optional
// — adapters that don't publish a frontier signal (today: everything except
// Fitbit) omit it.
export interface AdapterConditionState {
  adapter_name: string;
  profile: AdapterNotificationProfile;
  auth_failed: boolean;
  consecutive_failures: number;
  frontier_stuck_ticks?: number;
}

// Snapshot of the state vitals needs to evaluate every known notification
// condition. The daemon assembles this each tick and passes it in; the
// evaluators themselves do no I/O so they're easy to unit-test.
export interface ConditionsInput {
  adapters: readonly AdapterConditionState[];
  // mtime of the daemon's heartbeat file, or null if no file exists yet.
  heartbeat_mtime: Date | null;
  now: Date;
}

export interface ConditionEvaluation {
  condition_id: ConditionId;
  is_firing: boolean;
  notification: Notification | null;
}

const SYNC_FAILURES_THRESHOLD = 3;
const FRONTIER_STUCK_TICKS_THRESHOLD = 12;
const HEARTBEAT_STALE_HOURS = 24;

const FRONTIER_STUCK_REFIRE_HOURS = 24 * 7;
const DEFAULT_REFIRE_HOURS = 24;

function refireHoursFor(conditionId: ConditionId): number {
  if (conditionId.endsWith('-frontier-stuck')) return FRONTIER_STUCK_REFIRE_HOURS;
  return DEFAULT_REFIRE_HOURS;
}

export function evaluateAllConditions(input: ConditionsInput): ConditionEvaluation[] {
  const out: ConditionEvaluation[] = [];
  for (const adapter of input.adapters) {
    out.push(evalAuthExpired(adapter));
    out.push(evalSyncFailures(adapter));
    if (
      adapter.frontier_stuck_ticks !== undefined &&
      adapter.profile.frontier_stuck_body !== undefined
    ) {
      out.push(evalFrontierStuck(adapter));
    }
  }
  out.push(evalHeartbeatStale(input));
  return out;
}

function evalAuthExpired(adapter: AdapterConditionState): ConditionEvaluation {
  const condition_id: ConditionId = `${adapter.adapter_name}-auth-expired`;
  if (!adapter.auth_failed) return { condition_id, is_firing: false, notification: null };
  return {
    condition_id,
    is_firing: true,
    notification: {
      condition_id,
      severity: 'critical',
      title: `Vitals: ${adapter.profile.display_name} re-authorization required`,
      message: adapter.profile.auth_failure_body,
    },
  };
}

function evalSyncFailures(adapter: AdapterConditionState): ConditionEvaluation {
  const condition_id: ConditionId = `${adapter.adapter_name}-sync-failures`;
  if (adapter.consecutive_failures < SYNC_FAILURES_THRESHOLD) {
    return { condition_id, is_firing: false, notification: null };
  }
  return {
    condition_id,
    is_firing: true,
    notification: {
      condition_id,
      severity: 'warning',
      title: `Vitals: ${adapter.profile.display_name} sync failing`,
      message: `${adapter.consecutive_failures} consecutive ${adapter.profile.display_name} syncs have failed. Check the daemon log.`,
    },
  };
}

function evalFrontierStuck(adapter: AdapterConditionState): ConditionEvaluation {
  const condition_id: ConditionId = `${adapter.adapter_name}-frontier-stuck`;
  const ticks = adapter.frontier_stuck_ticks ?? 0;
  const body = adapter.profile.frontier_stuck_body ?? '';
  if (ticks < FRONTIER_STUCK_TICKS_THRESHOLD || body === '') {
    return { condition_id, is_firing: false, notification: null };
  }
  return {
    condition_id,
    is_firing: true,
    notification: {
      condition_id,
      severity: 'info',
      title: `Vitals: ${adapter.profile.display_name} data not updating`,
      message: body,
    },
  };
}

function evalHeartbeatStale(input: ConditionsInput): ConditionEvaluation {
  if (input.heartbeat_mtime === null) {
    // No heartbeat file means the daemon has never run — don't nag users who
    // haven't installed the scheduler yet.
    return { condition_id: 'daemon-heartbeat-stale', is_firing: false, notification: null };
  }
  const elapsedHours = (input.now.getTime() - input.heartbeat_mtime.getTime()) / (60 * 60 * 1000);
  if (elapsedHours < HEARTBEAT_STALE_HOURS) {
    return { condition_id: 'daemon-heartbeat-stale', is_firing: false, notification: null };
  }
  return {
    condition_id: 'daemon-heartbeat-stale',
    is_firing: true,
    notification: {
      condition_id: 'daemon-heartbeat-stale',
      severity: 'critical',
      title: 'Vitals: sync daemon stopped',
      message: `No daemon tick in ${Math.round(elapsedHours)} hours. Reinstall with pnpm vitals install-scheduler.`,
    },
  };
}

export interface NotifyDeps {
  db: Db;
  channel: NotificationChannel;
}

// Evaluate every condition, send notifications for any that are firing
// (subject to per-condition re-fire cadence), and update state. Recovered
// conditions are silently downgraded to 'resolved' state.
export async function evaluateAndNotify(deps: NotifyDeps, input: ConditionsInput): Promise<void> {
  for (const ev of evaluateAllConditions(input)) {
    await maybeFireOne(deps, input.now, ev);
  }
}

async function maybeFireOne(deps: NotifyDeps, now: Date, ev: ConditionEvaluation): Promise<void> {
  const prior = readNotificationState(deps.db, ev.condition_id);
  if (ev.is_firing && ev.notification !== null) {
    if (shouldRefire(prior, now, ev.condition_id)) {
      await deps.channel.send(ev.notification);
      appendNotificationLog(deps.db, ev.notification, now.toISOString());
      writeNotificationState(deps.db, {
        condition_id: ev.condition_id,
        last_fired_at: now.toISOString(),
        last_state: 'firing',
      });
    }
    return;
  }
  if (prior?.last_state === 'firing') {
    writeNotificationState(deps.db, {
      condition_id: ev.condition_id,
      last_fired_at: prior.last_fired_at,
      last_state: 'resolved',
    });
  }
}

function shouldRefire(
  prior: NotificationStateRow | null,
  now: Date,
  conditionId: ConditionId,
): boolean {
  if (prior === null) return true;
  if (prior.last_state === 'resolved') return true;
  if (prior.last_fired_at === null) return true;
  const elapsedMs = now.getTime() - new Date(prior.last_fired_at).getTime();
  const refireMs = refireHoursFor(conditionId) * 60 * 60 * 1000;
  return elapsedMs >= refireMs;
}
