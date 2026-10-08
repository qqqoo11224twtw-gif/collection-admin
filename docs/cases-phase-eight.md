# Phase eight: installments, finance and regional dispatch

All verification uses fictional local records, FakeTelegramClient and the local
private storage adapter. No production Telegram migration, real OpenAI request,
historical image batch import or Cloudflare deployment is part of this phase.

## Tables and history

- `installment_plans`: case/report/collector references, type, total, per-payment
  amount, weekday/month day/deadline, status, creator, timestamps and version.
  One active plan per case and one plan per originating report are enforced.
- `installment_schedules`: immutable expected amount, due date and sequence;
  paid amount is a projection of received (non-voided) payment ledger entries.
  Plan/sequence is unique. Creating a forecast never creates a payment.
- `installment_workflows`: original Telegram sender, route, collector, user and
  assignment; opaque token, strict JSON data, step, status, expiration, last update
  and version. Only one active conversation per sender/route is allowed.
- `payments`: one immutable receipt amount/date per idempotency key, optional
  schedule/plan link, collector, source, status, creator and version. Voiding changes
  status and writes an audit; it never deletes a receipt.
- `settlements`: one row per payment, original case code/customer snapshots,
  received amount, commission-rate snapshot and calculated commission/return
  amounts. Pending/returned changes store actor/time and remain in audit history.
- Cases add a canonical nullable region and unique manual-entry key. Old rows stay
  unrecorded; regions are never guessed from fictional addresses. Assignment
  corrections preserve the old row and original assigned time, and explicitly
  identify the corrected row and reason.

Migration 0012 is additive. Migration 0013 was generated with the Drizzle custom
migration CLI and adds region/correction validation triggers without rebuilding
referenced history tables. Both are local-only for this verification.

## Telegram installment flow

After the authenticated report status callback selects installment, the report
completes through the existing phase-seven transaction and a durable workflow
offers deadline / weekly / monthly choices. Deadline asks for date and total;
weekly asks for weekday, each payment and total; monthly offers common dates or
custom 1–31, then each payment and total. All paths show a summary and require the
confirm button before creating a plan and schedule in one D1 transaction.

Callbacks contain only opaque token/version/action. Sender, active identity,
collector, user, source chat/topic and original current assignment are verified.
Mutable scope and ban checks are repeated in the final transaction. Old buttons,
duplicate updates and completed confirmations cannot create another plan.
State expires after 24 hours; invalid input leaves the current step unchanged.
If the same sender/route already has a setup in progress, it must be completed or
cancelled before another begins. Prompts have durable outbound dedupe keys.

`finance-contract.ts` centrally calculates dates. The first due date is the first
eligible date on or after the confirmation's business date. Weekly increments
seven days. Monthly recalculates the requested day in each actual calendar month;
missing days clamp to that month's last day, then the next month again uses the
original requested day. Final installment is the exact remainder, at most 240
periods. The schedule's expected amounts never get rewritten by receipts.

Collectors create plans only through this confirmed workflow. The administrative
plan-creation API additionally requires `installment.manage`; it cannot be used by
ordinary collectors to bypass confirmation.

## Receipt and return accounting

Case Payment history records an actual receipt through the backend. A schedule is
optional, but when selected it must belong to the case and an active plan; receipts
cannot exceed that schedule's outstanding amount. The receipt, its settlement,
schedule projection, plan completion projection and audit are one transaction.
Same-key retries return the existing receipt; conflicting payloads are rejected.
Future receipt dates are rejected. Receipt date uses the configured business zone.

`COMMISSION_RATE` defaults to 0.50, with up to four decimal places. Calculation
uses integer basis points and BigInt intermediate arithmetic. Commission rounds
half-up to a whole TWD dollar; return = receipt − rounded commission. Thus 15000 at
50% creates commission 7500 and pending return 7500. Rate snapshots are never
recalculated when configuration changes. Current implementation uses the system
rate; a per-case override can be added later.

Receipt status and return status are separate. Mark returned saves actor/time;
mark pending clears current return markers but keeps both transition audits.
Voided receipts stay visible in case history and are excluded from active finance
ledgers and exports. A returned receipt cannot be voided until an authorized user
marks its settlement pending. Cancellation preserves paid schedule history and
cancels unpaid forecasts.

Finance permissions are centrally registered in `permissions.ts`: payment
view/create/void, settlement view/mark_returned/mark_pending, finance.export.
The finance role has financial access without case editing or dispatch authority.
Ordinary collectors can view/create receipts only for current assigned cases;
they have no return-marking or export permission. Every route checks permissions
and case scope on the server.

## XLSX export

`finance-export.ts` writes genuine Office Open XML workbook parts into a ZIP with
fflate. Strings are inline text (including formula-like codes), XML is escaped,
and amounts are numeric return amounts. Export is session-authenticated, private,
no-store, permission checked and audited. Date bounds are inclusive and match the
finance page. Maximum 5000 rows per export; larger requests require a smaller
range rather than silently truncating.

Exactly five columns: 日期 / 代理/代號 / 客戶 / 金額 / 類型. Type is 收. Internal IDs,
commission rates, audit and return status are omitted. Filename contains the date
range. The downloaded sample was independently opened with openpyxl, which
verified the five columns and numeric 7500 return amount.

## Manual entry and duplicates

New case is a quick manual entry with finished private images, code, customer and
canonical region. Optional address/amount preserve ordinary manual entry when an
image is not yet available. Missing optional details are explicitly not recorded
(amount defaults to 0); nothing is inferred with AI/OCR. Private objects are
validated and SHA256-hashed before the case/media/audits transaction; object-store
writes are compensated if the database write fails. Images use the existing
permission-checked byte API and browser blob thumbnails, never public URLs.

The existing case `code` remains the combined business agent/code identifier;
collector identity is a separate concept. No separate agency field previously
existed. Duplicate checking compares trimmed case-insensitive code, not customer
name, and returns only the latest creation date. A warning does not create a case.
Explicit override is rechecked on the backend, preserves the original case,
creates a separate case and records duplicate_warning_overridden. Both manual
multipart creation and the ordinary create API enforce this rule.

Poster generation pages/workflows did not exist in the baseline. The new manual
entry has no poster source selection; poster_builder and LINE options were removed
from the intake UI. Historical source values remain readable for compatibility
with existing fictional starter data. Telegram image extraction is unchanged.

## Region and historical correction

The DB stores one of 22 requested Taiwan city/county names, or null for existing
unrecorded cases. API schemas and D1 triggers reject free text. Search includes
region; list filters compose region, collector, actual active assignment and case
status. Assigned means an assignment with unassigned_at null, regardless of textual
case status. Region summaries are scoped DB queries, not hardcoded demo counts.
Unrecorded regions can be filtered separately. Case links open the detail page.

Historical correction uses `assignment.correct` and case scope, validates an
active collector and creates a correction row linked to the previous assignment.
The prior row remains, its original time is retained, and the UI labels it
Corrected rather than presenting the correction as a new dispatch today.
Name/code/region edits and correction audits never alter financial snapshots.

## Before production

Review and commit the local baseline. Configure production auth/role grants,
server bindings, private storage, commission policy and business timezone; rehearse
migrations against a backup, verify restore/export limits and complete isolated
test-bot integration checks. Address any remaining local E2E connection flakiness.
Do not register production webhooks or deploy as part of this phase.

## Verified local baseline (2026-10-08)

- Frozen lockfile install passed; only fflate 0.8.2 was added to the existing
  dependency graph. Vendored shadcn/ui files were unchanged.
- Backend: 181 tests across 14 files passed, including transaction rollback,
  same-key concurrent receipts, rate snapshots, cancelled forecast/void handling,
  Telegram deadline/weekly/monthly confirmation retries and permission denials.
- Chromium: all 32 tests passed in the final full run, including finance and
  dispatch mobile flows, private finished images, duplicate overrides and downloads.
- TypeScript, lint, Biome CI, frontend build and local Worker dry-run passed.
- Local D1 foreign_key_check returned no violations after both new migrations.
- The actual exported XLSX was independently opened with openpyxl and verified
  to contain the exact five columns and numeric return amount 7500.
- All external integrations used fake clients/providers. Live bot/provider and
  production migrations remain separate prelaunch work.
