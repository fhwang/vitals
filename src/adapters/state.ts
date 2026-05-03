import { eq } from 'drizzle-orm';

import type { Db } from '../db/index.js';
import { adapterState } from '../db/schema.js';

// Discriminated by `status` so each shape has only required fields. The flat
// SQLite row maps to one of these variants based on which columns are populated.
export type AdapterState =
  | { adapter_name: string; status: 'never_synced' }
  | {
      adapter_name: string;
      status: 'success';
      last_sync_at: string;
      last_synced_window_end: string;
    }
  | {
      adapter_name: string;
      status: 'error';
      last_sync_at: string;
      last_error_message: string;
    };

export function readState(db: Db, adapterName: string): AdapterState {
  const row = db
    .select({
      last_sync_at: adapterState.last_sync_at,
      last_sync_status: adapterState.last_sync_status,
      last_error_message: adapterState.last_error_message,
      last_synced_window_end: adapterState.last_synced_window_end,
    })
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
    };
  }
  return {
    adapter_name: adapterName,
    status: 'error',
    last_sync_at: row.last_sync_at ?? '',
    last_error_message: row.last_error_message ?? '',
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
      last_synced_window_end: lastSyncedWindowEnd,
    })
    .onConflictDoUpdate({
      target: adapterState.adapter_name,
      set: {
        last_sync_at: now,
        last_sync_status: 'ok',
        last_error_message: null,
        last_synced_window_end: lastSyncedWindowEnd,
      },
    })
    .run();
}

export function writeStateError(db: Db, adapterName: string, message: string): void {
  const now = new Date().toISOString();
  db.insert(adapterState)
    .values({
      adapter_name: adapterName,
      last_sync_at: now,
      last_sync_status: 'error',
      last_error_message: message,
      last_synced_window_end: null,
    })
    .onConflictDoUpdate({
      target: adapterState.adapter_name,
      set: {
        last_sync_at: now,
        last_sync_status: 'error',
        last_error_message: message,
      },
    })
    .run();
}
