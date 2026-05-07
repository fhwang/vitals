import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { StorageConfig } from '#storage';

export const GOOGLE_HEALTH_CREDENTIALS_KEY = 'googlehealth';
const CONFIG_RELATIVE_PATH = 'config/google-health.json';

const AuthConfigSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
});

export interface GoogleHealthAuthConfig {
  client_id: string;
  client_secret: string;
}

// Resolution order: env vars first (escape hatch for CI / dev override), then
// the sidecar JSON file inside the archive directory. The archive owns its own
// auth config so the harness doesn't need to plumb credentials.
export function loadGoogleHealthAuthConfig(storage?: StorageConfig): GoogleHealthAuthConfig | null {
  const fromEnv = readEnv();
  if (fromEnv !== null) return fromEnv;
  if (storage?.driver === 'local') {
    return readFile(authConfigPath(storage.root));
  }
  return null;
}

export function saveGoogleHealthAuthConfig(
  storage: StorageConfig,
  config: GoogleHealthAuthConfig,
): void {
  if (storage.driver !== 'local') {
    throw new Error('saving google-health auth config requires a file:// VITALS_STORAGE_URL');
  }
  const path = authConfigPath(storage.root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export function authConfigPath(archiveRoot: string): string {
  return join(archiveRoot, CONFIG_RELATIVE_PATH);
}

function readEnv(): GoogleHealthAuthConfig | null {
  const client_id = process.env['GOOGLE_HEALTH_CLIENT_ID'];
  const client_secret = process.env['GOOGLE_HEALTH_CLIENT_SECRET'];
  if (
    client_id === undefined ||
    client_id === '' ||
    client_secret === undefined ||
    client_secret === ''
  ) {
    return null;
  }
  return { client_id, client_secret };
}

function readFile(path: string): GoogleHealthAuthConfig | null {
  if (!existsSync(path)) return null;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${path}: invalid JSON: ${message}`, { cause: err });
  }
  const parsed = AuthConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${path}: invalid google-health auth config: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}
