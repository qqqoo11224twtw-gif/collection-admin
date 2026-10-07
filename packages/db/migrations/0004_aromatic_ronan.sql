CREATE TABLE `assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`collector_id` text NOT NULL,
	`assigned_by_user_id` text NOT NULL,
	`assigned_at` integer NOT NULL,
	`unassigned_at` integer,
	`note` text,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assigned_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "assignments_dates_check" CHECK("assignments"."unassigned_at" IS NULL OR "assignments"."unassigned_at" >= "assignments"."assigned_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assignments_current_case_idx` ON `assignments` (`case_id`) WHERE "assignments"."unassigned_at" IS NULL;--> statement-breakpoint
CREATE INDEX `assignments_case_time_idx` ON `assignments` (`case_id`,`assigned_at`);--> statement-breakpoint
CREATE INDEX `assignments_collector_idx` ON `assignments` (`collector_id`,`unassigned_at`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`metadata` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_logs_json_check" CHECK(json_valid("audit_logs"."metadata"))
);
--> statement-breakpoint
CREATE INDEX `audit_logs_entity_time_idx` ON `audit_logs` (`entity_type`,`entity_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `audit_logs_user_time_idx` ON `audit_logs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `collectors` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`code` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`write_token` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "collectors_name_check" CHECK(length(trim("collectors"."display_name")) > 0 AND length(trim("collectors"."code")) > 0),
	CONSTRAINT "collectors_active_check" CHECK("collectors"."is_active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collectors_code_idx` ON `collectors` ("code" COLLATE NOCASE);--> statement-breakpoint
CREATE UNIQUE INDEX `collectors_user_idx` ON `collectors` (`user_id`);--> statement-breakpoint
CREATE INDEX `collectors_active_idx` ON `collectors` (`is_active`,`display_name`);--> statement-breakpoint
ALTER TABLE `cases` ADD `version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `cases` ADD `write_token` text DEFAULT '' NOT NULL;