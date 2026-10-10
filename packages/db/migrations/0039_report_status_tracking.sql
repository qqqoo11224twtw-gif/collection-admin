ALTER TABLE `cases` ADD `current_status` text;
--> statement-breakpoint
CREATE INDEX cases_tracking_status ON cases(status,voided_at);
