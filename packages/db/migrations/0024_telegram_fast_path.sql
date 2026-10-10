ALTER TABLE `cases` ADD `report_name` text;--> statement-breakpoint
CREATE INDEX `cases_report_name_active_idx` ON `cases` (`report_name`,`voided_at`,`id`);--> statement-breakpoint
CREATE INDEX `telegram_routes_fast_lookup_idx` ON `telegram_routes` (`chat_id`,coalesce("topic_id",0),`is_active`,`route_type`);
