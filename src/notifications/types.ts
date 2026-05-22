// The set of condition IDs vitals knows how to evaluate and notify on.
// Adapter-prefixed IDs are template-literal: any registered adapter yields
// `${name}-auth-expired`, `${name}-sync-failures`, and (if the adapter
// publishes a frontier signal) `${name}-frontier-stuck`. The non-adapter
// condition `daemon-heartbeat-stale` is global. Downstream consumers never
// see these IDs — they live inside vitals so consumers don't have to learn
// a taxonomy of failure modes.
export type AdapterAuthConditionId = `${string}-auth-expired`;
export type AdapterSyncFailuresConditionId = `${string}-sync-failures`;
export type AdapterFrontierStuckConditionId = `${string}-frontier-stuck`;
export type ConditionId =
  | AdapterAuthConditionId
  | AdapterSyncFailuresConditionId
  | AdapterFrontierStuckConditionId
  | 'daemon-heartbeat-stale';

export type Severity = 'info' | 'warning' | 'critical';

// What gets sent to the channel and recorded in notification_log. `title` is
// a short banner; `message` is the body — both end up in the macOS native
// notification. Keep both short — macOS truncates aggressively.
export interface Notification {
  condition_id: ConditionId;
  severity: Severity;
  title: string;
  message: string;
}

// A swappable destination for user-facing notifications. macOS native by
// default; Slack/email/etc. can drop in later without touching evaluation
// logic.
export interface NotificationChannel {
  send(notification: Notification): Promise<void>;
}

export type ConditionState = 'firing' | 'resolved';
