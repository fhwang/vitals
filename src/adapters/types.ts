import type { Logger } from 'pino';
import type { z } from 'zod';

import type { Db } from '#db';
import type { BlobStore } from '#storage';

import type { AdapterNotificationProfile } from './notifications.js';

export type SyncErrorReason = 'reauth_required' | 'parse_error' | 'transient' | 'no_credentials';

export class SyncError extends Error {
  public readonly reason: SyncErrorReason;
  public readonly details: unknown;

  constructor(reason: SyncErrorReason, message: string, details?: unknown) {
    super(message);
    this.name = 'SyncError';
    this.reason = reason;
    this.details = details;
  }
}

export interface SyncResult {
  adapter: string;
  days_pulled: number;
  samples_added: number;
  samples_existing: number;
  last_synced_at: string;
}

export interface AdapterContext {
  db: Db;
  store: BlobStore;
  logger: Logger;
}

export interface Adapter {
  name: string;
  description: string;
  parameter_schema: z.ZodType;
  requires_auth: boolean;
  notification_profile: AdapterNotificationProfile;
  sync(params: unknown, ctx: AdapterContext): Promise<SyncResult>;
}
