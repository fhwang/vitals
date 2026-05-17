// The set of condition IDs vitals knows how to evaluate and notify on.
// Adding a new condition: add to this union, add an evaluator, add a renderer
// for the user-facing message. The harness never sees these IDs — they live
// inside vitals so the consumer doesn't need a taxonomy of failure modes.
export type ConditionId =
  | 'fitbit-auth-expired'
  | 'fitbit-sync-failures'
  | 'fitbit-frontier-stuck'
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
