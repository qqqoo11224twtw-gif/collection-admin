# Phase seven: image extraction and manual Telegram status

This phase runs with fictional local data, `FakeImageExtractionProvider` and
`FakeTelegramClient`. No real API credentials, webhook registration or deployment
are needed for the baseline. The live OpenAI transport is implemented but has not
been exercised against a real account.

## Image extraction

- Provider: `packages/api/src/openai-image-extraction.ts`; service:
  `packages/api/src/image-extraction-service.ts`.
- Server-only settings are documented in `apps/server/.local.env.example`.
  `IMAGE_EXTRACTION_MODE` defaults to disabled outside the isolated local config;
  live mode requires a key and an explicit model. Never expose the key to web code.
- The Responses API receives private image bytes, a restricted extraction prompt
  and a strict JSON schema. Only code, customer name, address, integer amount and
  confidence survive validation. Missing fields remain null; unknown keys fail.
- Telegram image collection finishes before jobs are queued. Manual uploads can
  use the intake detail extraction action. Private storage reads verify SHA256.
- `ai_image_jobs` has a unique intake/SHA/provider/model/version key, durable leases,
  bounded attempts and backoff. Known successful validated results are cached in
  KV before D1 application, allowing database retries without repeating API calls.
  Duplicate source attachment records are retained. This is not a guarantee of
  exactly-once billing if a process dies after the remote response and before KV
  persistence; failures before a known successful result can require another call.
- High confidence (at least 0.8) and a unique match use the existing intake resolver
  and private media promotion. No match leaves a draft for explicit creation;
  ambiguity creates case-match review. Low confidence, conflicting/missing fields,
  invalid output and exhausted retries create image-extraction review.
- `received_data` retains original intake input. Validated extraction proposals,
  confirmed data, job results and review corrections remain separate.
- `ai_usage_logs` records image extraction provider/model, tokens when supplied,
  duration, success and a fixed error code. It does not contain image bytes,
  secrets, raw responses or prompts. Cached database retries do not add billable
  invocation records. Report text never reaches this provider.

## Telegram reports

- `/回報` uses the existing scoped case matcher and reports table. A resolved
  assigned case creates `workflow_status=awaiting_status`, with a random callback
  token. It does not change the case status, create classification review or queue
  a business destination message.
- The prompt contains four buttons: settled, installment, unresolved, follow_up.
  Callback data contains only an opaque token and the selected status.
- `telegram-report-status.ts` checks original sender, active identity and collector,
  linked user, source route/chat/topic, case permissions and the original active
  assignment. The transaction repeats mutable scope checks and uses version guards.
- One D1 batch completes the report, stores the original selected status, completer
  and time, updates the case and writes audits. Duplicate callbacks are safe no-ops.
  Pending reports cannot be edited or resolved via the generic review API.
- Only after commit does the durable business outbound job get created, with the
  existing unique report/destination dedupe key. Inbox retries and the recovery
  pass repair missing postcommit jobs. Delivery retries never repeat domain updates.
  Payload remains only code/name/content/business-timezone date. Telegram delivery
  itself retains the phase-six at-least-once limitation after ambiguous network
  acknowledgements; Telegram sendMessage offers no application idempotency key.
- Case detail shows pending selection or completed selection, completer and time.
  Intake detail shows confidence, extraction job status and proposed/confirmed data.

## Database migration

Migration 0011 was generated with Drizzle. Its generated reports rebuild was
corrected to additive ALTERs because the generated INSERT referenced new columns
in the old table and rebuilding the referenced reports parent risks existing
foreign keys. The additive migration preserves prior reports, assignment history,
reviews and outbound references; prior reports default to completed.

## Verification

Run `pnpm typecheck`, `pnpm lint`, `pnpm run ci`, `pnpm test`, `pnpm test:e2e`,
`pnpm build:local`, a local Worker dry-run and `PRAGMA foreign_key_check`.
Backend tests use Miniflare D1/KV/private storage and fake external providers.
Provider request-shape tests inject synthetic HTTP responses rather than network.
Local browser coverage includes private blob thumbnails, low-confidence review,
original input preservation and a 390px mobile viewport.

Verified locally on 2026-10-08: 167 backend tests across 13 files passed;
TypeScript, lint, Biome CI, frontend build and Worker dry-run passed.
The migrated local D1 returned zero foreign-key violations. Both local servers
responded successfully (web HTTP 200 and backend health status ok).
The final Chromium suite ran all 30 tests: 29 passed directly and one existing
auth/Todo test passed on retry (reported flaky). Both new extraction and pending
report mobile tests passed directly. An earlier run also had an existing image
deletion wait flake; that test passed directly in the final run. The pending report
browser fixture was made repeatable by reusing its user's existing collector.

Next: review this local baseline, then separately authorize an isolated live
integration smoke test with a server secret and dedicated test bot/group. Do not
enable production routes or automatic case creation as part of that verification.
