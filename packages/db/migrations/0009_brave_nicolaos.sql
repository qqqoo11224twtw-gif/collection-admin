CREATE TABLE `intake_items` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text,
	`dedupe_key` text,
	`status` text DEFAULT 'received' NOT NULL,
	`proposed_data` text NOT NULL,
	`confirmed_data` text,
	`matched_case_id` text,
	`review_item_id` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`processed_at` integer,
	`version` integer DEFAULT 0 NOT NULL,
	`write_token` text DEFAULT '' NOT NULL,
	`case_no_hint` text,
	`confidence` real,
	FOREIGN KEY (`matched_case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`review_item_id`) REFERENCES `review_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "intake_source_check" CHECK("intake_items"."source" IN ('manual','telegram','line','poster_builder','historical_import','api')),
	CONSTRAINT "intake_status_check" CHECK("intake_items"."status" IN ('received','processing','needs_review','matched','created','rejected','failed')),
	CONSTRAINT "intake_json_check" CHECK(json_valid("intake_items"."proposed_data") AND ("intake_items"."confirmed_data" IS NULL OR json_valid("intake_items"."confirmed_data"))),
	CONSTRAINT "intake_confidence_check" CHECK("intake_items"."confidence" IS NULL OR "intake_items"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "intake_terminal_check" CHECK("intake_items"."status" NOT IN ('matched','created') OR ("intake_items"."matched_case_id" IS NOT NULL AND "intake_items"."confirmed_data" IS NOT NULL AND "intake_items"."processed_at" IS NOT NULL)),
	CONSTRAINT "intake_dates_check" CHECK("intake_items"."updated_at" >= "intake_items"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intake_source_external_idx` ON `intake_items` (`source`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `intake_source_dedupe_idx` ON `intake_items` (`source`,`dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `intake_review_idx` ON `intake_items` (`review_item_id`);--> statement-breakpoint
CREATE INDEX `intake_status_source_time_idx` ON `intake_items` (`status`,`source`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `intake_creator_idx` ON `intake_items` (`created_by_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `intake_media` (
	`id` text PRIMARY KEY NOT NULL,
	`intake_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`original_filename` text NOT NULL,
	`media_type` text NOT NULL,
	`sha256` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`is_duplicate` integer DEFAULT false NOT NULL,
	`promoted_case_media_id` text,
	`promoted_at` integer,
	FOREIGN KEY (`intake_id`) REFERENCES `intake_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`promoted_case_media_id`) REFERENCES `case_media`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "intake_media_sha_check" CHECK(length("intake_media"."sha256")=64 AND "intake_media"."sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "intake_media_sort_check" CHECK("intake_media"."sort_order" >= 0),
	CONSTRAINT "intake_media_type_check" CHECK("intake_media"."media_type" IN ('image/png','image/jpeg','image/webp'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intake_media_storage_idx` ON `intake_media` (`storage_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `intake_media_promotion_idx` ON `intake_media` (`promoted_case_media_id`);--> statement-breakpoint
CREATE INDEX `intake_media_sort_idx` ON `intake_media` (`intake_id`,`sort_order`,`id`);--> statement-breakpoint
CREATE INDEX `intake_media_sha_idx` ON `intake_media` (`sha256`);