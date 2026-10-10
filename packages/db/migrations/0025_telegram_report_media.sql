CREATE TABLE `telegram_report_media` (
	`id` text PRIMARY KEY NOT NULL,
	`route_id` text NOT NULL,
	`conversation_id` text,
	`chat_id` text NOT NULL,
	`message_id` integer NOT NULL,
	`media_group_id` text,
	`received_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`route_id`) REFERENCES `telegram_routes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `telegram_report_conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_media_source` ON `telegram_report_media` (`chat_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `report_media_conversation` ON `telegram_report_media` (`conversation_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `report_media_group` ON `telegram_report_media` (`route_id`,`media_group_id`);--> statement-breakpoint
ALTER TABLE `telegram_report_conversations` ADD `draft_content` text;