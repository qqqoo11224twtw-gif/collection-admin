# Production security hardening — 2026-10-11

This report records the Phase 1 and Phase 2 verification before Git archival. Business rules, Telegram routing, financial calculations, authentication/TOTP, migrations and production/staging business data were not changed by hardening.

The subsequently verified Telegram expiry/account-switch fixes retain these controls. The combined production artifacts are API `556b7dd5-7aa4-4824-8bc4-ce69d103afff` and Web `b8582db7-dfba-47cd-8bb8-32fc42d00f00`. Archival uses separate focused commits for hardening and the fixes; it does not redeploy or change Cloudflare edge rules, routing, Cron or business data. The Phase 1/2 version IDs below remain historical verification references.

## Audit and deployed controls

| Item | Result |
| --- | --- |
| DNS / proxy / TLS | Dashboard confirms `admin.kpirich.bid` and `api.kpirich.bid` are proxied Worker records pointing to the production Web/API. HTTPS requests succeed. No DNS changes were made. DNS REST inspection was denied (403); Dashboard supplied the verification. |
| Alternative endpoints | Production API/Web `workers.dev` and preview entry points are disabled. Custom Domains remain HTTP 200. Staging is unchanged. |
| SSR security headers | `nosniff`, `no-referrer`, Permissions-Policy disabling camera/microphone/geolocation/payment/USB, `X-Frame-Options: DENY`, `X-Robots-Tag: noindex, nofollow, noarchive`. HTML has `private, no-store`. |
| Static assets | `public/_headers` supplies the baseline headers; dynamic Worker responses apply the same controls in `src/server.ts`. Static-only headers are not the SSR protection. |
| CSP enforcement | `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`. |
| Full CSP | Report-Only: default/self, scripts/self/inline/Turnstile, styles/self/inline, connect/self/production API/Turnstile, images/self/blob/data/production API, fonts/self/data, frames/Turnstile, form/self. SSR hydration and theme scripts still need inline support. No CSP report collector was added; violations are visible in browser diagnostics. |
| Source maps | Explicit `build.sourcemap=false`; no `.map` files or sourceMappingURL directives in public artifacts; `.map` requests return 404. |
| Public artifacts | 86 files scanned against known production secrets, token patterns, staging endpoints and filesystem paths: no sensitive matches. Two dependency-only localhost literals remain (better-auth hostname syntax and TanStack Router fallback), not an application endpoint or secret. They were not removed by modifying dependencies. |
| Error handling | Unexpected API failures return only `INTERNAL_SERVER_ERROR`; SSR failures return a generic Chinese message. Console diagnostics use safe event codes, not raw exceptions. Detailed SQL/credential marker rejection is tested. |
| CORS | Only `https://admin.kpirich.bid`; OPTIONS 204; credentials enabled; unauthorized origins receive no Allow-Origin. Webhook does not use browser CORS. |
| Cookies | Existing host-only API cookies: Secure, HttpOnly, Path=/, SameSite=None for the existing cross-origin frontend flow. Session values stay outside JavaScript. Existing 15-minute idle expiration is unchanged. |
| Private R2 | Managed public endpoint disabled, no custom public domains. Media requires login and case permission, uses private/no-store/nosniff and inline disposition. Unauthenticated request returns 401. Human administrator confirmed permitted images can still open. No object uploads/deletions or migrations were performed. |
| Telegram | Missing webhook secret: 401. Correct secret with an empty/invalid payload: 400 schema rejection, without submitting an update. Formal Bot/routes remain active, mode live, webhook unchanged, pending=0/no Telegram error. No new production Telegram messages or business fixtures were created. |
| Cron | Existing `* * * * *` unchanged; actual scheduled events have outcome=ok. No manual processing calls. Quarantined history remains unclaimed; DELIVERY_UNKNOWN remains failed/attempts=1. |
| Safe logging | Worker application logs enabled, sampling=1; automatic invocation logging disabled. Existing auth/System Log safe codes remain. Dashboard records 8 scanner blocks and 12 rate-limit blocks from controlled probes. Passwords/TOTP/tokens/header values are not logged by the added code. |

The original local Wrangler entry pointed directly to the framework default entry and bypassed `src/server.ts`. It now selects the custom entry so SSR hardening actually executes. This change is limited to the entry selection; no framework or application flow was rewritten.

## Edge rules

Scanner rule: `collection-admin block scanner paths`, ID `9a9510c29f5540849bd683706f8d3797`, active Block. It applies only to admin/API hostnames and the nonexistent `/.env`, `/.env.*`, `/.git`, `/.git/*`, `/wp-admin`, `/wp-admin/*`, `/phpmyadmin`, `/phpmyadmin/*` paths. Eight controlled probes returned 403; eight events were recorded.

Auth rule: `collection-admin auth burst limit`, ID `bb30535cb7db4cf394783f21cb6a9c34`, active Block. Per IP, 20 requests/10 seconds; mitigation 10 seconds. Host must be api.kpirich.bid, method POST, path one of `/api/auth/login`, `/api/auth/verify-totp`, `/api/auth/verify-recovery`, `/api/auth/onboarding/password`, `/api/auth/onboarding/totp`, `/api/auth/change-password`, `/api/auth/recovery-codes`. It excludes session polling, activity, logout, financial/private-media APIs and Telegram webhook.

The first multi-connection probes were split across SIN/HKG/NRT and did not observe a block. One bounded same-connection HKG probe produced 20 schema-400 responses then 12 edge-429 responses. Empty bodies were used: no real password, account, session or business record was submitted.

Existing backend login guards remain: username+IP 10/minute, account-wide 15/minute, IP 30/minute. Cloudflare counters are approximate and distributed, so the backend guards remain important. See [Cloudflare request counting](https://developers.cloudflare.com/waf/rate-limiting-rules/request-rate/) and [troubleshooting](https://developers.cloudflare.com/waf/rate-limiting-rules/troubleshooting/).

Free plan has one edge rate-limit rule, now used by authentication. General authenticated API and private media do not have newly enforced global limits. Initial planning thresholds are 600/minute/user for API and 120/minute/user for images, with IP aggregation reviewed for shared networks and 500-row views. Observe traffic before enforcement; adding coverage needs more edge-rule capacity or a separately validated backend limiter. Do not apply these limits to Telegram webhook or scheduled processing.

## Deferred phases

Turnstile is optional and has not been inserted into the login flow. Existing widget inventory could not be read with current OAuth (403). If adopted, create independent Managed widgets for production and staging, production hostname only admin.kpirich.bid. Public sitekey may be bundled; secret stays in Worker Secrets. Verify tokens server-side before credential acceptance; require expected hostname/action, reject missing/invalid/expired/reused tokens, fail closed on provider failure, and never log tokens. Stage the complete username/password/TOTP and onboarding flow before enabling production. CSP already allows the provider script/frame/connect origin. See [Cloudflare CSP guidance](https://developers.cloudflare.com/turnstile/reference/content-security-policy/).

Access remains a proposal at the user's explicit request. No Access application/policy was created or enabled. Protect only admin.kpirich.bid, never wildcard/API hostname. Require an approved Email allowlist and test Web→API credentials/CORS, app TOTP, idle expiration and webhook before enforce. App session remains independent of the outer Access session. Closed workers.dev endpoints prevent the obvious alternate-host bypass. Access events cannot be validated while Access is not enabled. See [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

## Verification and versions

- Backend regression: 382/382 across 27 files; added error-sanitization/webhook tests: 2/2.
- Browser: 15/15 Auth/TOTP/password/cases/media/finance/reports/responsive tests; pagination/idle and Telegram administration tests passed; new SSR security tests 2/2 after entry correction. Initial missing-header failure was fixed and re-tested.
- TypeScript, lint, Biome, production Web build, API/Web Worker dry-runs and secret/artifact scans pass.
- Production human confirmation: login/TOTP, cases, finance and authorized image can open.
- DNS proxy, WAF/rate-limit events, CORS/media denial, public headers/robots/maps and actual production scheduled invocation verified.
- Fresh Telegram single-image/album/report/payment conversations were not re-sent in production. Existing backend coverage passes and the live webhook/scheduler configuration is verified. A fresh manual Telegram check remains an optional end-to-end confirmation.
- API version: `63dadf85-3474-49d9-b22a-513546ea0928`.
- Web version: `02994408-fb87-4bfe-a1bb-5b50f9b274c5`.
- FK violations: 0. No migration.

Operational BLOCKER/HIGH: none observed. MEDIUM follow-ups: full CSP is still Report-Only; general API/media global anti-abuse limits are not yet enforced. LOW/informational: two dependency localhost literals; Access deferred; Turnstile optional/not enabled; fresh production Telegram conversation regression not repeated.

## Rollback

Save the current deployment IDs and edge-rule IDs before subsequent changes. API's previous verified version is `81465284-55ba-4565-b158-c73e1be2c7db`; select a confirmed previous Web deployment from its deployment history if rollback is required. Roll back only affected Worker versions, preserving existing secrets/bindings/live mode/custom domains/Cron and all D1 data. For a false-positive edge rule, disable that specific rule rather than deleting it or removing all protection. Do not broaden a WAF skip to the whole API. Closed workers.dev endpoints and independent app authorization should stay in place.

No schema rollback, hard deletion, webhook reset, retry of DELIVERY_UNKNOWN or Telegram backlog replay is part of hardening rollback. This document contains no credentials; detailed safe local receipts remain gitignored.
