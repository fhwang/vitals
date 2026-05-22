export type {
  ConditionId,
  ConditionState,
  Notification,
  NotificationChannel,
  Severity,
} from './types.js';
export { createMacOsNotificationChannel } from './channel-macos.js';
export type { MemoryNotificationChannel } from './channel-memory.js';
export { createMemoryNotificationChannel } from './channel-memory.js';
export type { NotificationStateRow } from './state.js';
export { readNotificationState, writeNotificationState } from './state.js';
export type { NotificationLogEntry } from './log.js';
export { appendNotificationLog, listNotificationLog } from './log.js';
export type {
  AdapterConditionState,
  ConditionEvaluation,
  ConditionsInput,
  NotifyDeps,
} from './evaluator.js';
export { evaluateAllConditions, evaluateAndNotify } from './evaluator.js';
