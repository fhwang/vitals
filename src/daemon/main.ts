import '../preflight.js';

import { createMacOsNotificationChannel } from '#notifications';

import { buildCore } from '../bootstrap.js';
import { getDefaultHeartbeatPath } from './paths.js';
import { runDaemonTick, type DaemonTickDeps } from './tick.js';

function buildTickDeps(core: ReturnType<typeof buildCore>): DaemonTickDeps {
  return {
    db: core.db,
    store: core.store,
    logger: core.logger,
    channel: createMacOsNotificationChannel(),
    adapters: core.adapters,
    heartbeatPath: getDefaultHeartbeatPath(),
  };
}

async function main(): Promise<void> {
  await runDaemonTick(buildTickDeps(buildCore(true)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `vitals-daemon fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
