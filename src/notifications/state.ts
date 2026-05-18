import { eq } from 'drizzle-orm';

import { notificationState, type Db } from '#db';

import type { ConditionId, ConditionState } from './types.js';

export interface NotificationStateRow {
  condition_id: ConditionId;
  last_fired_at: string | null;
  last_state: ConditionState;
}

export function readNotificationState(
  db: Db,
  conditionId: ConditionId,
): NotificationStateRow | null {
  const row = db
    .select()
    .from(notificationState)
    .where(eq(notificationState.condition_id, conditionId))
    .get();
  if (row === undefined) return null;
  return {
    condition_id: row.condition_id as ConditionId,
    last_fired_at: row.last_fired_at,
    last_state: row.last_state as ConditionState,
  };
}

export function writeNotificationState(db: Db, row: NotificationStateRow): void {
  db.insert(notificationState)
    .values({
      condition_id: row.condition_id,
      last_fired_at: row.last_fired_at,
      last_state: row.last_state,
    })
    .onConflictDoUpdate({
      target: notificationState.condition_id,
      set: { last_fired_at: row.last_fired_at, last_state: row.last_state },
    })
    .run();
}
