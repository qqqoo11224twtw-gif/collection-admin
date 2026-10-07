CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`assignment_id` text,
	`collector_id` text,
	`created_by_user_id` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`revisit_status` text,
	`revisit_reason` text,
	`payment_detected` integer DEFAULT false NOT NULL,
	`payment_amount` integer,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "reports_content_check" CHECK(length(trim("reports"."content")) BETWEEN 1 AND 10000),
	CONSTRAINT "reports_status_check" CHECK("reports"."status" IN ('cannot_find','follow_up','installment','settled','unresolved','needs_review')),
	CONSTRAINT "reports_revisit_check" CHECK("reports"."revisit_status" IS NULL OR "reports"."revisit_status" IN ('recommended','observe','not_recommended','not_needed')),
	CONSTRAINT "reports_source_check" CHECK("reports"."source" IN ('admin','collector_portal','telegram','api')),
	CONSTRAINT "reports_payment_check" CHECK("reports"."payment_detected" IN (0,1) AND ("reports"."payment_amount" IS NULL OR ("reports"."payment_detected"=1 AND "reports"."payment_amount" BETWEEN 0 AND 1000000000000))),
	CONSTRAINT "reports_dates_check" CHECK("reports"."updated_at" >= "reports"."created_at")
);
--> statement-breakpoint
CREATE INDEX `reports_case_time_idx` ON `reports` (`case_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `reports_assignment_idx` ON `reports` (`assignment_id`);--> statement-breakpoint
CREATE INDEX `reports_collector_idx` ON `reports` (`collector_id`);--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`case_no` text NOT NULL,
	`code` text NOT NULL,
	`customer_name` text NOT NULL,
	`address` text NOT NULL,
	`amount_due` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`revisit_status` text DEFAULT 'pending' NOT NULL,
	`revisit_reason` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`assigned_agent_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`write_token` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`assigned_agent_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "cases_amount_check" CHECK("__new_cases"."amount_due" >= 0 AND "__new_cases"."amount_due" <= 1000000000000),
	CONSTRAINT "cases_status_check" CHECK("__new_cases"."status" IN ('pending', 'assigned', 'follow_up', 'installment', 'settled', 'unresolved')),
	CONSTRAINT "cases_source_check" CHECK("__new_cases"."source" IN ('manual', 'poster_builder', 'telegram_ai', 'historical_import')),
	CONSTRAINT "cases_revisit_check" CHECK("__new_cases"."revisit_status" IN ('pending', 'recommended', 'not_required', 'observe', 'not_recommended', 'not_needed')),
	CONSTRAINT "cases_required_check" CHECK(length(trim("__new_cases"."case_no")) > 0 AND length(trim("__new_cases"."code")) > 0 AND length(trim("__new_cases"."customer_name")) > 0 AND length(trim("__new_cases"."address")) > 0),
	CONSTRAINT "cases_dates_check" CHECK("__new_cases"."updated_at" >= "__new_cases"."created_at")
);
--> statement-breakpoint
INSERT INTO `__new_cases`("id", "case_no", "code", "customer_name", "address", "amount_due", "status", "revisit_status", "revisit_reason", "source", "assigned_agent_id", "created_at", "updated_at", "version", "write_token") SELECT "id", "case_no", "code", "customer_name", "address", "amount_due", "status", "revisit_status", "revisit_reason", "source", "assigned_agent_id", "created_at", "updated_at", "version", "write_token" FROM `cases`;--> statement-breakpoint
DROP TABLE `cases`;--> statement-breakpoint
ALTER TABLE `__new_cases` RENAME TO `cases`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE UNIQUE INDEX `cases_case_no_idx` ON `cases` ("case_no" COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `cases_code_idx` ON `cases` ("code" COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `cases_customer_name_idx` ON `cases` ("customer_name" COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `cases_updated_idx` ON `cases` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `cases_agent_updated_idx` ON `cases` (`assigned_agent_id`,`updated_at`,`id`);