import { z } from 'zod';

import { parseStorageUrl, type StorageConfig } from './storage/url.js';

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
});

export interface Config {
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  storage: StorageConfig;
}

function reportInvalidEnv(error: z.ZodError): never {
  console.error('Invalid environment configuration:');
  for (const issue of error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) reportInvalidEnv(parsed.error);
  const { VITALS_STORAGE_URL, ...rest } = parsed.data;
  return { ...rest, storage: VITALS_STORAGE_URL };
}
