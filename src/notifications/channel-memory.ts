import type { Notification, NotificationChannel } from './types.js';

export interface MemoryNotificationChannel extends NotificationChannel {
  readonly sent: readonly Notification[];
  reset(): void;
}

// In-memory channel for tests: records each notification rather than
// delivering it. Tests can read `.sent` to assert which notifications fired
// in which order, and call `.reset()` between scenarios.
export function createMemoryNotificationChannel(): MemoryNotificationChannel {
  const sent: Notification[] = [];
  return {
    get sent() {
      return sent;
    },
    send: (notification: Notification): Promise<void> => {
      sent.push(notification);
      return Promise.resolve();
    },
    reset(): void {
      sent.length = 0;
    },
  };
}
