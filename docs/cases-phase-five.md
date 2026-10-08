# Phase five: unified intake

This workflow uses local development and fictional records. No Telegram, LINE, OpenAI, OCR, or production deployment is connected.

## Storage and validation

`intake_items` stores source, external ID, dedupe key, status, original proposal, confirmed proposal, matched case, linked review, creator, timestamps, and optimistic version. Internal write tokens guard related transaction statements. Optional case-number hints and extraction confidence support matching and review.

`intake_media` stores private object keys, filenames, image types, SHA-256, ordering, duplicate flags, and promotion markers. Foreign keys connect intake, review, case, and promoted case media. Migration `0009_brave_nicolaos.sql` contains indexes, uniqueness constraints, and checks.

Draft proposals accept exactly `code`, `customer_name`, `address`, and `amount_due`; missing extraction values may be null. Confirmed proposals require all four valid values. Unknown fields are rejected. A receipt never creates or updates a case.

## Services and matching

`packages/api/src/intake-service.ts` receives drafts and records audits. Unique source/external-ID and source/dedupe-key indexes protect concurrent retries. Identical retries return the existing authorized intake; conflicting payloads or keys return a conflict.

`case-matching.ts` checks visible cases using exact case number, code, and customer name, in that order. Normalized addresses can narrow multiple matches. Normalization uses Unicode NFKC and removes punctuation and whitespace. Results are unique, ambiguous, or no match. More than 50 candidates requires narrowing; a truncated candidate list cannot silently become a unique match.

`intake-resolver.ts` is the only formal resolution path. It validates permissions and proposals, uses version guards and an atomic D1 batch, generates case numbers on the server, and writes audits. Matching preserves existing case fields. Creating requires no match and `case.create`; attaching images also requires `media.upload`. Repeated successful requests return the existing result.

Intake source remains intact. Case source mapping is manual/API/LINE to `manual`, Telegram to the reserved `telegram_ai` label, poster builder to `poster_builder`, and historical import to `historical_import`. These labels do not invoke external services.

## Human review

Ambiguous matching creates a `case_match` review with stored candidate IDs. Selection must belong to both the stored candidates and the current permitted matches. Partial proposals or confidence below 0.8 create an `image_extraction` review. Correction requires complete validated fields. If correction exposes ambiguity, another case-match review is required before formal resolution. Original proposals remain available alongside confirmed data.

Review resolution delegates to the intake resolver and resolves the review in the same database transaction. Unresolved drafts do not modify formal cases. Rejecting preserves source records and private attachments.

## Private attachments and promotion

Native authenticated endpoints upload and serve intake images. Upload validates origin, ownership, draft state, image signatures, MIME types, filenames, and limits (five files per request, five MiB per file, 100 per intake). SHA-256 duplicates are flagged and audited; original records are retained.

`intake-promotion.ts` verifies source bytes and copies them to new private case keys. The atomic database batch inserts case-media links and marks source records promoted, together with resolution and audits. Failed database writes trigger cleanup of staged copies. Object storage and D1 do not share a transaction; staging and compensating cleanup address that boundary. Promotion retry skips recorded promotions. Source objects remain available independently of case-media deletion.

Both intake and case images use `privateCaseStorage`; the existing private R2 adapter remains the future storage connection. API responses serve authenticated bytes, never public URLs. Matched intake visibility for ordinary users additionally requires current assignment to the formal case.

## Permissions and future adapters

`permissions.ts` defines `intake.view`, `intake.create`, `intake.resolve`, and `intake.reject`. Managers/admins have management grants. Ordinary users may view/create their own drafts, but cannot resolve or reject them. External-source simulation requires management permission. Linked review decisions require review permission plus the relevant intake and formal-case permissions. All checks run on the server.

`intake-contract.ts` defines `IntakeSourceAdapter` and a receiver capability. Adapters normalize inputs and call the validated receiver; they receive no cases-database capability. It also defines `ImageExtractionProvider` and strict extraction-output validation. Future OCR implementations return nullable extracted fields and confidence, then feed intake. They cannot directly insert/update cases or execute SQL.

Audit events include receipt, duplicate detection, matching, case creation, review submission, rejection, attachment upload, promotion, and linked review decisions. Metadata contains identifiers/counts rather than image bytes, credentials, or secrets.

## Local verification

Run `pnpm typecheck`, `pnpm lint`, `pnpm ci`, `pnpm test`, `pnpm test:e2e`, and `pnpm build:local`. Worker packaging can be checked with Wrangler `deploy --dry-run --config wrangler.local.jsonc`. Check local D1 using `PRAGMA foreign_key_check`. The browser suite covers private upload, duplicate detection, mobile layout, ambiguous matching, ordinary-user restrictions, and incomplete extraction correction.

Verification on 2026-10-08 passed: TypeScript, lint, Biome CI, 129 backend tests (including 18 intake tests), 26 browser tests (including four intake tests), frontend client/SSR build, Worker dry-run packaging, and local foreign-key check with zero violations. Use `pnpm run ci` explicitly because pnpm reserves the bare `ci` command.
