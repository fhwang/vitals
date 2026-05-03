import { join } from 'node:path';

import { z } from 'zod';

import { parseStorageUrl } from './storage/url.js';
import type { StorageConfig } from './storage/url.js';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  VITALS_STORAGE_URL: z
    .string()
    .min(1)
    .transform((url, ctx) => {
      try {
        return parseStorageUrl(url);
      } catch (err) {
        ctx.addIssue({
          code: 'custom',
          message: err instanceof Error ? err.message : String(err),
        });
        return z.NEVER;
      }
    }),
  VITALS_DB_PATH: z.string().min(1).optional(),
});

function reportInvalidEnv(error: z.ZodError): never {
  console.error('Invalid environment configuration:');
  for (const issue of error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

function resolveDbPath(storage: StorageConfig, override: string | undefined): string {
  if (override !== undefined) return override;
  if (storage.driver === 'local') return join(storage.root, 'vitals.db');
  console.error(
    'VITALS_DB_PATH is required when VITALS_STORAGE_URL is non-local (machine-local SQLite must live on disk).',
  );
  process.exit(1);
}

export function loadConfig() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) reportInvalidEnv(parsed.error);
  const { VITALS_STORAGE_URL, VITALS_DB_PATH, ...rest } = parsed.data;
  return {
    ...rest,
    storage: VITALS_STORAGE_URL,
    dbPath: resolveDbPath(VITALS_STORAGE_URL, VITALS_DB_PATH),
  };
}
