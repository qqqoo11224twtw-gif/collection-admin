CREATE TABLE `system_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` integer NOT NULL,
	`level` text NOT NULL,
	`category` text NOT NULL,
	`event` text NOT NULL,
	`status` text NOT NULL,
	`safe_message` text NOT NULL,
	`related_case_id` text,
	`related_collector_id` text,
	`related_job_id` text,
	`related_route_id` text,
	`related_user_id` text,
	`correlation_id` text NOT NULL,
	`duration_ms` integer,
	`retry_count` integer,
	`error_code` text,
	`handled_status` text DEFAULT 'pending' NOT NULL,
	`handled_by` text,
	`handled_at` integer,
	`note` text,
	FOREIGN KEY (`handled_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `system_logs_time_idx` ON `system_logs` (`timestamp`);--> statement-breakpoint
CREATE INDEX `system_logs_filter_idx` ON `system_logs` (`category`,`level`,`timestamp`);--> statement-breakpoint
CREATE INDEX `system_logs_case_idx` ON `system_logs` (`related_case_id`);--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_telegram_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
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
	CONSTRAINT "telegram_route_type_check" CHECK("__new_telegram_routes"."route_type" IN ('collector','report_destination','intake_source','intake','collector_dispatch','collector_report','business_report')),
	CONSTRAINT "telegram_route_topic_check" CHECK("__new_telegram_routes"."topic_id" IS NULL OR "__new_telegram_routes"."topic_id">0)
);
--> statement-breakpoint
INSERT INTO `__new_telegram_routes`("id", "name", "collector_id", "chat_id", "topic_id", "route_type", "is_active", "managed_by_user_id", "created_at", "updated_at") SELECT "id", '', "collector_id", "chat_id", "topic_id", "route_type", "is_active", "managed_by_user_id", "created_at", "updated_at" FROM `telegram_routes`;--> statement-breakpoint
DROP TABLE `telegram_routes`;--> statement-breakpoint
ALTER TABLE `__new_telegram_routes` RENAME TO `telegram_routes`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_routes_target_idx` ON `telegram_routes` (`chat_id`,coalesce("topic_id",0),`route_type`);--> statement-breakpoint
ALTER TABLE `user` ADD `active` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `permission_allow` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `permission_deny` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `permission_version` integer DEFAULT 0 NOT NULL;
