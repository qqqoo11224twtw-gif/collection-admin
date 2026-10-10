-- Custom SQL migration file, put your code below! --
UPDATE remittances SET commission_amount=coalesce((SELECT sum(a.amount) FROM remittance_allocations a WHERE a.remittance_id=remittances.id AND a.component='commission'),0);
--> statement-breakpoint
UPDATE remittances SET principal_amount=amount-commission_amount;
--> statement-breakpoint
CREATE UNIQUE INDEX user_username_normalized_unique ON user(lower(trim(username))) WHERE username IS NOT NULL;
