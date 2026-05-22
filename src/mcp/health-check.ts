import type { Logger } from 'pino';

import type { AdapterRegistry } from '#adapters';
import {
  buildConditionsInput,
  collectAdapterStates,
  getDefaultHeartbeatPath,
  readHeartbeatMtime,
} from '#daemon';
import type { Db } from '#db';
import { createMacOsNotificationChannel, evaluateAndNotify } from '#notifications';

// Called once at MCP-server startup. Reads the daemon heartbeat (touched at
// the end of each successful daemon tick) and dispatches the full condition
// evaluator. If the daemon has been silent for >24h, the
// daemon-heartbeat-stale notification fires here — that's the path by which
// a dead daemon eventually surfaces to the user, since the daemon itself
// can't notify when it's not running.
//
// Other notifications (auth, sync failures) can also fire here if the daemon
// got stuck before reaching its own evaluateAndNotify call. Dedup means a
// user-facing notification fires once per re-fire window regardless of
// which actor pushes it.

export async function runHealthCheckBestEffort(
  db: Db,
  adapters: AdapterRegistry,
  logger: Logger,
): Promise<void> {
  try {
    const channel = createMacOsNotificationChannel();
    const states = collectAdapterStates(db, adapters);
    const input = buildConditionsInput(
      states,
      readHeartbeatMtime(getDefaultHeartbeatPath()),
      new Date(),
    );
    await evaluateAndNotify({ db, channel }, input);
  } catch (err) {
    // Never let a notification-side failure block tool serving — this is a
    // best-effort health check, not load-bearing.
    logger.warn({ err }, 'daemon health check failed');
  }
}
