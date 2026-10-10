CREATE TABLE `collector_payouts` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`collector_id` text NOT NULL,
	`amount` integer NOT NULL,
	`principal_amount` integer NOT NULL,
	`commission_amount` integer NOT NULL,
	`received_date` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`voided_at` integer,
	`voided_by_user_id` text,
	`void_reason` text,
	`write_token` text NOT NULL,
	FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`voided_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payout_amount_check" CHECK("collector_payouts"."amount">0 AND "collector_payouts"."amount"<=1000000000000 AND "collector_payouts"."principal_amount">=0 AND "collector_payouts"."commission_amount">=0 AND "collector_payouts"."principal_amount"+"collector_payouts"."commission_amount"="collector_payouts"."amount")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collector_payouts_idempotency_key_unique` ON `collector_payouts` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `payout_collector_date` ON `collector_payouts` (`collector_id`,`received_date`);--> statement-breakpoint
CREATE TABLE `managed_auth_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`stage` text NOT NULL,
	`auth_version` integer NOT NULL,
	`secret_encrypted` text,
	`key_version` text,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`write_token` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managed_auth_challenges_token_hash_unique` ON `managed_auth_challenges` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_challenge_user_expiry` ON `managed_auth_challenges` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `managed_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`auth_version` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managed_sessions_token_hash_unique` ON `managed_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `managed_session_user` ON `managed_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`used_at` integer,
	`used_token` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_recovery_codes_code_hash_unique` ON `auth_recovery_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `recovery_user` ON `auth_recovery_codes` (`user_id`);--> statement-breakpoint
ALTER TABLE `remittances` ADD `principal_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `remittances` ADD `commission_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `username` text;--> statement-breakpoint
ALTER TABLE `user` ADD `password_hash` text;--> statement-breakpoint
ALTER TABLE `user` ADD `must_change_password` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `totp_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `totp_encrypted` text;--> statement-breakpoint
ALTER TABLE `user` ADD `totp_key_version` text;--> statement-breakpoint
ALTER TABLE `user` ADD `last_totp_counter` integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `auth_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `deleted_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);