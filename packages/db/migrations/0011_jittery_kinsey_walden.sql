CREATE TABLE `ai_image_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`intake_id` text NOT NULL,
	`media_id` text NOT NULL,
	`sha256` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`provider_version` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_until` integer,
	`lease_token` text,
	`error_code` text,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`intake_id`) REFERENCES `intake_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`media_id`) REFERENCES `intake_media`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_image_result_json_check" CHECK("ai_image_jobs"."result" IS NULL OR json_valid("ai_image_jobs"."result")),
	CONSTRAINT "ai_image_status_check" CHECK("ai_image_jobs"."status" IN ('pending','processing','succeeded','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_image_jobs_dedupe_idx` ON `ai_image_jobs` (`intake_id`,`sha256`,`provider`,`model`,`provider_version`);--> statement-breakpoint
CREATE INDEX `ai_image_jobs_due_idx` ON `ai_image_jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `ai_usage_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`task_type` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`duration_ms` integer NOT NULL,
	`success` integer NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `ai_image_jobs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_usage_task_check" CHECK("ai_usage_logs"."task_type"='image_extraction'),
	CONSTRAINT "ai_usage_count_check" CHECK(("ai_usage_logs"."input_tokens" IS NULL OR "ai_usage_logs"."input_tokens">=0) AND ("ai_usage_logs"."output_tokens" IS NULL OR "ai_usage_logs"."output_tokens">=0) AND "ai_usage_logs"."duration_ms">=0)
);
--> statement-breakpoint
CREATE INDEX `ai_usage_model_time_idx` ON `ai_usage_logs` (`provider`,`model`,`created_at`);--> statement-breakpoint
ALTER TABLE `intake_items` ADD `received_data` text;--> statement-breakpoint
ALTER TABLE `intake_items` ADD `extraction_key` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `selected_status` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `completed_by_user_id` text REFERENCES `user`(`id`) ON DELETE restrict;--> statement-breakpoint
ALTER TABLE `reports` ADD `completed_at` integer;--> statement-breakpoint
ALTER TABLE `reports` ADD `callback_token` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `telegram_user_id` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `callback_route_id` text REFERENCES `telegram_routes`(`id`) ON DELETE restrict;--> statement-breakpoint
ALTER TABLE `reports` ADD `workflow_status` text DEFAULT 'completed' NOT NULL CONSTRAINT `reports_workflow_check` CHECK(workflow_status IN ('awaiting_status','completed') AND (workflow_status<>'awaiting_status' OR (source='telegram' AND callback_token IS NOT NULL AND telegram_user_id IS NOT NULL AND callback_route_id IS NOT NULL AND assignment_id IS NOT NULL AND status='needs_review' AND completed_at IS NULL)));--> statement-breakpoint
CREATE UNIQUE INDEX `reports_callback_token_unique` ON `reports` (`callback_token`);