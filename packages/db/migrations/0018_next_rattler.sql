ALTER TABLE `cases` ADD `voided_at` integer;--> statement-breakpoint
ALTER TABLE `cases` ADD `voided_by` text REFERENCES user(id);--> statement-breakpoint
ALTER TABLE `cases` ADD `void_note` text;--> statement-breakpoint
ALTER TABLE `telegram_outbound_jobs` ADD `dispatch_state` text;