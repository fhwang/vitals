import { createInterface } from 'node:readline/promises';

import { writeOuraCredentials } from '#adapters';
import { openDatabase } from '#db';
import { loadConfig } from '../src/config.js';

// One-time setup: prompt for an Oura personal access token (PAT) and store it
// in the adapter_credentials table. Run as `pnpm connect:oura`.
//
// To generate a PAT, sign in at https://cloud.ouraring.com, navigate to
// Personal Access Tokens, and create a new token with the scopes vitals
// needs (sleep data; daily-readiness/activity if you want them in V2).

async function main(): Promise<void> {
  const tokenFromEnv = process.env['OURA_PAT'];
  const token =
    tokenFromEnv !== undefined && tokenFromEnv !== '' ? tokenFromEnv : await promptForToken();
  if (token === '') {
    process.stderr.write('No token provided. Aborting.\n');
    process.exit(1);
  }
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  writeOuraCredentials(db, { access_token: token });
  process.stdout.write('Stored Oura access token in adapter_credentials.\n');
}

async function promptForToken(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Paste Oura personal access token: ');
    return answer.trim();
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
