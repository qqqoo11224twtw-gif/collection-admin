CREATE TABLE `installment_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`report_id` text,
	`collector_id` text,
	`plan_type` text NOT NULL,
	`total_amount` integer NOT NULL,
	`per_payment_amount` integer,
	`weekday` integer,
	`day_of_month` integer,
	`deadline_date` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`write_token` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "installment_amount_check" CHECK("installment_plans"."total_amount">0 AND "installment_plans"."total_amount"<=1000000000000 AND ("installment_plans"."per_payment_amount" IS NULL OR ("installment_plans"."per_payment_amount">0 AND "installment_plans"."per_payment_amount"<="installment_plans"."total_amount"))),
	CONSTRAINT "installment_type_check" CHECK(("installment_plans"."plan_type"='deadline' AND "installment_plans"."deadline_date" IS NOT NULL AND "installment_plans"."per_payment_amount" IS NULL AND "installment_plans"."weekday" IS NULL AND "installment_plans"."day_of_month" IS NULL) OR ("installment_plans"."plan_type"='weekly' AND "installment_plans"."weekday" BETWEEN 1 AND 7 AND "installment_plans"."per_payment_amount" IS NOT NULL AND "installment_plans"."day_of_month" IS NULL AND "installment_plans"."deadline_date" IS NULL) OR ("installment_plans"."plan_type"='monthly' AND "installment_plans"."day_of_month" BETWEEN 1 AND 31 AND "installment_plans"."per_payment_amount" IS NOT NULL AND "installment_plans"."weekday" IS NULL AND "installment_plans"."deadline_date" IS NULL)),
	CONSTRAINT "installment_status_check" CHECK("installment_plans"."status" IN ('active','completed','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installment_report_idx` ON `installment_plans` (`report_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `installment_active_case_idx` ON `installment_plans` (`case_id`) WHERE "installment_plans"."status"='active';--> statement-breakpoint
CREATE INDEX `installment_case_idx` ON `installment_plans` (`case_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `installment_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`case_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`due_date` text NOT NULL,
	`expected_amount` integer NOT NULL,
	`paid_amount` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `installment_plans`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "schedule_amount_check" CHECK("installment_schedules"."expected_amount">0 AND "installment_schedules"."paid_amount">=0 AND "installment_schedules"."paid_amount"<="installment_schedules"."expected_amount"),
	CONSTRAINT "schedule_status_check" CHECK("installment_schedules"."status" IN ('pending','partial','paid','overdue','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_plan_sequence_idx` ON `installment_schedules` (`plan_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `schedule_case_due_idx` ON `installment_schedules` (`case_id`,`due_date`);--> statement-breakpoint
CREATE TABLE `installment_workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`case_id` text NOT NULL,
	`report_id` text NOT NULL,
	`assignment_id` text NOT NULL,
	`collector_id` text NOT NULL,
	`user_id` text NOT NULL,
	`telegram_user_id` text NOT NULL,
	`route_id` text NOT NULL,
	`step` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`plan_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`last_update_id` text,
	`write_token` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`route_id`) REFERENCES `telegram_routes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`plan_id`) REFERENCES `installment_plans`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "workflow_json_check" CHECK(json_valid("installment_workflows"."data")),
	CONSTRAINT "workflow_status_check" CHECK("installment_workflows"."status" IN ('active','completed','cancelled','expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installment_workflows_token_unique` ON `installment_workflows` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `installment_workflows_report_id_unique` ON `installment_workflows` (`report_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_active_sender_route_idx` ON `installment_workflows` (`telegram_user_id`,`route_id`) WHERE "installment_workflows"."status"='active';--> statement-breakpoint
CREATE INDEX `workflow_expiry_idx` ON `installment_workflows` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`case_id` text NOT NULL,
	`installment_plan_id` text,
	`installment_schedule_id` text,
	`collector_id` text,
	`received_date` text NOT NULL,
	`received_amount` integer NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`source` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`write_token` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`installment_plan_id`) REFERENCES `installment_plans`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`installment_schedule_id`) REFERENCES `installment_schedules`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payments_amount_check" CHECK("payments"."received_amount">0 AND "payments"."received_amount"<=1000000000000),
	CONSTRAINT "payments_status_check" CHECK("payments"."status" IN ('received','voided')),
	CONSTRAINT "payments_source_check" CHECK("payments"."source" IN ('telegram','admin','installment','manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_idempotency_key_unique` ON `payments` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `payments_case_date_idx` ON `payments` (`case_id`,`received_date`);--> statement-breakpoint
CREATE INDEX `payments_schedule_idx` ON `payments` (`installment_schedule_id`,`status`);--> statement-breakpoint
CREATE TABLE `settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`case_id` text NOT NULL,
	`collector_id` text,
	`received_date` text NOT NULL,
	`agent_code_snapshot` text NOT NULL,
	`customer_name_snapshot` text NOT NULL,
	`received_amount` integer NOT NULL,
	`commission_rate` real NOT NULL,
	`commission_amount` integer NOT NULL,
	`return_amount` integer NOT NULL,
	`return_status` text DEFAULT 'pending' NOT NULL,
	`returned_at` integer,
	`returned_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`write_token` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`returned_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "settlement_amount_check" CHECK("settlements"."commission_rate" BETWEEN 0 AND 1 AND "settlements"."commission_amount">=0 AND "settlements"."return_amount">=0 AND "settlements"."commission_amount"+"settlements"."return_amount"="settlements"."received_amount"),
	CONSTRAINT "settlement_return_check" CHECK(("settlements"."return_status"='pending' AND "settlements"."returned_at" IS NULL AND "settlements"."returned_by_user_id" IS NULL) OR ("settlements"."return_status"='returned' AND "settlements"."returned_at" IS NOT NULL AND "settlements"."returned_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlements_payment_id_unique` ON `settlements` (`payment_id`);--> statement-breakpoint
CREATE INDEX `settlements_date_status_idx` ON `settlements` (`received_date`,`return_status`);--> statement-breakpoint
ALTER TABLE `assignments` ADD `record_type` text DEFAULT 'assignment' NOT NULL;--> statement-breakpoint
ALTER TABLE `assignments` ADD `corrected_from_id` text;--> statement-breakpoint
ALTER TABLE `assignments` ADD `correction_reason` text;--> statement-breakpoint
ALTER TABLE `cases` ADD `region` text;--> statement-breakpoint
ALTER TABLE `cases` ADD `manual_entry_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `cases_manual_entry_key_unique` ON `cases` (`manual_entry_key`);--> statement-breakpoint
CREATE INDEX `cases_region_updated_idx` ON `cases` (`region`,`updated_at`,`id`);