UPDATE user SET email=lower(trim(email));
--> statement-breakpoint
CREATE UNIQUE INDEX user_email_normalized_idx ON user(lower(trim(email)));
