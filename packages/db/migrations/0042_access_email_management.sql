CREATE TABLE access_emails (
 id text PRIMARY KEY NOT NULL,
 group_id text NOT NULL,
 email text NOT NULL,
 active integer NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
 sync_status text NOT NULL DEFAULT 'synced' CHECK(sync_status IN ('synced','revoke_failed','revoke_pending','drift')),
 deleted_at integer,
 created_at integer NOT NULL,
 updated_at integer NOT NULL,
 updated_by text REFERENCES user(id),
 UNIQUE(group_id,email)
);
--> statement-breakpoint
CREATE TABLE access_operations (
 id text PRIMARY KEY NOT NULL,
 group_id text NOT NULL,
 email text NOT NULL,
 action text NOT NULL CHECK(action IN ('add','enable','disable','remove','sync')),
 status text NOT NULL CHECK(status IN ('pending','success','partial','failed','reconciled')),
 expected_revision text NOT NULL,
 error_code text,
 user_id text NOT NULL REFERENCES user(id),
 created_at integer NOT NULL,
 finished_at integer
);
--> statement-breakpoint
CREATE TABLE access_group_locks (
 group_id text PRIMARY KEY NOT NULL,
 operation_id text NOT NULL REFERENCES access_operations(id),
 created_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX access_operations_group_created ON access_operations(group_id,created_at);
