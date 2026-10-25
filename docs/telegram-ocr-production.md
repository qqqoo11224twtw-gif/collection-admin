# Telegram OCR production extension

Status: local implementation and 22 functional tests and two release protocol scenarios pass. The production OCR table and two indexes have been created through the Cloudflare dashboard after recording a Time Travel bookmark. Existing business rows, deployed Workers, webhook and group routes have not been changed. Live provider checks, browser acceptance and production publishing are still pending because this executor cannot resolve external API hosts or connect to local Worker test sockets.

## Publish from this computer

Double-click `outputs/Deploy-Telegram-OCR.cmd` in File Explorer. It uses the bundled Node runtime and the ignored `apps/server/.dev.vars`; no keys are placed in command arguments or GitHub. It performs local tests, checks immutable production version IDs against the recovered baseline, validates the pre-created schema, and tests both OCR providers with a synthetic ATM image containing no personal data. Provider failure stops the release before publishing.

It publishes an API version with OCR disabled, then the frontend extension, then enables OCR after a secret-protected readiness check. Existing secret binding types are retained and static assets are preserved using Cloudflare's [multipart upload metadata](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/). Each deployment is checked; detected failures attempt to restore the original Worker versions. Concurrent deployments stop publishing or rollback rather than replacing someone else's version. A failed rollback is explicitly reported and requires operator attention. State is private in `.secrets/production-releases/`.

The command does not change the webhook or schedule, does not create a Telegram identity, and does not modify/delete existing cases. It uses the new additive OCR queue table. The saved Time Travel bookmark is a reference, not a local SQL export; routine rollback restores Workers only, never the whole production database.

## Use after a successful release

Open `https://admin.kpirich.bid/cases/bulk-create/telegram`. It uses the existing backend login and requires case creation, all-case access, media access and Telegram route management permissions. Select the existing `wanwanautoresponder_bot`, enter the intended group and topic, and save. Existing dispatch/report targets cannot be reused as an active OCR target. Ensure the bot is a member and can receive the group's photos; this tool does not change Telegram privacy settings.

Photos in the explicitly enabled source group are queued under the route manager's current permissions, one Telegram message per record. Group members do not receive backend permissions. OCR data is reviewed in the backend, not confirmed through Telegram callbacks. Raw photos are downloaded from Telegram only when needed; they are not copied to R2. Preview capability and OCR evidence expire after 24 hours. Telegram retains its own original messages according to group policy. Confirmed creation work keeps the minimal fields needed for idempotent recovery; expired file references/evidence are scrubbed even while recovery is pending.

Refresh the review list, inspect each original photo and its evidence, correct the three fields, mark reviewed, then create. The list shows at most 100 jobs and prioritizes reviewable jobs; creating records moves them behind the remaining review work. One failed image does not stop others. Existing bulk creation code handles duplicate detection and stable batch IDs prevent repeated creation. No dispatch is triggered automatically.

## Validation and limits

- `node scripts/test-bulk-ocr.mjs`: 18 field, abstention, signature and additive-schema tests.
- `node scripts/test-telegram-ocr-flow.mjs`: 4 native SQLite flow tests, using the actual recovered production permission and case-creation functions; external providers return synthetic fixtures. Covers replay, mandatory review, CSRF, invalid fields, stale versions, disabled routes, revoked managers and expired creation recovery.
- `node scripts/test-production-release.mjs`: synthetic release protocol tests, including restoring both Worker versions after a lost deployment response. No real Cloudflare requests.
- `node scripts/test-production-ocr.mjs`: local Worker smoke checks. Passed on the user's computer before this extension; the release reruns them against the current candidate.
- `node scripts/verify-ocr-providers.mjs`: paid live Google/OpenAI check with a generated non-personal ATM image; no response bodies or keys are logged.

The original full Vitest Worker suite has an existing `cloudflare:test-internal` pool failure. Browser acceptance of the new review page remains unverified; a local preview could not be reached from the browser tool. Real document images and human-labeled accuracy measurement are still required. Do not claim 99.5% accuracy from synthetic tests. All records require human confirmation.

## Recover the baseline after cloning

Install workspace dependencies, run `node scripts/restore-production-baseline.mjs`, then `node scripts/build-production-ocr.mjs`. The restore helper checks all archive chunks and the ZIP hash, rejects unsafe paths, and refuses to overwrite a differing local backup. These are recovered compiled Worker modules; original TypeScript/source maps were not available. Never use the old starter deployment command to replace production.
