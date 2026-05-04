import { and, eq, sql } from 'drizzle-orm';

import { adapterCredentials, type Db } from '#db';

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

export interface CredentialsRow {
  tokens: TokenSet;
  revision: number;
  updated_at: string;
}

export interface CredentialsRevisionUpdate {
  adapterName: string;
  expectedRevision: number;
  tokens: TokenSet;
}

export function createAdapterCredentialsStore(db: Db) {
  return {
    read: (adapterName: string): CredentialsRow | null => readCredentials(db, adapterName),
    insert: (adapterName: string, tokens: TokenSet): CredentialsRow =>
      insertCredentials(db, adapterName, tokens),
    upsert: (adapterName: string, tokens: TokenSet): CredentialsRow =>
      upsertCredentials(db, adapterName, tokens),
    updateAtRevision: (update: CredentialsRevisionUpdate): CredentialsRow | null =>
      updateCredentialsAtRevision(db, update),
  };
}

function readCredentials(db: Db, adapterName: string): CredentialsRow | null {
  const row = db
    .select({
      credentials_json: adapterCredentials.credentials_json,
      revision: adapterCredentials.revision,
      updated_at: adapterCredentials.updated_at,
    })
    .from(adapterCredentials)
    .where(eq(adapterCredentials.adapter_name, adapterName))
    .get();
  if (row === undefined) return null;
  return {
    tokens: JSON.parse(row.credentials_json) as TokenSet,
    revision: row.revision,
    updated_at: row.updated_at,
  };
}

function insertCredentials(db: Db, adapterName: string, tokens: TokenSet): CredentialsRow {
  const now = new Date().toISOString();
  db.insert(adapterCredentials)
    .values({
      adapter_name: adapterName,
      credentials_json: JSON.stringify(tokens),
      revision: 0,
      updated_at: now,
    })
    .run();
  return { tokens, revision: 0, updated_at: now };
}

function upsertCredentials(db: Db, adapterName: string, tokens: TokenSet): CredentialsRow {
  const now = new Date().toISOString();
  const credentials_json = JSON.stringify(tokens);
  db.insert(adapterCredentials)
    .values({ adapter_name: adapterName, credentials_json, revision: 0, updated_at: now })
    .onConflictDoUpdate({
      target: adapterCredentials.adapter_name,
      set: { credentials_json, revision: 0, updated_at: now },
    })
    .run();
  return { tokens, revision: 0, updated_at: now };
}

function updateCredentialsAtRevision(
  db: Db,
  update: CredentialsRevisionUpdate,
): CredentialsRow | null {
  const now = new Date().toISOString();
  const result = db
    .update(adapterCredentials)
    .set({
      credentials_json: JSON.stringify(update.tokens),
      revision: sql`${adapterCredentials.revision} + 1`,
      updated_at: now,
    })
    .where(
      and(
        eq(adapterCredentials.adapter_name, update.adapterName),
        eq(adapterCredentials.revision, update.expectedRevision),
      ),
    )
    .run();
  if (result.changes === 0) return null;
  return { tokens: update.tokens, revision: update.expectedRevision + 1, updated_at: now };
}
