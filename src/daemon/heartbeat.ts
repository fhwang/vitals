import { closeSync, mkdirSync, openSync, statSync, utimesSync } from 'node:fs';
import { dirname } from 'node:path';

// File the daemon touches on every successful tick. The MCP server checks
// its mtime when serving any tool request — if older than the
// daemon-heartbeat-stale threshold, it fires a notification so the user
// learns the daemon is down by the next time they (or their harness)
// query vitals.
//
// We touch a file rather than write rich JSON because the only thing
// callers need is the mtime, and touch-style updates are atomic.

export function writeHeartbeat(path: string, now: Date = new Date()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, 'a');
  } catch {
    fd = openSync(path, 'w');
  }
  try {
    utimesSync(path, now, now);
  } finally {
    closeSync(fd);
  }
}

export function readHeartbeatMtime(path: string): Date | null {
  try {
    return statSync(path).mtime;
  } catch (err) {
    if (isMissingFile(err)) return null;
    throw err;
  }
}

function isMissingFile(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
