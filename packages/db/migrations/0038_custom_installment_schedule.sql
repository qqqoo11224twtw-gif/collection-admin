PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_installment_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`report_id` text,
	`collector_id` text,
	`plan_type` text NOT NULL,
	`total_amount` integer NOT NULL,
	`per_payment_amount` integer,
	`weekday` integer,
	`day_of_month` integer,
	`deadline_date` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`write_token` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "installment_amount_check" CHECK("__new_installment_plans"."total_amount">0 AND "__new_installment_plans"."total_amount"<=1000000000000 AND ("__new_installment_plans"."per_payment_amount" IS NULL OR ("__new_installment_plans"."per_payment_amount">0 AND "__new_installment_plans"."per_payment_amount"<="__new_installment_plans"."total_amount"))),
	CONSTRAINT "installment_type_check" CHECK(("__new_installment_plans"."plan_type"='custom' AND "__new_installment_plans"."deadline_date" IS NULL AND "__new_installment_plans"."per_payment_amount" IS NULL AND "__new_installment_plans"."weekday" IS NULL AND "__new_installment_plans"."day_of_month" IS NULL) OR ("__new_installment_plans"."plan_type"='deadline' AND "__new_installment_plans"."deadline_date" IS NOT NULL AND "__new_installment_plans"."per_payment_amount" IS NULL AND "__new_installment_plans"."weekday" IS NULL AND "__new_installment_plans"."day_of_month" IS NULL) OR ("__new_installment_plans"."plan_type"='weekly' AND "__new_installment_plans"."weekday" BETWEEN 1 AND 7 AND "__new_installment_plans"."per_payment_amount" IS NOT NULL AND "__new_installment_plans"."day_of_month" IS NULL AND "__new_installment_plans"."deadline_date" IS NULL) OR ("__new_installment_plans"."plan_type"='monthly' AND "__new_installment_plans"."day_of_month" BETWEEN 1 AND 31 AND "__new_installment_plans"."per_payment_amount" IS NOT NULL AND "__new_installment_plans"."weekday" IS NULL AND "__new_installment_plans"."deadline_date" IS NULL)),
	CONSTRAINT "installment_status_check" CHECK("__new_installment_plans"."status" IN ('active','completed','cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_installment_plans`("id", "case_id", "report_id", "collector_id", "plan_type", "total_amount", "per_payment_amount", "weekday", "day_of_month", "deadline_date", "status", "created_by_user_id", "created_at", "updated_at", "version", "write_token") SELECT "id", "case_id", "report_id", "collector_id", "plan_type", "total_amount", "per_payment_amount", "weekday", "day_of_month", "deadline_date", "status", "created_by_user_id", "created_at", "updated_at", "version", "write_token" FROM `installment_plans`;--> statement-breakpoint
DROP TABLE `installment_plans`;--> statement-breakpoint
ALTER TABLE `__new_installment_plans` RENAME TO `installment_plans`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE UNIQUE INDEX `installment_report_idx` ON `installment_plans` (`report_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `installment_active_case_idx` ON `installment_plans` (`case_id`) WHERE "installment_plans"."status"='active';--> statement-breakpoint
CREATE INDEX `installment_case_idx` ON `installment_plans` (`case_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER installment_plans_void_case_guard BEFORE INSERT ON installment_plans WHEN EXISTS(SELECT 1 FROM cases WHERE id=NEW.case_id AND voided_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'CASE_VOIDED'); END;
--> statement-breakpoint
CREATE TRIGGER bulk_new_assignment_media_guard BEFORE INSERT ON assignments WHEN NEW.record_type='assignment' AND EXISTS(SELECT 1 FROM audit_logs a WHERE a.entity_id=NEW.case_id AND a.action='case.created' AND json_extract(a.metadata,'$.bulkMode')='new' AND (SELECT count(*) FROM case_media WHERE case_id=NEW.case_id)<max(1,coalesce(json_extract(a.metadata,'$.bulkImageCount'),0))) BEGIN SELECT RAISE(ABORT,'BULK_MEDIA_NOT_READY'); END;
