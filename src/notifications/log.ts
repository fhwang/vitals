import { desc } from 'drizzle-orm';

import { notificationLog, type Db } from '#db';

import type { ConditionId, Notification, Severity } from './types.js';

export interface NotificationLogEntry {
  id: number;
  condition_id: ConditionId;
  fired_at: string;
  severity: Severity;
  title: string;
  message: string;
}

export function appendNotificationLog(db: Db, notification: Notification, firedAt: string): void {
  db.insert(notificationLog)
    .values({
      condition_id: notification.condition_id,
      fired_at: firedAt,
      severity: notification.severity,
      title: notification.title,
      message: notification.message,
    })
    .run();
}

export function listNotificationLog(db: Db, limit = 50): NotificationLogEntry[] {
  return db
    .select()
    .from(notificationLog)
    .orderBy(desc(notificationLog.fired_at), desc(notificationLog.id))
    .limit(limit)
    .all()
    .map((row) => ({
      id: row.id,
      condition_id: row.condition_id as ConditionId,
      fired_at: row.fired_at,
      severity: row.severity as Severity,
      title: row.title,
      message: row.message,
    }));
}
