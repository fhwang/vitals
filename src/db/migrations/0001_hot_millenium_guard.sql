CREATE TABLE `adapter_day_state` (
	`adapter_name` text NOT NULL,
	`date` text NOT NULL,
	`samples_count` integer NOT NULL,
	`samples_count_prev` integer,
	`last_pulled_at` text NOT NULL,
	PRIMARY KEY(`adapter_name`, `date`)
);
--> statement-breakpoint
CREATE TABLE `notification_log` (
	`id` integer PRIMARY KEY NOT NULL,
	`condition_id` text NOT NULL,
	`fired_at` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_state` (
	`condition_id` text PRIMARY KEY NOT NULL,
	`last_fired_at` text,
	`last_state` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `adapter_state` ADD `last_error_reason` text;--> statement-breakpoint
ALTER TABLE `adapter_state` ADD `freshness_frontier_at` text;--> statement-breakpoint
ALTER TABLE `adapter_state` ADD `successful_ticks_since_frontier_advance` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `adapter_state` ADD `consecutive_sync_failures` integer DEFAULT 0 NOT NULL;