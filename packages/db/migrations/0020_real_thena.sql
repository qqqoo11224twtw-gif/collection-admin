CREATE TABLE `telegram_bots` (
	`id` text PRIMARY KEY NOT NULL,
	`telegram_bot_id` text NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`internal_name` text DEFAULT '' NOT NULL,
	`ciphertext` text NOT NULL,
	`nonce` text NOT NULL,
	`encryption_version` integer DEFAULT 1 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`verified_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_bots_telegram_bot_id_unique` ON `telegram_bots` (`telegram_bot_id`);