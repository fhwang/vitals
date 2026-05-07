CREATE TABLE `adapter_credentials` (
	`adapter_name` text PRIMARY KEY NOT NULL,
	`credentials_json` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `adapter_state` (
	`adapter_name` text PRIMARY KEY NOT NULL,
	`last_sync_at` text,
	`last_sync_status` text,
	`last_error_message` text,
	`last_synced_window_end` text
);
--> statement-breakpoint
CREATE TABLE `observations` (
	`id` integer PRIMARY KEY NOT NULL,
	`coding_system` text NOT NULL,
	`coding_code` text NOT NULL,
	`coding_display` text,
	`effective_start` text NOT NULL,
	`effective_end` text,
	`value_quantity` real,
	`value_string` text,
	`value_unit` text,
	`ref_range` text,
	`interpretation` text,
	`source_document_id` integer NOT NULL,
	FOREIGN KEY (`source_document_id`) REFERENCES `source_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_obs_coding_time` ON `observations` (`coding_code`,`effective_start`);--> statement-breakpoint
CREATE INDEX `idx_obs_time` ON `observations` (`effective_start`);--> statement-breakpoint
CREATE INDEX `idx_obs_source` ON `observations` (`source_document_id`);--> statement-breakpoint
CREATE TABLE `source_documents` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`original_filename` text,
	`ingested_at` text NOT NULL,
	`archive_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`metadata_json` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_documents_archive_key_unique` ON `source_documents` (`archive_key`);