# Bulk regional assignment

Added on top of `ea6fbc5`. Existing individual assignment, report, image extraction, installment, and finance behavior is preserved. Development and tests use fictional data and FakeTelegramClient; no live bot credentials or deployment are introduced.

## UI

The case list supports individual checkboxes, current-page selection, a selected count, and the existing region / collector / assignment / case status / search filters. Assigned rows cannot be newly selected. Selection is scoped to the displayed page and filters; it is never an implicit “select every matching case” operation. The normal page size remains ten.

Open **Bulk assign**, choose an active collector, review the count and collector, then confirm. The backend selects the collector's single active `collector` route, chat and topic. Missing or multiple active routes are rejected instead of guessing a destination. A collector without a usable route is disabled in the dialog.

The result dialog lists every requested case, assignment outcome and delivery status, plus assigned / skipped / save-failed counts and separate Telegram queued / retrying / failed / sent counts. Assignment success includes queued or retrying notifications; sending is asynchronous. Delivery states refresh while the dialog is open. The batch ID can be used to retrieve the durable result after closing.

## APIs

- `cases.bulkAssign`: protected oRPC procedure. Strict input `{ batchId: UUID, collectorId, caseIds }`, one to fifty distinct case IDs. No client-provided route, chat, topic, assignment ID or payload is accepted.
- `cases.bulkAssignmentResult`: protected `{ batchId }`, visible only to its creator with current `assignment.create` permission. Names and case numbers additionally require current case access.
- `cases.bulkAssignmentCollectors`: protected active collector choices with active collector-route counts.

All operations use the existing permission abstraction. Each case rechecks `assignment.create`, `case.view` and case scope. Its transaction repeats case version, absence of an active assignment, collector activity, unique active collector route and exact destination checks. The actor's role and ban state are also checked at write time.

## Persistence, transactions and concurrency

Migration `0014_aromatic_pixie.sql` is Drizzle-generated and additive:

- `bulk_assignments`: batch ID, creator, collector, route, canonical request and creation time.
- `bulk_assignment_items`: requested case ID, pending / assigned / skipped / failed outcome, fixed reason code, assignment ID, outbound job ID and update time. Requested IDs are retained even when nonexistent, so they are not misleading foreign keys. Successful assignment/job references are real foreign keys and unique.
- `telegram_outbound_jobs.assignment_id`: nullable foreign key with a unique index. New dispatch jobs use `message_type=assignment_dispatch`.

The client retains the batch ID when retrying a failed request. The server canonicalizes case order; reusing a batch with another actor, collector or case set is rejected. Interrupted pending items may be resumed with the same request. Completed items never run again, including skipped and failed outcomes.

Each case uses its own D1 batch transaction: conditionally update the case version/cache, insert one assignment, insert one outbound job, finish the item and write audit. The existing partial unique index permits only one current assignment per case. Atomic guards protect both overlapping batches and normal individual assignment races. A case already assigned is skipped without closing or replacing its assignment. A transaction failure rolls back that case only and records a fixed `SAVE_FAILED` outcome; other items continue. A new deliberate operation can retry a failed case with a new batch ID, still subject to the unassigned guard.

## Telegram delivery

Each successful assignment has one job with unique `assignment:{assignment_id}` dedupe key. The message contains only that case's number, code, customer name, address and amount, rendered as plain text. The baseline had no assignment-send renderer; this feature adds a dispatch renderer while reusing the existing collector routes, Telegram client and outbound worker. No public image URL is produced.

The existing scheduled worker sends one message per job to its stored chat/topic. Before sending it validates that the route remains active and unchanged, the collector is active, and this assignment remains current. Invalid routing/assignment changes fail safely without undoing the assignment.

Explicit retryable failures use existing backoff, retry-after and five-attempt limits. No new assignment is created on delivery retry. A timeout, uncertain delivery response or expired sending lease remains `DELIVERY_UNKNOWN` and is not blindly resent: Telegram sendMessage has no idempotency key. Assignment and other cases remain committed; uncertain delivery needs reconciliation before a future manual resend.

## Audit

Exactly one `bulk_assignment_created` event is recorded per batch. Each successful case retains `assignment.created`, including its batch and assignment IDs. Jobs record `assignment.outbound_queued`, `assignment.outbound_sent`, `assignment.outbound_retry` and `assignment.outbound_failed`. Metadata contains IDs, counts, versions and fixed error codes; no credentials, OTPs, image bytes, names or addresses.

## Verification coverage

Backend integration tests use real Miniflare D1 transactions and cover region + unassigned composition, individual assignments/jobs, overlapping batches, same-batch reordered retries, already-assigned and unknown cases, missing/inactive/ambiguous routes, inactive collectors, permission denial, batch ownership, strict input, failure isolation/rollback, audit, collector deactivation before resume, retryable Telegram failure and uncertain delivery.

Browser tests exercise twelve filtered cases with current-page selection of ten, multi-select, pagination, a competing assignment before confirmation, nine independent outbound jobs, automatic status refresh, cancel without writes, ordinary-user denial, and a 390px mobile dialog/result layout.

Final local verification on 2026-10-08:

- Backend: 192 tests across 15 files passed, including 11 new bulk-assignment tests.
- Browser: all 35 tests ultimately passed. The three new bulk tests passed on their first attempt. One existing Telegram permission test timed out at the login gate on its initial run, passed its configured retry, and passed an additional isolated run with retries disabled.
- Mobile: new 390px bulk selection, confirmation and results passed; screenshots visually inspected, with no horizontal document overflow.
- TypeScript, lint, Biome CI, frontend client/SSR build, and Worker packaging dry-run passed.
- Additive migration applied locally; D1 foreign-key check returned zero violations.
- No shared UI package or dependency changes. HEAD remains `ea6fbc5`; these changes have not been committed or pushed.
