import { describe, expect, it } from 'vitest';

import { openDatabase } from '#db';

import { createMemoryNotificationChannel } from './channel-memory.js';
import { evaluateAllConditions, evaluateAndNotify, type ConditionsInput } from './evaluator.js';
import { listNotificationLog } from './log.js';
import { readNotificationState } from './state.js';

const NOW = new Date('2026-05-16T12:00:00Z');

function baseInput(overrides: Partial<ConditionsInput> = {}): ConditionsInput {
  const now = overrides.now ?? NOW;
  return {
    fitbit_auth_expired: false,
    fitbit_consecutive_failures: 0,
    fitbit_frontier_stuck_ticks: 0,
    // Keep heartbeat fresh relative to `now` by default so tests that advance
    // the clock don't accidentally trip daemon-heartbeat-stale. Tests that
    // specifically exercise heartbeat staleness override this explicitly.
    heartbeat_mtime: now,
    ...overrides,
    now,
  };
}

describe('evaluateAllConditions', () => {
  it('reports no firing conditions on a healthy snapshot', () => {
    const evaluations = evaluateAllConditions(baseInput());
    expect(evaluations.every((e) => !e.is_firing)).toBe(true);
  });

  it('fires fitbit-auth-expired when auth is expired', () => {
    const evaluations = evaluateAllConditions(baseInput({ fitbit_auth_expired: true }));
    const ev = evaluations.find((e) => e.condition_id === 'fitbit-auth-expired');
    expect(ev?.is_firing).toBe(true);
    expect(ev?.notification?.severity).toBe('critical');
  });

  it('does not fire fitbit-sync-failures below the 3-tick threshold', () => {
    const evaluations = evaluateAllConditions(baseInput({ fitbit_consecutive_failures: 2 }));
    const ev = evaluations.find((e) => e.condition_id === 'fitbit-sync-failures');
    expect(ev?.is_firing).toBe(false);
  });

  it('fires fitbit-sync-failures at threshold and includes the count in the message', () => {
    const evaluations = evaluateAllConditions(baseInput({ fitbit_consecutive_failures: 3 }));
    const ev = evaluations.find((e) => e.condition_id === 'fitbit-sync-failures');
    expect(ev?.is_firing).toBe(true);
    expect(ev?.notification?.message).toContain('3 consecutive');
  });

  it('does not fire fitbit-frontier-stuck below 12 ticks', () => {
    const evaluations = evaluateAllConditions(baseInput({ fitbit_frontier_stuck_ticks: 11 }));
    const ev = evaluations.find((e) => e.condition_id === 'fitbit-frontier-stuck');
    expect(ev?.is_firing).toBe(false);
  });

  it('fires fitbit-frontier-stuck at 12 ticks', () => {
    const evaluations = evaluateAllConditions(baseInput({ fitbit_frontier_stuck_ticks: 12 }));
    const ev = evaluations.find((e) => e.condition_id === 'fitbit-frontier-stuck');
    expect(ev?.is_firing).toBe(true);
    expect(ev?.notification?.severity).toBe('info');
  });

  it('does not fire daemon-heartbeat-stale when heartbeat_mtime is null (daemon never installed)', () => {
    const evaluations = evaluateAllConditions(baseInput({ heartbeat_mtime: null }));
    const ev = evaluations.find((e) => e.condition_id === 'daemon-heartbeat-stale');
    expect(ev?.is_firing).toBe(false);
  });

  it('fires daemon-heartbeat-stale when the heartbeat is older than 24h', () => {
    const oldHeartbeat = new Date(NOW.getTime() - 30 * 60 * 60 * 1000);
    const evaluations = evaluateAllConditions(baseInput({ heartbeat_mtime: oldHeartbeat }));
    const ev = evaluations.find((e) => e.condition_id === 'daemon-heartbeat-stale');
    expect(ev?.is_firing).toBe(true);
    expect(ev?.notification?.severity).toBe('critical');
  });

  it('does not fire daemon-heartbeat-stale when the heartbeat is recent', () => {
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000);
    const evaluations = evaluateAllConditions(baseInput({ heartbeat_mtime: recent }));
    const ev = evaluations.find((e) => e.condition_id === 'daemon-heartbeat-stale');
    expect(ev?.is_firing).toBe(false);
  });
});

describe('evaluateAndNotify', () => {
  it('sends a notification, logs it, and records state on first fire', async () => {
    const db = openDatabase(':memory:');
    const channel = createMemoryNotificationChannel();
    await evaluateAndNotify({ db, channel }, baseInput({ fitbit_auth_expired: true }));
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.condition_id).toBe('fitbit-auth-expired');
    const log = listNotificationLog(db);
    expect(log).toHaveLength(1);
    const state = readNotificationState(db, 'fitbit-auth-expired');
    expect(state?.last_state).toBe('firing');
    expect(state?.last_fired_at).toBe(NOW.toISOString());
  });

  it('dedups: does not re-fire within the per-condition re-fire window', async () => {
    const db = openDatabase(':memory:');
    const channel = createMemoryNotificationChannel();
    await evaluateAndNotify({ db, channel }, baseInput({ fitbit_auth_expired: true }));
    expect(channel.sent).toHaveLength(1);
    const oneHourLater = new Date(NOW.getTime() + 60 * 60 * 1000);
    await evaluateAndNotify(
      { db, channel },
      baseInput({ fitbit_auth_expired: true, now: oneHourLater }),
    );
    expect(channel.sent).toHaveLength(1);
  });

  it('re-fires after the re-fire cadence elapses', async () => {
    const db = openDatabase(':memory:');
    const channel = createMemoryNotificationChannel();
    await evaluateAndNotify({ db, channel }, baseInput({ fitbit_auth_expired: true }));
    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000); // 25h later
    await evaluateAndNotify({ db, channel }, baseInput({ fitbit_auth_expired: true, now: later }));
    expect(channel.sent).toHaveLength(2);
  });

  it('marks a previously-firing condition resolved without sending a notification', async () => {
    const db = openDatabase(':memory:');
    const channel = createMemoryNotificationChannel();
    await evaluateAndNotify({ db, channel }, baseInput({ fitbit_auth_expired: true }));
    expect(channel.sent).toHaveLength(1);
    await evaluateAndNotify({ db, channel }, baseInput({ fitbit_auth_expired: false }));
    expect(channel.sent).toHaveLength(1);
    const state = readNotificationState(db, 'fitbit-auth-expired');
    expect(state?.last_state).toBe('resolved');
  });

  it('re-fires immediately if the condition resolved and then fires again', async () => {
    const db = openDatabase(':memory:');
    const channel = createMemoryNotificationChannel();
    await evaluateAndNotify({ db, channel }, baseInput({ fitbit_auth_expired: true }));
    const aLittleLater = new Date(NOW.getTime() + 60 * 60 * 1000);
    await evaluateAndNotify(
      { db, channel },
      baseInput({ fitbit_auth_expired: false, now: aLittleLater }),
    );
    const evenLater = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
    await evaluateAndNotify(
      { db, channel },
      baseInput({ fitbit_auth_expired: true, now: evenLater }),
    );
    // Two real notifications even though only a couple hours elapsed — the
    // resolve in between resets the re-fire window.
    expect(channel.sent).toHaveLength(2);
  });

  it('uses the longer 7d re-fire cadence for fitbit-frontier-stuck', async () => {
    const db = openDatabase(':memory:');
    const channel = createMemoryNotificationChannel();
    await evaluateAndNotify({ db, channel }, baseInput({ fitbit_frontier_stuck_ticks: 12 }));
    const twoDaysLater = new Date(NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
    await evaluateAndNotify(
      { db, channel },
      baseInput({ fitbit_frontier_stuck_ticks: 13, now: twoDaysLater }),
    );
    expect(channel.sent).toHaveLength(1);
    const eightDaysLater = new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000);
    await evaluateAndNotify(
      { db, channel },
      baseInput({ fitbit_frontier_stuck_ticks: 18, now: eightDaysLater }),
    );
    expect(channel.sent).toHaveLength(2);
  });
});
