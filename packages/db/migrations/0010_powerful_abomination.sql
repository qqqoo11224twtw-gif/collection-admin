CREATE TABLE `telegram_albums` (
	`id` text PRIMARY KEY NOT NULL,
	`intake_id` text,
	`route_id` text NOT NULL,
	`due_at` integer NOT NULL,
	`finalized_at` integer,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`intake_id`) REFERENCES `intake_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`route_id`) REFERENCES `telegram_routes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `telegram_album_due_idx` ON `telegram_albums` (`due_at`,`finalized_at`);--> statement-breakpoint
CREATE TABLE `telegram_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`telegram_user_id` text NOT NULL,
	`collector_id` text,
	`user_id` text,
	`display_name` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_identities_telegram_user_id_unique` ON `telegram_identities` (`telegram_user_id`);--> statement-breakpoint
CREATE TABLE `telegram_outbound_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`message_type` text NOT NULL,
	`report_id` text,
	`route_id` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`lease_until` integer,
	`lease_token` text,
	`telegram_message_id` text,
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`route_id`) REFERENCES `telegram_routes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "telegram_outbound_json_check" CHECK(json_valid("telegram_outbound_jobs"."payload")),
	CONSTRAINT "telegram_outbound_status_check" CHECK("telegram_outbound_jobs"."status" IN ('pending','sending','sent','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_outbound_jobs_dedupe_key_unique` ON `telegram_outbound_jobs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `telegram_outbound_due_idx` ON `telegram_outbound_jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `telegram_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`collector_id` text,
	`chat_id` text NOT NULL,
	`topic_id` integer,
	`route_type` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`managed_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`managed_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "telegram_route_type_check" CHECK("telegram_routes"."route_type" IN ('collector','report_destination','intake_source')),
	CONSTRAINT "telegram_route_topic_check" CHECK("telegram_routes"."topic_id" IS NULL OR "telegram_routes"."topic_id">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_routes_target_idx` ON `telegram_routes` (`chat_id`,coalesce(`topic_id`,0),`route_type`);--> statement-breakpoint
CREATE TABLE `telegram_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_until` integer,
	`lease_token` text,
	`album_id` text,
	`intake_id` text,
	`media_id` text,
	`report_id` text,
	`result_code` text,
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`processed_at` integer,
	FOREIGN KEY (`album_id`) REFERENCES `telegram_albums`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`intake_id`) REFERENCES `intake_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`media_id`) REFERENCES `intake_media`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "telegram_update_json_check" CHECK(json_valid("telegram_updates"."payload")),
	CONSTRAINT "telegram_update_status_check" CHECK("telegram_updates"."status" IN ('pending','processing','done','failed'))
);
--> statement-breakpoint
CREATE INDEX `telegram_updates_due_idx` ON `telegram_updates` (`status`,`next_attempt_at`);--> statement-breakpoint
ALTER TABLE `reports` ADD `origin_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `reports_origin_key_unique` ON `reports` (`origin_key`);
