import { join } from 'node:path';

import {
  GOOGLE_HEALTH_CREDENTIALS_KEY,
  authConfigPath,
  createAdapterCredentialsStore,
  loadGoogleHealthAuthConfig,
  runGoogleHealthOAuthFlow,
  saveGoogleHealthAuthConfig,
  type GoogleHealthAuthConfig,
} from '#adapters';
import { openDatabase } from '#db';
import type { StorageConfig } from '#storage';

function localStorageConfig(archiveRoot: string): StorageConfig {
  return { driver: 'local', root: archiveRoot };
}

const HR_SCOPE =
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly';

const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  '--archive-root',
  '--client-id',
  '--client-secret',
  '--login-hint',
]);

function takeNext(argv: readonly string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === undefined) continue;
    if (!KNOWN_FLAGS.has(flag)) throw new Error(`unknown arg: ${flag}`);
    flags.set(flag, takeNext(argv, i, flag));
    i++;
  }
  return flags;
}

function ensureArchiveRoot(flags: Map<string, string>): string {
  const archiveRoot = flags.get('--archive-root');
  if (archiveRoot === undefined) throw new Error('--archive-root is required');
  return archiveRoot;
}

function saveCredentialsIfProvided(archiveRoot: string, flags: Map<string, string>): void {
  const clientId = flags.get('--client-id');
  const clientSecret = flags.get('--client-secret');
  if (clientId === undefined && clientSecret === undefined) return;
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error('--client-id and --client-secret must be passed together');
  }
  saveGoogleHealthAuthConfig(localStorageConfig(archiveRoot), {
    client_id: clientId,
    client_secret: clientSecret,
  });
  process.stdout.write(`saved ${authConfigPath(archiveRoot)}\n`);
}

function ensureAuth(archiveRoot: string): GoogleHealthAuthConfig {
  const auth = loadGoogleHealthAuthConfig(localStorageConfig(archiveRoot));
  if (auth === null) {
    throw new Error(
      'No Google Health OAuth client found. Pass --client-id and --client-secret on first run.',
    );
  }
  return auth;
}

async function runConnect(
  archiveRoot: string,
  auth: GoogleHealthAuthConfig,
  loginHint: string | undefined,
): Promise<void> {
  const dbPath = join(archiveRoot, 'vitals.db');
  const db = openDatabase(dbPath);
  const tokens = await runGoogleHealthOAuthFlow(auth, [HR_SCOPE], loginHint);
  createAdapterCredentialsStore(db).upsert(GOOGLE_HEALTH_CREDENTIALS_KEY, tokens);
  process.stdout.write(`connected ${GOOGLE_HEALTH_CREDENTIALS_KEY}; refresh_token stored\n`);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const archiveRoot = ensureArchiveRoot(flags);
  saveCredentialsIfProvided(archiveRoot, flags);
  const auth = ensureAuth(archiveRoot);
  await runConnect(archiveRoot, auth, flags.get('--login-hint'));
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
