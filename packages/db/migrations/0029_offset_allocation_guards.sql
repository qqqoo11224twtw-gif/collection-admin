CREATE TABLE `offset_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`offset_id` text NOT NULL,
	`settlement_id` text NOT NULL,
	`component` text NOT NULL,
	`amount` integer NOT NULL,
	FOREIGN KEY (`offset_id`) REFERENCES `collector_offsets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`settlement_id`) REFERENCES `settlements`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "offset_allocation_positive" CHECK("offset_allocations"."amount">0)
);
--> statement-breakpoint
CREATE INDEX `offset_allocation_settlement` ON `offset_allocations` (`settlement_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `offset_allocation_unique` ON `offset_allocations` (`offset_id`,`settlement_id`,`component`);--> statement-breakpoint
ALTER TABLE `collector_offsets` ADD `voided_at` integer;--> statement-breakpoint
ALTER TABLE `collector_offsets` ADD `voided_by_user_id` text REFERENCES user(id);--> statement-breakpoint
ALTER TABLE `collector_offsets` ADD `void_reason` text;