# Cloudflare Access email management

Access protects the Web entry only. Website usernames/passwords/TOTP, account roles, collector scopes, API authentication and the 15-minute idle timeout remain independent. No public signup. No API, webhook or Cron Access protection.

## Phase gates

1. Implement/test backend integration, migration 0042, permission `access.manage` and UI at Settings → Access 授權信箱 (`/cases/access`). Admin receives this permission; manager/collector/finance defaults do not. Explicit grants and denies use the existing permission system.
2. Create a separate staging Group and self-hosted Application for the staging Web hostname only. Run real positive/negative OTP, revoke and integration tests. Never reuse production Group IDs.
3. Only after staging PASS, back up production D1, apply 0042, deploy API then Web. Leave production Access enforcement absent.
4. Verify two approved production emails can receive OTP, save existing Cloudflare Group/Application/Policy/organization settings outside Git, and maintain a logged-in Cloudflare Dashboard emergency session.
5. Human approval and successful two-layer login/business checks precede entry enforcement. Creating a domain-bound Access Application can protect it immediately: do not create the production domain-bound Application early and do not use Everyone/Bypass as a temporary workaround.

Missing credentials or human test conditions stop at the current safe gate. A local provider fixture is not a real Cloudflare OTP/revocation test.

## Official API and token

Runtime token, in Worker Secret `ACCESS_API_TOKEN` only:

- Account scope: the selected Cloudflare account only.
- `Access: Organizations, Identity Providers, and Groups Read`.
- `Access: Organizations, Identity Providers, and Groups Write` (Group updates and single-user revocation).
- `Access: Apps and Policies Read` (configuration readback).

An operator setup token can additionally use Apps and Policies Write to provision the staging Application/policy. Keep this separate from runtime credentials. The API permission is account-wide, not Group-scoped; backend never accepts account/group IDs or endpoints from the browser. Rotation is via Worker Secret replacement.

Create Custom Token in Cloudflare My Profile → API Tokens. Transfer locally using ignored `.secrets/access-setup-input.env` and upload through Wrangler secret input without printing it. Do not store real values in examples, D1, frontend variables, error bodies or logs.

Nonsecret Worker settings: `ACCESS_ACCOUNT_ID`, `ACCESS_GROUP_ID`, `ACCESS_APPLICATION_ID`, `ACCESS_HOSTNAME`. Application inspection fails closed if it cannot confirm exact Web hostname or session/login method settings.

- [Update Group API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/groups/methods/update/)
- [Revoke a single user across all Access applications](https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/revoke_users/)
- [Login methods policy](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)
- [Session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)

## Application, policy and 720h sessions

Production Application: self_hosted, only `admin.kpirich.bid` (all paths); never `api.kpirich.bid`, wildcards or account-wide Require Access Protection.
Production Group: `collection-admin-access-users`, Include exact normalized email rules `{ "email": { "email": "approved@example.test" } }`. No email domain, Everyone or broad include.
Allow policy: sole Include `{ "group": { "id": "<production-group-id>" } }`; Require Login methods → the verified One-time PIN provider ID. `login_method.id` points to the `onetimepin` identity provider, not an auth-method string or Google provider. Application allowed_idps contains only that OTP provider. No additional Allow/Bypass/Service Auth policy.

Set/read back Application `session_duration=720h`, Allow Policy `session_duration=720h`, Organization Global `session_duration=720h`. Disable application Authenticate with Cloudflare One Client and shorter client/device sessions. Global settings affect other Access applications: back up and review that shared impact before changing. The UI configuration check is read-only and returns observed values, never changes global settings.

These durations describe normal same-profile reuse, not a guarantee after explicit revocation, cookie clearing, browser privacy policy or administrator changes. Original application idle timeout remains 15 minutes.

## Synchronization and recovery

Cloudflare Group is the authorization source. Every list reads it; local D1 is only management/audit state. Identity has no user_id dependency. Operator references user.id.

Tables: `access_emails` (soft removal and revoke status), `access_operations` (durable pending/success/partial/failed/reconciled journal), `access_group_locks` (one writer per Group). All mutations have backend access.manage enforcement. Exact email format/case/whitespace and strict request schema are validated server-side.

Mutation: acquire D1 lock → GET → compare UI revision → preserve name/include/exclude/require/is_default → GET before PUT → PUT → GET verify resulting email set/name/exclude/require → single-user revoke if removing → atomic local status+audit+journal+unlock. Last unique enabled email cannot be removed. No secret/provider body enters audit.

Cloudflare's documented Group PUT has no documented conditional ETag/If-Match contract. D1 locks serialize this backend's callers; revisions and readback detect observable external edits. There remains an external-writer race between final GET and PUT. Do not claim atomic exclusion of independent Dashboard/API writers. Operational requirement: this dedicated Group has a single management writer; Dashboard emergency edits occur with application management quiesced. If external concurrent writers are required, treat strict lost-update prevention as a deployment blocker until a provider-supported conditional update contract is available. Never silently overwrite an already-observed external change.

A timeout after PUT can mean a partial remote success. The journal/lock stay for inspection, and no automatic write retry occurs. Explicit read-only recovery after 2 minutes atomically claims the recovery lock, reads the provider twice, reconciles real state, audits and unlocks. Missing emails whose revoke was not confirmed remain revoke_pending; administrators separately confirm/retry account-wide revoke. Recovery never automatically adds an email back. Failed revocation is revoke_failed, and UI displays “白名單已移除，但 Session 撤銷失敗”. Retry rechecks Cloudflare and does not reissue an already-completed Group change.

POST organizations/revoke_user with email only revokes that user's Access tokens across this account's applications. UI requires impact acknowledgment on every disable/remove. Do not substitute application revoke_tokens. Provider success confirms API acceptance; actual old-session denial and inability to obtain a new session require real browser testing and propagation observation, not a fixture assertion.

Audit/history includes operator, timestamp, operation id, email, before/after active membership and safe result codes. Never includes Access tokens or credentials. History is available through the permission-checked UI.

## Acceptance and rollback

Staging: CRUD, duplicate/invalid, concurrent writes, external edit conflict, unsafe Group, final-email guard, permissions, provider failure, partial revoke recovery. Then real authorized OTP, unauthorized denial, old-session revoke, new-session denial, username/password/TOTP, same-profile admin/collector switching, authorized private media/unauthorized denial, webhook/Cron and Telegram native photo/album smoke. Use fictional data only.

Production entry activation requires two human-confirmed OTP addresses and Dashboard rollback readiness. Preserve the two-layer login test before enabling real entry traffic. Do not falsely mark real OTP, 30-day continuity or session denial PASS without evidence.

Emergency: use the already-authenticated Cloudflare Dashboard account, export current policy/group first, then remove the specific collection-admin self-hosted Application to stop entry interception if necessary. Do not alter other apps, root DNS, API routes, Telegram/Cron or organization-wide Require Access Protection. Keep local audit tables and D1 data. Restore only the specific backed-up application/policy/group once corrected. Avoid reverting global organization settings unless the saved diff proves no unrelated changes.

Program rollback: record current API/Web deployment IDs, revert Worker versions only after compatibility checks; leave additive 0042 tables/audit history intact. Missing integration settings fail the new management feature safely, not existing Auth/business APIs. Never roll back business data or delete ledger history.
