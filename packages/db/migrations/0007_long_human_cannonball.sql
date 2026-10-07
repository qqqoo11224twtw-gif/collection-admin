CREATE TABLE `review_items` (
	`id` text PRIMARY KEY NOT NULL,
	`review_type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`case_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`source` text NOT NULL,
	`proposed_data` text NOT NULL,
	`confirmed_data` text,
	`reason` text NOT NULL,
	`confidence` real,
	`created_by_user_id` text,
	`resolved_by_user_id` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`dedupe_key` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`write_token` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "review_items_type_check" CHECK("review_items"."review_type" IN ('report_classification','case_match','image_extraction','payment_detection')),
	CONSTRAINT "review_items_entity_check" CHECK("review_items"."entity_type" IN ('report','case','intake')),
	CONSTRAINT "review_items_status_check" CHECK("review_items"."status" IN ('pending','approved','corrected','rejected')),
	CONSTRAINT "review_items_priority_check" CHECK("review_items"."priority" IN ('low','normal','high')),
	CONSTRAINT "review_items_source_check" CHECK("review_items"."source" IN ('manual','ai','telegram','historical_import')),
	CONSTRAINT "review_items_json_check" CHECK(json_valid("review_items"."proposed_data") AND ("review_items"."confirmed_data" IS NULL OR json_valid("review_items"."confirmed_data"))),
	CONSTRAINT "review_items_confidence_check" CHECK("review_items"."confidence" IS NULL OR "review_items"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "review_items_resolution_check" CHECK(("review_items"."status"='pending' AND "review_items"."resolved_at" IS NULL AND "review_items"."resolved_by_user_id" IS NULL AND "review_items"."confirmed_data" IS NULL) OR ("review_items"."status"<>'pending' AND "review_items"."resolved_at" IS NOT NULL AND "review_items"."resolved_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_items_dedupe_idx` ON `review_items` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `review_items_status_type_time_idx` ON `review_items` (`status`,`review_type`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `review_items_case_time_idx` ON `review_items` (`case_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `review_items_entity_idx` ON `review_items` (`entity_type`,`entity_id`,`status`);