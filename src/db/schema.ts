import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sourceDocuments = sqliteTable('source_documents', {
  id: integer('id').primaryKey(),
  kind: text('kind').notNull(),
  source: text('source').notNull(),
  original_filename: text('original_filename'),
  ingested_at: text('ingested_at').notNull(),
  archive_key: text('archive_key').notNull().unique(),
  content_hash: text('content_hash').notNull(),
  metadata_json: text('metadata_json'),
});

export const observations = sqliteTable(
  'observations',
  {
    id: integer('id').primaryKey(),
    coding_system: text('coding_system').notNull(),
    coding_code: text('coding_code').notNull(),
    coding_display: text('coding_display'),
    effective_start: text('effective_start').notNull(),
    effective_end: text('effective_end'),
    value_quantity: real('value_quantity'),
    value_string: text('value_string'),
    value_unit: text('value_unit'),
    ref_range: text('ref_range'),
    interpretation: text('interpretation'),
    source_document_id: integer('source_document_id')
      .notNull()
      .references(() => sourceDocuments.id, { onDelete: 'cascade' }),
  },
  (t) => [
    index('idx_obs_coding_time').on(t.coding_code, t.effective_start),
    index('idx_obs_time').on(t.effective_start),
    index('idx_obs_source').on(t.source_document_id),
  ],
);

export const adapterCredentials = sqliteTable('adapter_credentials', {
  adapter_name: text('adapter_name').primaryKey(),
  credentials_json: text('credentials_json').notNull(),
  revision: integer('revision').notNull().default(0),
  updated_at: text('updated_at').notNull(),
});

export const adapterState = sqliteTable('adapter_state', {
  adapter_name: text('adapter_name').primaryKey(),
  last_sync_at: text('last_sync_at'),
  last_sync_status: text('last_sync_status'),
  last_error_message: text('last_error_message'),
  last_synced_window_end: text('last_synced_window_end'),
});

// Re-export sql tag for query sites that need raw SQL fragments.
export { sql };
