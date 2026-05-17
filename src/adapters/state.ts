import { eq } from 'drizzle-orm';

import { adapterState, type Db } from '#db';

import type { SyncErrorReason } from './types.js';

// Discriminated by `status` so each shape has only required fields. The flat
// SQLite row maps to one of these variants based on which columns are populated.
export type AdapterState =
  | { adapter_name: string; status: 'never_synced' }
  | {
      adapter_name: string;
      status: 'success';
      last_sync_at: string;
      last_synced_window_end: string;
      freshness_frontier_at: string | null;
      successful_ticks_since_frontier_advance: number;
      consecutive_sync_failures: number;
    }
  | {
      adapter_name: string;
      status: 'error';
      last_sync_at: string;
      last_error_message: string;
      last_error_reason: SyncErrorReason | null;
      consecutive_sync_failures: number;
    };

export function readState(db: Db, adapterName: string): AdapterState {
  const row = db
    .select()
    .from(adapterState)
    .where(eq(adapterState.adapter_name, adapterName))
    .get();
  if (row?.last_sync_status == null) {
    return { adapter_name: adapterName, status: 'never_synced' };
  }
  if (row.last_sync_status === 'ok') {
    return {
      adapter_name: adapterName,
      status: 'success',
      last_sync_at: row.last_sync_at ?? '',
      last_synced_window_end: row.last_synced_window_end ?? '',
      freshness_frontier_at: row.freshness_frontier_at,
      successful_ticks_since_frontier_advance: row.successful_ticks_since_frontier_advance,
      consecutive_sync_failures: row.consecutive_sync_failures,
    };
  }
  return {
    adapter_name: adapterName,
    status: 'error',
    last_sync_at: row.last_sync_at ?? '',
    last_error_message: row.last_error_message ?? '',
    last_error_reason: (row.last_error_reason as SyncErrorReason | null) ?? null,
    consecutive_sync_failures: row.consecutive_sync_failures,
  };
}

export function writeStateSuccess(db: Db, adapterName: string, lastSyncedWindowEnd: string): void {
  const now = new Date().toISOString();
  db.insert(adapterState)
    .values({
      adapter_name: adapterName,
      last_sync_at: now,
      last_sync_status: 'ok',
      last_error_message: null,
      last_error_reason: null,
      last_synced_window_end: lastSyncedWindowEnd,
      consecutive_sync_failures: 0,
    })
    .onConflictDoUpdate({
      target: adapterState.adapter_name,
      set: {
        last_sync_at: now,
        last_sync_status: 'ok',
        last_error_message: null,
        last_error_reason: null,
        last_synced_window_end: lastSyncedWindowEnd,
        consecutive_sync_failures: 0,
      },
    })
    .run();
}

// Called after each successful tick. If `observedFrontier` is strictly greater
// than the stored frontier, advance and reset the stuck-tick counter; otherwise
// increment the counter (frontier didn't advance this tick).
//
// `observedFrontier` is the max sample timestamp observed across the tick's
// pulls, expressed as an ISO 8601 string. Pass `null` when a tick produced no
// samples — that's still a "didn't advance" event and increments the counter.
export function updateFrontierAfterTick(
  db: Db,
  adapterName: string,
  observedFrontier: string | null,
): void {
  const row = db
    .select({
      freshness_frontier_at: adapterState.freshness_frontier_at,
      successful_ticks_since_frontier_advance: adapterState.successful_ticks_since_frontier_advance,
    })
    .from(adapterState)
    .where(eq(adapterState.adapter_name, adapterName))
    .get();
  const currentFrontier = row?.freshness_frontier_at ?? null;
  const advanced =
    observedFrontier !== null && (currentFrontier === null || observedFrontier > currentFrontier);
  if (advanced) {
    db.update(adapterState)
      .set({
        freshness_frontier_at: observedFrontier,
        successful_ticks_since_frontier_advance: 0,
      })
      .where(eq(adapterState.adapter_name, adapterName))
      .run();
    return;
  }
  const nextTicks = (row?.successful_ticks_since_frontier_advance ?? 0) + 1;
  db.update(adapterState)
    .set({ successful_ticks_since_frontier_advance: nextTicks })
    .where(eq(adapterState.adapter_name, adapterName))
    .run();
}

export interface SyncErrorRecord {
  message: string;
  reason: SyncErrorReason | null;
}

export function writeStateError(db: Db, adapterName: string, err: SyncErrorRecord): void {
  const now = new Date().toISOString();
  const prior = db
    .select({ consecutive_sync_failures: adapterState.consecutive_sync_failures })
    .from(adapterState)
    .where(eq(adapterState.adapter_name, adapterName))
    .get();
  const nextFailures = (prior?.consecutive_sync_failures ?? 0) + 1;
  db.insert(adapterState)
    .values({
      adapter_name: adapterName,
      last_sync_at: now,
      last_sync_status: 'error',
      last_error_message: err.message,
      last_error_reason: err.reason,
      last_synced_window_end: null,
      consecutive_sync_failures: nextFailures,
    })
    .onConflictDoUpdate({
      target: adapterState.adapter_name,
      set: {
        last_sync_at: now,
        last_sync_status: 'error',
        last_error_message: err.message,
        last_error_reason: err.reason,
        consecutive_sync_failures: nextFailures,
      },
    })
    .run();
}
