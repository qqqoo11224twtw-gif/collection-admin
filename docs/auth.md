# Auth — AUTH_MODE, sessions, admin, API keys

## Operations integration override (2026-10-09)

The operational product now uses **provisioned active users only** in both
`open` and `admin-only` modes. The historical starter behavior described below
(public OTP registration and runtime ADMIN_EMAILS promotion) is superseded.
`disabled` still unmounts authentication and fails protected APIs closed.

- `/api/auth` checks a trimmed, lowercased email against `user.email` and
  `user.active` **before** better-auth runs. Gmail `+alias` values remain distinct.
- Unknown/inactive addresses receive a generic Chinese 403; they generate no
  OTP, no email, no user and no session. `emailOTP.disableSignUp` and a user
  creation database hook also prohibit auto-registration.
- Session creation checks active/banned state. Every session resolution reloads
  the user and persisted session, bypassing stale cookie permissions. Disabled
  users have sessions deleted and subsequent requests are rejected immediately.
- Roles are default permission templates, with explicit allow and explicit
  deny (deny wins). `user_permission.manage` governs `/cases/users`, including
  the login allowlist. Permission changes are read from D1 on each request.
- ADMIN_EMAILS no longer promotes accounts during normal login. Existing
  provisioned admins remain admins; future accounts are managed in the UI.
- The first account is initialized offline, never through public login. Local
  demo admins are seeded by `scripts/seed-cases.ts`. A clean local installation
  can use `node scripts/bootstrap-admin.ts admin@example.test --local` after
  migrations. The script inserts an admin only if no active permission manager
  exists. It cannot target a remote database.
- Before a staging/production release, initialize/review the approved admin
  directly through that environment's controlled seed process. Do not run the
  local bootstrap against production, reuse demo emails there, or enable public
  bootstrap endpoints. See `docs/operations-integration.md`.
- The last active permission manager cannot lose management rights, be
  disabled or change email without another active manager. The conditional D1
  write enforces this under concurrent changes. All permission changes audit
  previous and resulting grants; rejected writes do not revoke sessions.
- Auth plugin administration endpoints are not publicly exposed. Operational
  account management uses permission-checked application APIs instead.
- OTP messages, cookies and provider bodies are never written to system or
  console logs. The dev OTP readback remains local only when no Resend key is
  configured. UI text no longer offers signup.

The remaining sections document the underlying starter and API-key machinery;
any statement allowing public registration or runtime admin promotion must not
be used for this operational product.

> **Read this before touching anything auth-related** — routes, login UI,
> env files, or any table named `user`/`session`/`account`/`verification`/
> `apikey`/`rate_limit`. It is written for the agent working on a fresh
> clone of this template: what to configure, what never to change, and the
> traps that are not visible from the code.

Stack: [better-auth](https://better-auth.com) 1.6 (official core + admin +
emailOTP plugins, `@better-auth/api-key`) on D1/Drizzle. Passwordless only:
one way in, a 6-digit email OTP. No password registration, no forgot/reset
flows — do not add them to Core; product-specific login methods (social,
Bearer for desktop) are extensions on top.

## 1. The one switch: `AUTH_MODE`

Set in the server's env file (`apps/server/.{stage}.env`); read lazily by
`authMode()` in `packages/api/src/auth.ts`. **Three values, one auth
instance** — the modes are configurations, never parallel systems:

| Mode | Who can sign in | Use it for | What changes |
|---|---|---|---|
| `open` (**local default**) | Anyone — any email self-registers via OTP | Customer-facing SaaS (most products) | Everything mounted; OTP send endpoint is rate-limited (see §5) |
| `admin-only` | Only `ADMIN_EMAILS` | Internal consoles, private dashboards | A Hono-layer whitelist gate rejects other emails with 403 `EMAIL_NOT_ADMIN` **before** better-auth runs |
| `disabled` (**deployed default**) | Nobody — there is no auth | Pure public sites (e.g. `website`) | `/api/auth/*` and `/api/v1/*` 404; `protectedProcedure`/`adminProcedure` always throw 401 `AUTH_DISABLED` |

Rules that hold in **every** mode:

- `ADMIN_EMAILS` (comma-separated, trimmed, lowercased) is the only way to
  bootstrap admins. Listed emails get `role='admin'` on first sign-in, and
  existing users are **promoted** when added to the list later. Removal from
  the list never auto-demotes. **Never implement "first registered user
  becomes admin"** — that pattern has produced real takeover CVEs.
- The frontend learns the mode from the public `config.status` oRPC probe
  (`orpc.config.status`) — **do not** duplicate `AUTH_MODE` into web env.
- **Unset `AUTH_MODE` resolves environment-aware**: `open` locally (the
  demo works with zero config), `disabled` on deployed stages (fail-safe
  — a fresh fork deploys with zero env and exposes nothing; the deploy
  log announces it). Enabling auth in production is always an explicit
  `AUTH_MODE=` line.
- An unknown `AUTH_MODE` value fails the deploy (alchemy) and 500s at
  runtime (fail closed). No silent fallback.

### Switching modes

- **→ `admin-only`**: set `AUTH_MODE=admin-only` and a non-empty
  `ADMIN_EMAILS`. Nothing else — the gate and the login page adapt.
- **→ `disabled`**: set `AUTH_MODE=disabled`, then **delete** the routes and
  UI the product doesn't need (login page, the API keys example, protected demos,
  `apiKeysApi`). The always-401 middleware is a fuse for forgotten routes,
  not a license to ship them.
- **→ `open`**: the default; make sure the §5 rate limit stays on in
  production and `ADMIN_EMAILS` still names at least one admin.

## 2. Env matrix (enforced at deploy time)

`apps/server/alchemy.run.ts` fails a **deployed** stage (anything except
`local` / `pr-*`) that violates this table. Locally everything has a safe
default: OTP codes print to the server console and are readable at
`GET /api/dev/otp?email=...` (that endpoint ceases to exist the moment
`RESEND_API_KEY` is set, and in `disabled` mode).

| Variable | disabled | open | admin-only | Notes |
|---|---|---|---|---|
| `AUTH_MODE` | valid value | valid value | valid value | unset ⇒ `open` locally, `disabled` deployed |
| `BETTER_AUTH_SECRET` | — | ✅ required | ✅ required | `openssl rand -hex 32`; local default is `local-dev-secret-not-for-prod` |
| `RESEND_API_KEY` + `EMAIL_FROM` | — | ✅ required | ✅ required | Resend REST API; `EMAIL_FROM` must be a verified sender domain |
| `ADMIN_EMAILS` | — | ✅ required | ✅ required | admin-only: empty = nobody can sign in; open: empty = no admin channel |

When you add/remove any of these, update `apps/server/.local.env.example` in
the same commit — that file is the source of truth for what each variable does.
`docs/deploy.md` only needs a change if the *mechanism* changed (file
layering, sync path, derived bindings).

## 3. Route protection — every route picks one, explicitly

oRPC procedures come from `packages/api/src/middleware.ts`:

| Procedure | Grants | In `disabled` mode |
|---|---|---|
| `publicProcedure` | anyone | works |
| `protectedProcedure` | signed-in user; context narrows `session`/`user` to non-null | **always 401 `AUTH_DISABLED`** |
| `adminProcedure` | signed-in user with `role='admin'` | same |

Plain Hono routes must do the equivalent explicitly (see the `/api/v1/*`
key middleware and the `/api/tasks/definitions` pattern in `tasks`). The
rule from the auth plan: *every HTTP/oRPC route must explicitly choose*
Public · User Session · Admin Session · Managed API Key · product signature
· Service Binding. When you add a route and are unsure, default to
`protectedProcedure`.

Never call better-auth from the client with anything but the official
`authClient` (`apps/web/src/lib/auth.ts`) — it handles the httpOnly session
cookie; `credentials: 'include'` is already wired into the oRPC link too.

## 4. Managed API keys

- Users create named keys on the API keys page (`/examples/components/api-keys`); the **plaintext appears exactly once**
  in the create response (component state only — never cache, log, or
  persist it). The DB stores a hash.
- Server-side constants in `packages/api/src/auth.ts`:
  `API_KEY_PREFIX = 'sfapp_'` — **every forked product must rename this**
  (a product named Acme would use `acme_`) — and `API_KEY_PERMISSIONS`, the fixed
  permission set. Users never edit permissions; version one exposes no
  permission UI.
- Expiry is chosen at creation: default **never**, presets 7/30/90/365 days,
  hard cap 365 (`maxExpiresIn` is in **days**).
- Verify with `verifyApiKey(token)` → `{ valid, keyId, userId }`; the demo
  endpoint is `GET /api/v1/whoami`. Always return **one generic 401** for
  every failure mode (missing, forged, expired, revoked, wrong permissions)
  — never reveal which.
- **Never introduce a shared env API key** (`X_API_KEY=...`) for internal
  callers — pilot conclusion. A single trusted same-account caller should
  use a Cloudflare Service Binding (platform-authenticated, zero keys).

### better-auth 1.6 gotchas (documented ≠ actual — verified in the Tasks pilot)

| Item | Docs say | Actually |
|---|---|---|
| `createApiKey.expiresIn` | seconds | seconds ✓ |
| `keyExpiration.defaultExpiresIn` | milliseconds | **seconds**; `null` = never expires |
| `keyExpiration.minExpiresIn`/`maxExpiresIn` | — | unit is **days** (defaults 1/365) |
| `listApiKeys` return | — | `{ apiKeys }` wrapper object, not an array |
| Key owner column | — | `referenceId` (renamed from `userId` in 1.6) |
| Per-key rate limit | — | **default 10 req/day** — real APIs must set `rateLimit: { enabled: false }` on the plugin (already done) |
| Expired keys | — | **auto-deleted in bulk** whenever any api-key endpoint runs (10s cooldown). Lists never show "expired" for long — keys just vanish; callers see the generic 401. Tell users this in product docs. |
| New-user role | — | the admin plugin assigns `role='user'` (not null) to fresh sign-ups |

## 5. Rate limiting (two separate mechanisms — don't confuse them)

1. **Request rate limit** (better-auth core, `rateLimit` option): D1-backed
   (`rate_limit` table), enabled on every **deployed** auth-enabled stage,
   off locally. Critical rule: `/email-otp/send-verification-otp` → 3
   req/min/IP. In `open` mode this is the only thing standing between your
   Resend account and anyone using the deployment as a mail cannon —
   **never disable it on a deployed `open` stage.** Better-auth's own
   "enabled in production" default never triggers on Workers (no
   `NODE_ENV`), which is why it's set explicitly.
2. **Per-key rate limit** (api-key plugin): intentionally **off** — its
   10 req/day default poisons real APIs. Re-enable per key only if a
   product needs metered keys.

## 6. Where everything lives

| Concern | File |
|---|---|
| Mode switch, auth factory, key wrappers, `getSession` | `packages/api/src/auth.ts` |
| `publicProcedure` / `protectedProcedure` / `adminProcedure` | `packages/api/src/middleware.ts` |
| Request context (session/user/isAdmin) | `packages/api/src/context.ts` |
| Key management oRPC (`apiKeys.*`) | `packages/api/src/api-keys.ts` |
| Config probe (`config.status`) | `packages/api/src/config.ts` |
| OTP mail (Resend / console fallback) | `packages/api/src/email.ts` |
| 5 auth tables + `rate_limit` + per-user `todos` | `packages/db/src/schema.ts` |
| admin-only whitelist gate, `/api/auth/*` mount, `/api/v1/*` key middleware, dev OTP readback | `apps/server/src/index.ts` |
| Deploy-time mode validation + env fail-closed | `apps/server/alchemy.run.ts` |
| authClient (cookie mode) | `apps/web/src/lib/auth.ts` |
| Login page (two-step OTP) | `apps/web/src/routes/login.tsx` |
| `AuthGate` (client-side session guard) | `apps/web/src/components/auth-gate.tsx` |
| `UserMenu`, `ApiKeysManager`, `ConfigNotice` | `apps/web/src/components/` |
| Per-user data pattern (copy for your own tables) | `packages/api/src/todos.ts` + `tests/todos-ownership.test.ts` |
| Test harness (sign-in, authed rpc, mutable env) | `apps/server/tests/helpers.ts` |
| E2E sign-in through the real UI | `apps/web/e2e/auth-helpers.ts` |

## 7. Hard-won constraints — do NOT "simplify" these away

Each of these looks removable and is not. All were paid for in a production
pilot before being extracted into this template:

- **The admin-only whitelist gate lives in the Hono layer, BEFORE
  better-auth.** better-auth writes the verification row *before* invoking
  `sendVerificationOTP`, so a gate inside the send callback would leak rows
  for denied emails. Moving the gate "into the plugin where it's cleaner"
  reintroduces that leak.
- **Hono middleware reads `env` from `cloudflare:workers`, never `c.env`.**
  Tests call `app.fetch(request)` directly without an env argument — `c.env`
  is undefined there.
- **The auth instance is not exported** from `auth.ts`; its plugin-inferred
  type references zod internals that break declaration emit (TS2883). Use
  the typed wrappers. (Same reason `apps/web/tsconfig.json` sets
  `declaration: false`.)
- **`vitest.config.ts` has an `onUnhandledError` filter** for ORPCError /
  better-auth APIError shapes: oRPC converts them into proper HTTP responses
  (which tests assert), but the workers pool still reports the rejected
  promise. Precise filter only — do not switch to
  `dangerouslyIgnoreUnhandledErrors`.
- **`db:generate` auto-formats `migrations/`** (biome) — drizzle-kit's meta
  JSON otherwise fails `biome ci` every time.
- **Session resolution applies promotion-only admin sync** (`getSession`).
  Demotion is manual by design: a fat-fingered `ADMIN_EMAILS` edit must not
  lock every admin out.
- **`patches/alchemy.patch`** stops the alchemy dev proxy from crashing the
  whole dev process on client-aborted requests. Keep it until the fix ships
  upstream.

## 8. Self-check before you commit auth-touching changes

1. `pnpm test && pnpm typecheck && pnpm exec biome ci .` — all green.
2. Did you add a route? It names its protection level explicitly (§3).
3. Did you touch env? `apps/server/.local.env.example` updated in the same
   commit (§2).
4. Could an OTP, session token, or key plaintext reach a log, an error
   message, the URL, or the query cache? (grep your diff for `console.log`.)
5. Products cloned from starter: renamed `API_KEY_PREFIX`? Set your own
   `data-app` in `__root.tsx`? Picked your `AUTH_MODE` and filled the §2
   matrix for deployed stages?
6. Local e2e still signs in? (`pnpm --filter web test:e2e` — needs the dev
   server running without `RESEND_API_KEY`.)
