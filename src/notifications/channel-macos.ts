import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Notification, NotificationChannel } from './types.js';

const execFileAsync = promisify(execFile);

// AppleScript escaping: backslash and double-quote are the only chars that
// matter inside a quoted string. Newlines stay literal in single-line scripts.
function escapeForAppleScript(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildScript(notification: Notification): string {
  const title = escapeForAppleScript(notification.title);
  const message = escapeForAppleScript(notification.message);
  return `display notification "${message}" with title "${title}"`;
}

// macOS-native notification channel. Shells out to /usr/bin/osascript because
// it's pre-installed on every Mac and needs zero additional dependencies.
// Falls back silently on non-Mac platforms — `osascript` will not exist and
// execFile will reject; callers should wrap in try/catch when running on a
// host that may not be macOS (e.g., CI).
export function createMacOsNotificationChannel(): NotificationChannel {
  return {
    send: async (notification: Notification): Promise<void> => {
      await execFileAsync('/usr/bin/osascript', ['-e', buildScript(notification)]);
    },
  };
}
