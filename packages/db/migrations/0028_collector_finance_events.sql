CREATE TABLE `collector_offsets` (
	`id` text PRIMARY KEY NOT NULL,
	`source_payment_id` text NOT NULL,
	`collector_id` text NOT NULL,
	`amount` integer NOT NULL,
	`admin_commission_rate` real NOT NULL,
	`admin_commission_amount` integer NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "collector_offset_positive" CHECK("collector_offsets"."amount">0 AND "collector_offsets"."admin_commission_rate" BETWEEN 0 AND 1 AND "collector_offsets"."admin_commission_amount">=0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collector_offsets_source_payment_id_unique` ON `collector_offsets` (`source_payment_id`);--> statement-breakpoint
CREATE INDEX `collector_offset_collector` ON `collector_offsets` (`collector_id`);--> statement-breakpoint
CREATE TABLE `finance_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_commission_rate` real DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`write_token` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "finance_rate_check" CHECK("finance_settings"."admin_commission_rate" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE `payment_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`schedule_id` text NOT NULL,
	`amount` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`schedule_id`) REFERENCES `installment_schedules`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payment_allocation_positive" CHECK("payment_allocations"."amount">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_allocation_unique` ON `payment_allocations` (`payment_id`,`schedule_id`);--> statement-breakpoint
CREATE INDEX `allocation_schedule` ON `payment_allocations` (`schedule_id`);--> statement-breakpoint
CREATE TABLE `remittance_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`remittance_id` text NOT NULL,
	`settlement_id` text NOT NULL,
	`component` text NOT NULL,
	`amount` integer NOT NULL,
	FOREIGN KEY (`remittance_id`) REFERENCES `remittances`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`settlement_id`) REFERENCES `settlements`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "remittance_allocation_positive" CHECK("remittance_allocations"."amount">0)
);
--> statement-breakpoint
CREATE INDEX `remittance_allocation_settlement` ON `remittance_allocations` (`settlement_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `remittance_allocation_unique` ON `remittance_allocations` (`remittance_id`,`settlement_id`,`component`);--> statement-breakpoint
CREATE TABLE `remittances` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`collector_id` text NOT NULL,
	`amount` integer NOT NULL,
	`received_date` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`voided_at` integer,
	`voided_by_user_id` text,
	`void_reason` text,
	`write_token` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`voided_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "remittance_amount_positive" CHECK("remittances"."amount">0 AND "remittances"."amount"<=1000000000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remittances_idempotency_key_unique` ON `remittances` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `remittance_collector_date` ON `remittances` (`collector_id`,`received_date`);--> statement-breakpoint
ALTER TABLE `payments` ADD `channel` text DEFAULT 'collector_received' NOT NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD `finance_event` text;--> statement-breakpoint
ALTER TABLE `settlements` ADD `admin_commission_rate` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `settlements` ADD `admin_commission_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_report_conversations` ADD `kind` text DEFAULT 'report' NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_report_conversations` ADD `collection_amount` integer;