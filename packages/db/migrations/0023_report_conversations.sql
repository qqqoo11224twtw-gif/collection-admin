CREATE TABLE `telegram_report_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`route_id` text NOT NULL,
	`collector_id` text NOT NULL,
	`stage` text NOT NULL,
	`candidates` text NOT NULL,
	`case_id` text,
	`assignment_id` text,
	`report_id` text,
	`origin_update_id` text NOT NULL,
	`content_update_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`route_id`) REFERENCES `telegram_routes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_report_conversations_origin_update_id_unique` ON `telegram_report_conversations` (`origin_update_id`);--> statement-breakpoint
CREATE INDEX `telegram_report_conversation_route` ON `telegram_report_conversations` (`route_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_report_conversation_active` ON `telegram_report_conversations` (`route_id`) WHERE "telegram_report_conversations"."stage" IN ('selecting','content','submitting','status');