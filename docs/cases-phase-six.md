# Phase six: Telegram reception and reporting

All verification uses fictional data, local D1/private storage, and FakeTelegramClient. No real bot, webhook registration, AI, OCR, or production deployment is performed.

## Durable reception

`POST /api/telegram/webhook` verifies `X-Telegram-Bot-Api-Secret-Token`, bounds request size, validates supported update fields, and atomically persists the update and optional album membership. It returns immediately after persistence; it does not download images or modify cases. Unknown source chats/topics are denied by background processing.

`telegram_updates.id` is the update ID. Its primary key handles concurrent deliveries. Receipt retries do not extend album quiet periods. Intake has its separate event dedupe keys; event identity is never interpreted as case identity.

`telegram-processing.ts` claims durable work with conditional updates and expiring leases. Local Wrangler config includes a minute scheduler; administrators can also process local jobs from settings. No blocking wait is used in the webhook. Processing is bounded to 20 updates and 20 delivery jobs per pass. Future deployment must explicitly configure the scheduler and server secrets; this phase does not deploy it.

`dev:local` enables Wrangler's local scheduled-event emulator and ticks it every five seconds, with one emulator request in flight at a time. This drains persisted updates and finalizes quiet albums without a manual click. The launcher strips inherited Telegram environment variables and uses the fake configuration. Stopping the launcher clears its timer.

## Case matching

`case-matching.ts` treats exact case number as authoritative. Otherwise, known differing codes exclude a case even when names and addresses agree. Same code plus compatible name/address is a strong candidate. Missing code, conflicting name/address, or multiple candidates requires review. Address normalization never overrides code. Candidate results are capped; truncation blocks automatic resolution.

A single uncertain candidate is now supported by the case-match review schema. The resolver still validates stored candidates, current matches, and visibility before resolving. Intake does not overwrite existing case fields.

## Photos and albums

`TelegramIntakeAdapter` creates a strictly validated, nullable draft proposal. Captions remain in the normalized update record; no OCR or keyword extraction is attempted. The adapter receives only the intake receiver capability.

Photos select the largest available size; PNG/JPEG/WebP image documents are supported. Downloads have time/size limits, redirect protection, file-signature validation, SHA-256, and private storage. A deterministic update-based media ID prevents duplicate metadata. Staged private objects are reused after database failure, avoiding another completed download. Source records are retained and SHA duplicates are flagged.

`telegram_albums` groups chat + topic + media-group ID. New distinct updates reset a three-second quiet period; duplicate updates do not. Finalization checks that every member completed, then uses a version guard. Images sort by source message ID, including out-of-order arrival. Resolution is blocked while attachments are collecting. Very late media for an already resolved intake fails safely instead of being silently attached to another case.

## Identity and report commands

`telegram_identities` maps numeric Telegram user ID to collector/login. Display name grants no authority. The bound collector and login must agree and be active; banned accounts, anonymous sender chats, and bot senders are denied.

Collector routes bind an exact source chat/topic and collector. The report principal always uses collector assignment scope, even if its linked account has an administrative role. `/回報 identifier content` resolves case number, code, then name within current active assignments. Two same-name assigned cases return limited candidates (name/code/case number), without address or amount. No match or unbound identity receives a safe reply.

`ReportCommandService` uses the existing `createReport` service and ManualClassifier. Reports are `needs_review`, with no automatic classification, payment, or settled-state inference. Report content is limited to 3500 characters so the complete business message fits Telegram's text limit.

Reports have a unique server-only `origin_key`. Creation also records the report pointer on the durable update in the same transaction. If outbound enqueue fails after commit, retry repairs missing jobs without another report, even after assignment changes. Frontend report APIs cannot provide an origin key.

## Routes, outbound delivery, and retries

`telegram_routes` stores chat/topic, purpose, optional collector, active flag, and managing user. Routes and identities are managed at `/cases/telegram` under `telegram_route.manage`. Ordinary users see no management link, and backend APIs deny access.

`telegram_outbound_jobs` stores the safe rendered message, route, report, unique dedupe key, status, attempts, next attempt, lease, Telegram message ID, timestamps, and safe error code. Business jobs are queued only after the report transaction commits. Their key is `report-destination:{report_id}:{route_id}`. There is no rollback of a committed report when delivery fails.

Business text has exactly four fields: code, customer name, report content, and business date. Dates use `BUSINESS_TIMEZONE` (default Asia/Taipei). No case ID/number, collector ID, Telegram identity, address, amount, status, classification, or audit fields are appended. User-provided text is plain text and not interpreted as HTML/Markdown.

A destination with no collector receives all authorized collector reports. A collector-specific destination receives only that collector's reports. Delivery validates the stored target against the current active route and fails safely if the route changed.

Explicit retryable failures use exponential backoff (one second initially, capped at five minutes), respect Telegram retry-after, and stop after five attempts. Sent jobs never re-enter sending. Concurrent senders claim once.

Telegram sendMessage has no client idempotency key. A timeout, uncertain server response, or expired sending lease cannot prove non-delivery. Such jobs become `failed / DELIVERY_UNKNOWN` and are not automatically resent. Operators must reconcile actual delivery before any future manual resend workflow; that workflow is outside this phase. This prevents blind retries from producing duplicate messages, rather than claiming distributed exactly-once delivery.

## Client and secrets

`telegram-client.ts` centralizes Bot API calls behind TelegramClient. FakeTelegramClient performs no external requests and supports download/send failure fixtures. Live client exists behind explicit `TELEGRAM_MODE=live` and server-only token configuration; default examples disable it, while dev:local uses fake mode. No setWebhook call is included.

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `BUSINESS_TIMEZONE` are documented in `apps/server/.local.env.example`. Secrets never enter frontend bundles, audit metadata, or error responses. Errors are fixed codes rather than raw network exceptions or token-bearing URLs.

## Local simulator and tests

Configure fictional intake/collector routes first. `node scripts/telegram-simulator.ts photo|document|album|delayed-album|retry|report [identifier]` sends only to localhost. Optional simulator environment variables select synthetic chat/user/topic and the local webhook secret. Use the admin local-processing button to drain work. The FakeTelegramClient fixtures in integration tests cover download failure, outbound failure/retry, and uncertain delivery without a bot token.

Migration `0010_powerful_abomination.sql` is Drizzle-generated. Its nullable-topic expression index was corrected after Drizzle incorrectly split/quoted the coalesce expression; the index still matches the schema and prevents duplicate routes with null topics.

Audit covers update receipt/replay, intake/media, album finalization, reports, ambiguity/identity denial, outbound queue/send/retry/failure, processing failure, and management changes. Metadata is restricted to identifiers, counts, and fixed error codes.

Verification on 2026-10-08: TypeScript, lint, Biome CI, client/SSR build, Worker dry-run packaging, 153 backend tests (24 Telegram tests), 28 browser tests (two Telegram administration tests), and local foreign-key check all passed. The Telegram browser tests also passed after enabling the local scheduler and explicitly verified automatic inbox processing. Foreign-key violations: zero. Local web and health endpoints return HTTP 200.
