-- Additive only; existing cases, reports, Telegram updates and routes are untouched.
CREATE TABLE IF NOT EXISTS telegram_ocr_jobs (
 id TEXT PRIMARY KEY, update_key TEXT NOT NULL UNIQUE,
 route_id TEXT NOT NULL REFERENCES telegram_routes(id),
 actor_user_id TEXT NOT NULL REFERENCES user(id), sender_id TEXT NOT NULL,
 message_id INTEGER NOT NULL, file_id TEXT, image_hash TEXT,
 batch_id TEXT NOT NULL UNIQUE, fields_json TEXT, evidence_json TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','recognizing','ready','creating','created','failed','cancelled')),
 version INTEGER NOT NULL DEFAULT 0, notified_version INTEGER NOT NULL DEFAULT -1,
 attempts INTEGER NOT NULL DEFAULT 0, case_id TEXT REFERENCES cases(id),
 lease_token TEXT, lease_until INTEGER, created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS telegram_ocr_jobs_pending ON telegram_ocr_jobs(status,created_at);
CREATE INDEX IF NOT EXISTS telegram_ocr_jobs_expiry ON telegram_ocr_jobs(expires_at);
CREATE TABLE IF NOT EXISTS telegram_ocr_report_batches (
 id TEXT PRIMARY KEY, route_id TEXT NOT NULL REFERENCES telegram_routes(id),
 actor_user_id TEXT NOT NULL, sender_id TEXT NOT NULL, group_key TEXT NOT NULL,
 received_at INTEGER NOT NULL, ack_state TEXT NOT NULL DEFAULT 'pending',
 summary_state TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS telegram_ocr_report_open ON telegram_ocr_report_batches(route_id,sender_id,group_key,summary_state,received_at);
CREATE TABLE IF NOT EXISTS telegram_ocr_report_items (
 job_id TEXT PRIMARY KEY REFERENCES telegram_ocr_jobs(id) ON DELETE CASCADE,
 report_id TEXT NOT NULL REFERENCES telegram_ocr_report_batches(id) ON DELETE CASCADE
);
