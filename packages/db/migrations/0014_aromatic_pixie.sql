CREATE TABLE `bulk_assignment_items` (
	`id` text PRIMARY KEY NOT NULL,
	`bulk_assignment_id` text NOT NULL,
	`requested_case_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`assignment_id` text,
	`outbound_job_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bulk_assignment_id`) REFERENCES `bulk_assignments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`outbound_job_id`) REFERENCES `telegram_outbound_jobs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "bulk_assignment_item_status_check" CHECK("bulk_assignment_items"."status" IN ('pending','assigned','skipped','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bulk_assignment_items_assignment_id_unique` ON `bulk_assignment_items` (`assignment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bulk_assignment_items_outbound_job_id_unique` ON `bulk_assignment_items` (`outbound_job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bulk_assignment_case_idx` ON `bulk_assignment_items` (`bulk_assignment_id`,`requested_case_id`);--> statement-breakpoint
CREATE TABLE `bulk_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`created_by_user_id` text NOT NULL,
	`collector_id` text NOT NULL,
	`route_id` text NOT NULL,
	`request` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`route_id`) REFERENCES `telegram_routes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "bulk_assignments_json_check" CHECK(json_valid("bulk_assignments"."request"))
);
--> statement-breakpoint
CREATE INDEX `bulk_assignments_actor_time_idx` ON `bulk_assignments` (`created_by_user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `telegram_outbound_jobs` ADD `assignment_id` text REFERENCES assignments(id);--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_outbound_jobs_assignment_id_unique` ON `telegram_outbound_jobs` (`assignment_id`);