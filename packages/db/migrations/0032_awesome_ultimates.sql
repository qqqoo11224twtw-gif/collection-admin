CREATE TABLE `collector_finance_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`collector_id` text NOT NULL,
	`kind` text NOT NULL,
	`rate` real NOT NULL,
	`active` integer NOT NULL,
	`effective_from` integer NOT NULL,
	`effective_to` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "collector_finance_rate_check" CHECK("collector_finance_settings"."rate" BETWEEN 0 AND 1 AND "collector_finance_settings"."kind" IN ('return','commission') AND (("collector_finance_settings"."active"=1 AND "collector_finance_settings"."effective_to" IS NULL) OR ("collector_finance_settings"."active"=0 AND "collector_finance_settings"."effective_to" IS NOT NULL)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collector_finance_active_unique` ON `collector_finance_settings` (`collector_id`,`kind`) WHERE "collector_finance_settings"."active"=1;--> statement-breakpoint
ALTER TABLE `settlements` ADD `collector_return_rate_snapshot` real;--> statement-breakpoint
ALTER TABLE `settlements` ADD `admin_commission_rate_snapshot` real;