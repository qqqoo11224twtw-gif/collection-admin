CREATE TABLE `case_media` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`original_filename` text NOT NULL,
	`media_type` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "case_media_sort_check" CHECK("case_media"."sort_order" >= 0),
	CONSTRAINT "case_media_type_check" CHECK("case_media"."media_type" IN ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "case_media_sha_check" CHECK(length("case_media"."sha256") = 64 AND "case_media"."sha256" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `case_media_storage_idx` ON `case_media` (`storage_key`);--> statement-breakpoint
CREATE INDEX `case_media_case_sort_idx` ON `case_media` (`case_id`,`sort_order`,`id`);--> statement-breakpoint
CREATE INDEX `case_media_sha256_idx` ON `case_media` (`sha256`);--> statement-breakpoint
CREATE TABLE `cases` (
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
	FOREIGN KEY (`assigned_agent_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "cases_amount_check" CHECK("cases"."amount_due" >= 0 AND "cases"."amount_due" <= 1000000000000),
	CONSTRAINT "cases_status_check" CHECK("cases"."status" IN ('pending', 'assigned', 'follow_up', 'installment', 'settled', 'unresolved')),
	CONSTRAINT "cases_source_check" CHECK("cases"."source" IN ('manual', 'poster_builder', 'telegram_ai', 'historical_import')),
	CONSTRAINT "cases_revisit_check" CHECK("cases"."revisit_status" IN ('pending', 'recommended', 'not_required')),
	CONSTRAINT "cases_required_check" CHECK(length(trim("cases"."case_no")) > 0 AND length(trim("cases"."code")) > 0 AND length(trim("cases"."customer_name")) > 0 AND length(trim("cases"."address")) > 0),
	CONSTRAINT "cases_dates_check" CHECK("cases"."updated_at" >= "cases"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cases_case_no_idx` ON `cases` ("case_no" COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `cases_code_idx` ON `cases` ("code" COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `cases_customer_name_idx` ON `cases` ("customer_name" COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `cases_updated_idx` ON `cases` (`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `cases_agent_updated_idx` ON `cases` (`assigned_agent_id`,`updated_at`,`id`);