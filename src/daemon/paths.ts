import { homedir } from 'node:os';
import { join } from 'node:path';

// Touched by the daemon at the end of every successful tick; read by the MCP
// server on startup. `~/.local/state/` is the XDG-ish convention for runtime
// state on macOS (no widely-used Library subdir matches; user-local state in
// dotfile land keeps installs self-contained).
export function getDefaultHeartbeatPath(): string {
  return join(homedir(), '.local', 'state', 'vitals', 'heartbeat');
}
