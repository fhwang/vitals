import { eq } from 'drizzle-orm';

import { adapterCredentials, type Db } from '#db';

// Oura uses a long-lived personal access token (PAT), not OAuth with refresh.
// We store the PAT in the shared `adapter_credentials` table under
// `adapter_name = 'oura'` — same row shape as Fitbit, but the JSON payload is
// `{ access_token }` only (no refresh_token, no expires_at). The shared
// credentials store assumes the OAuth-shaped TokenSet, which is why Oura
// reads/writes its row through this small accessor instead.

export const OURA_ADAPTER_NAME = 'oura';

export interface OuraCredentials {
  access_token: string;
}

// Loose parse shape used for the raw JSON read out of credentials_json. The
// validated `OuraCredentials` is what callers ever see — this loose form is
// internal-only.
interface OuraCredentialsCandidate {
  access_token?: unknown;
}

export function readOuraCredentials(db: Db): OuraCredentials | null {
  const row = db
    .select({ credentials_json: adapterCredentials.credentials_json })
    .from(adapterCredentials)
    .where(eq(adapterCredentials.adapter_name, OURA_ADAPTER_NAME))
    .get();
  if (row === undefined) return null;
  const parsed = JSON.parse(row.credentials_json) as OuraCredentialsCandidate;
  if (typeof parsed.access_token !== 'string' || parsed.access_token === '') return null;
  return { access_token: parsed.access_token };
}

export function writeOuraCredentials(db: Db, credentials: OuraCredentials): void {
  const now = new Date().toISOString();
  const json = JSON.stringify(credentials);
  db.insert(adapterCredentials)
    .values({
      adapter_name: OURA_ADAPTER_NAME,
      credentials_json: json,
      revision: 0,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: adapterCredentials.adapter_name,
      set: { credentials_json: json, updated_at: now },
    })
    .run();
}
