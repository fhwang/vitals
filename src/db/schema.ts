import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

// Per-adapter per-day ingestion bookkeeping for adapters that pull daily
// sample batches. One row per (adapter_name, date) carrying the rolling
// sample counts the confidence model's stability check reads.
export const adapterDayState = sqliteTable(
  'adapter_day_state',
  {
    adapter_name: text('adapter_name').notNull(),
    date: text('date').notNull(),
    samples_count: integer('samples_count').notNull(),
    samples_count_prev: integer('samples_count_prev'),
    last_pulled_at: text('last_pulled_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.adapter_name, t.date] })],
);

export const adapterState = sqliteTable('adapter_state', {
  adapter_name: text('adapter_name').primaryKey(),
  last_sync_at: text('last_sync_at'),
  last_sync_status: text('last_sync_status'),
  last_error_message: text('last_error_message'),
  last_error_reason: text('last_error_reason'),
  last_synced_window_end: text('last_synced_window_end'),
  freshness_frontier_at: text('freshness_frontier_at'),
  successful_ticks_since_frontier_advance: integer('successful_ticks_since_frontier_advance')
    .notNull()
    .default(0),
  consecutive_sync_failures: integer('consecutive_sync_failures').notNull().default(0),
});

// Tracks the current state of each notification "condition" (a specific
// failure mode the user might want to know about). Keyed by condition_id.
// last_fired_at is when we most recently *sent* a notification for this
// condition; last_state is whether the condition was firing or resolved as
// of the last evaluation.
export const notificationState = sqliteTable('notification_state', {
  condition_id: text('condition_id').primaryKey(),
  last_fired_at: text('last_fired_at'),
  last_state: text('last_state').notNull(),
});

// Append-only log of every notification actually sent. Lets the user audit
// "what has vitals paged me about lately?" via an MCP tool, especially useful
// when a notification was missed at delivery time.
export const notificationLog = sqliteTable('notification_log', {
  id: integer('id').primaryKey(),
  condition_id: text('condition_id').notNull(),
  fired_at: text('fired_at').notNull(),
  severity: text('severity').notNull(),
  title: text('title').notNull(),
  message: text('message').notNull(),
});

// Re-export sql tag for query sites that need raw SQL fragments.
export { sql };
