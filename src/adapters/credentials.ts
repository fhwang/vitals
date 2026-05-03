import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/index.js';
import { adapterCredentials } from '../db/schema.js';

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

export class AdapterCredentialsStore {
  constructor(private readonly db: Db) {}

  read(adapterName: string): CredentialsRow | null {
    const row = this.db
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

  insert(adapterName: string, tokens: TokenSet): CredentialsRow {
    const now = new Date().toISOString();
    this.db
      .insert(adapterCredentials)
      .values({
        adapter_name: adapterName,
        credentials_json: JSON.stringify(tokens),
        revision: 0,
        updated_at: now,
      })
      .run();
    return { tokens, revision: 0, updated_at: now };
  }

  upsert(adapterName: string, tokens: TokenSet): CredentialsRow {
    const now = new Date().toISOString();
    const credentials_json = JSON.stringify(tokens);
    this.db
      .insert(adapterCredentials)
      .values({ adapter_name: adapterName, credentials_json, revision: 0, updated_at: now })
      .onConflictDoUpdate({
        target: adapterCredentials.adapter_name,
        set: { credentials_json, revision: 0, updated_at: now },
      })
      .run();
    return { tokens, revision: 0, updated_at: now };
  }

  updateAtRevision(
    adapterName: string,
    expectedRevision: number,
    tokens: TokenSet,
  ): CredentialsRow | null {
    const now = new Date().toISOString();
    const result = this.db
      .update(adapterCredentials)
      .set({
        credentials_json: JSON.stringify(tokens),
        revision: sql`${adapterCredentials.revision} + 1`,
        updated_at: now,
      })
      .where(
        and(
          eq(adapterCredentials.adapter_name, adapterName),
          eq(adapterCredentials.revision, expectedRevision),
        ),
      )
      .run();
    if (result.changes === 0) return null;
    return { tokens, revision: expectedRevision + 1, updated_at: now };
  }
}
