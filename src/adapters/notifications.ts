// User-facing notification metadata each adapter declares. The notification
// evaluator (in `#notifications`) is adapter-agnostic — it computes thresholds
// generically — but the messages it renders embed adapter-specific details
// (display name, where to go to renew credentials, vendor-specific app hints).
// Those details live with the adapter, not in the evaluator.

export interface AdapterNotificationProfile {
  // User-facing name used in notification titles ("Vitals: <display_name>
  // re-authorization required") and message bodies. Typically the vendor
  // name in title case: "Fitbit", "Oura".
  display_name: string;

  // Full body for the "auth-expired" notification. Includes
  // adapter-specific renewal instructions because they vary (which CLI
  // command, which web dashboard, etc.).
  auth_failure_body: string;

  // Optional. Only adapters that publish a "frontier stuck" signal
  // (today: only Fitbit, via the `successful_ticks_since_frontier_advance`
  // counter) provide this. When omitted, the evaluator does not fire a
  // frontier-stuck condition for the adapter.
  frontier_stuck_body?: string;
}
