import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  createAdapterRegistry,
  readState,
  SyncError,
  writeStateError,
  writeStateSuccess,
  type Adapter,
} from '#adapters';
import { openDatabase, type Db } from '#db';
import {
  createMemoryNotificationChannel,
  listNotificationLog,
  type ConditionsInput,
} from '#notifications';
import { MemoryBlobStore } from '#storage';

import { readHeartbeatMtime } from './heartbeat.js';
import {
  buildConditionsInput,
  collectAdapterStates,
  runDaemonTick,
  syncWithRetries,
} from './tick.js';

const FITBIT = 'fitbit';
const SILENT_LOGGER = pino({ level: 'silent' });

interface StubBehavior {
  outcomes: ('success' | 'transient' | 'reauth')[];
  calls: number;
}

function makeStubAdapter(name: string, behavior: StubBehavior): Adapter {
  const sync: Adapter['sync'] = () => {
    const outcome = behavior.outcomes[behavior.calls] ?? 'success';
    behavior.calls += 1;
    if (outcome === 'success') {
      return Promise.resolve({
        adapter: name,
        days_pulled: 1,
        samples_added: 0,
        samples_existing: 0,
        last_synced_at: new Date().toISOString(),
      });
    }
    const reason = outcome === 'transient' ? 'transient' : 'reauth_required';
    return Promise.reject(new SyncError(reason, outcome));
  };
  return {
    name,
    description: 'stub',
    parameter_schema: z.object({}),
    requires_auth: false,
    notification_profile: {
      display_name: name,
      auth_failure_body: `Renew ${name} credentials.`,
    },
    sync,
  };
}

function singleAdapterRegistry(name: string) {
  const registry = createAdapterRegistry();
  registry.register(makeStubAdapter(name, { outcomes: [], calls: 0 }));
  return registry;
}

describe('syncWithRetries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result on first success without retrying', async () => {
    const behavior: StubBehavior = { outcomes: ['success'], calls: 0 };
    const adapter = makeStubAdapter('stub', behavior);
    const result = await syncWithRetries(adapter, {
      db: openDatabase(':memory:'),
      store: new MemoryBlobStore(),
      logger: SILENT_LOGGER,
    });
    expect(behavior.calls).toBe(1);
    expect(result.adapter).toBe('stub');
  });

  it('retries transient errors and eventually returns success', async () => {
    const behavior: StubBehavior = { outcomes: ['transient', 'success'], calls: 0 };
    const adapter = makeStubAdapter('stub', behavior);
    const promise = syncWithRetries(adapter, {
      db: openDatabase(':memory:'),
      store: new MemoryBlobStore(),
      logger: SILENT_LOGGER,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(behavior.calls).toBe(2);
    expect(result.adapter).toBe('stub');
  });

  it('throws after maxAttempts consecutive transient errors', async () => {
    const behavior: StubBehavior = {
      outcomes: ['transient', 'transient', 'transient'],
      calls: 0,
    };
    const adapter = makeStubAdapter('stub', behavior);
    const promise = syncWithRetries(
      adapter,
      { db: openDatabase(':memory:'), store: new MemoryBlobStore(), logger: SILENT_LOGGER },
      3,
    );
    // Attach the rejection handler first so the eventual reject() isn't
    // observed as an unhandled rejection while the fake timer is advancing.
    const assertion = expect(promise).rejects.toBeInstanceOf(SyncError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(behavior.calls).toBe(3);
  });

  it('does not retry non-transient errors', async () => {
    const behavior: StubBehavior = { outcomes: ['reauth'], calls: 0 };
    const adapter = makeStubAdapter('stub', behavior);
    await expect(
      syncWithRetries(adapter, {
        db: openDatabase(':memory:'),
        store: new MemoryBlobStore(),
        logger: SILENT_LOGGER,
      }),
    ).rejects.toBeInstanceOf(SyncError);
    expect(behavior.calls).toBe(1);
  });
});

describe('buildConditionsInput', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vitals-tick-'));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function inputFrom(db: Db, adapters: ReturnType<typeof createAdapterRegistry>): ConditionsInput {
    return buildConditionsInput(
      collectAdapterStates(db, adapters),
      readHeartbeatMtime(join(tmpDir, 'heartbeat')),
      new Date(),
    );
  }

  it('maps a never_synced state to neutral conditions', () => {
    const db = openDatabase(':memory:');
    const adapters = singleAdapterRegistry(FITBIT);
    const input = inputFrom(db, adapters);
    expect(input.adapters).toHaveLength(1);
    const fitbit = input.adapters[0];
    expect(fitbit?.adapter_name).toBe(FITBIT);
    expect(fitbit?.auth_failed).toBe(false);
    expect(fitbit?.consecutive_failures).toBe(0);
    expect(input.heartbeat_mtime).toBeNull();
  });

  it('sets auth_failed when the last error reason is reauth_required', () => {
    const db = openDatabase(':memory:');
    const adapters = singleAdapterRegistry(FITBIT);
    writeStateError(db, FITBIT, { message: '401 from Google', reason: 'reauth_required' });
    const input = inputFrom(db, adapters);
    const fitbit = input.adapters[0];
    expect(fitbit?.auth_failed).toBe(true);
    expect(fitbit?.consecutive_failures).toBe(1);
  });

  it('counts consecutive failures across multiple errors', () => {
    const db = openDatabase(':memory:');
    const adapters = singleAdapterRegistry(FITBIT);
    writeStateError(db, FITBIT, { message: '1', reason: 'transient' });
    writeStateError(db, FITBIT, { message: '2', reason: 'transient' });
    writeStateError(db, FITBIT, { message: '3', reason: 'transient' });
    const input = inputFrom(db, adapters);
    expect(input.adapters[0]?.consecutive_failures).toBe(3);
  });

  it('resets the failure counter on success', () => {
    const db = openDatabase(':memory:');
    writeStateError(db, FITBIT, { message: 'oops', reason: 'transient' });
    writeStateSuccess(db, FITBIT, '2026-05-16T23:59:59Z');
    const state = readState(db, FITBIT);
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.consecutive_sync_failures).toBe(0);
  });
});

describe('runDaemonTick', () => {
  let tmpDir: string;
  let heartbeatPath: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'vitals-tick-'));
    heartbeatPath = join(tmpDir, 'heartbeat');
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('runs sync for every registered adapter and writes a heartbeat', async () => {
    const db = openDatabase(':memory:');
    const store = new MemoryBlobStore();
    const channel = createMemoryNotificationChannel();
    const registry = createAdapterRegistry();
    const behaviorA: StubBehavior = { outcomes: ['success'], calls: 0 };
    const behaviorB: StubBehavior = { outcomes: ['success'], calls: 0 };
    registry.register(makeStubAdapter('a', behaviorA));
    registry.register(makeStubAdapter('b', behaviorB));
    await runDaemonTick({
      db,
      store,
      logger: SILENT_LOGGER,
      channel,
      adapters: registry,
      heartbeatPath,
    });
    expect(behaviorA.calls).toBe(1);
    expect(behaviorB.calls).toBe(1);
    expect(readHeartbeatMtime(heartbeatPath)).toBeInstanceOf(Date);
  });

  it('survives a terminally-failing adapter and still ticks remaining adapters', async () => {
    const db = openDatabase(':memory:');
    const store = new MemoryBlobStore();
    const channel = createMemoryNotificationChannel();
    const registry = createAdapterRegistry();
    const behaviorA: StubBehavior = { outcomes: ['reauth'], calls: 0 };
    const behaviorB: StubBehavior = { outcomes: ['success'], calls: 0 };
    registry.register(makeStubAdapter('a', behaviorA));
    registry.register(makeStubAdapter('b', behaviorB));
    await runDaemonTick({
      db,
      store,
      logger: SILENT_LOGGER,
      channel,
      adapters: registry,
      heartbeatPath,
    });
    expect(behaviorA.calls).toBe(1);
    expect(behaviorB.calls).toBe(1);
  });

  it('writes an entry to the notification log when a condition fires', async () => {
    const db = openDatabase(':memory:');
    writeStateError(db, FITBIT, { message: '401', reason: 'reauth_required' });
    await tickWithStubFitbit(db, heartbeatPath, ['reauth', 'reauth', 'reauth', 'reauth', 'reauth']);
    const log = listNotificationLog(db);
    expect(log.some((entry) => entry.condition_id === 'fitbit-auth-expired')).toBe(true);
  });
});

async function tickWithStubFitbit(
  db: Db,
  heartbeatPath: string,
  outcomes: ('success' | 'transient' | 'reauth')[],
): Promise<void> {
  const behavior: StubBehavior = { outcomes, calls: 0 };
  const registry = createAdapterRegistry();
  registry.register(makeStubAdapter(FITBIT, behavior));
  const channel = createMemoryNotificationChannel();
  await runDaemonTick({
    db,
    store: new MemoryBlobStore(),
    logger: SILENT_LOGGER,
    channel,
    adapters: registry,
    heartbeatPath,
  });
}
