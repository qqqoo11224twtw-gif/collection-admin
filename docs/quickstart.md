# Quickstart — from "Use this template" to auto-deployed prod

The complete walkthrough for a brand-new user: create your repo from the
GitHub template, run it locally, deploy it to **your own** Cloudflare
account by hand once, then wire up multi-environment auto-deploy so you
never deploy by hand again.

Deep dives live elsewhere — this page is the happy path:
[docs/deploy.md](deploy.md) (full deploy runbook + troubleshooting),
[docs/auth.md](auth.md) (auth configuration), [docs/ports.md](ports.md)
(rename checklist), [docs/environment.md](environment.md) (every env var).

## 0 · What you're about to deploy

- **Two Cloudflare Workers**: `server` (Hono API, D1 + KV + optional R2)
  and `web` (TanStack Start frontend). Each is provisioned by its own
  `apps/{server,web}/alchemy.run.ts` — TypeScript infra-as-code
  ([alchemy](https://alchemy.run)), no `wrangler.toml`.
- **Auth defaults are environment-aware**: locally everything is on
  (`open` mode — the full sign-up demo works with zero config); a
  deployed stage without `AUTH_MODE` set ships with auth **disabled**
  (fail-safe: no sign-in surface, nothing to configure). Enabling
  sign-in in production is one explicit step — see 4.1.

## 1 · Prerequisites

```bash
node -v    # >= 24
pnpm -v    # >= 9   (npm i -g pnpm)
git --version
gh --version   # GitHub CLI — needed for CI secrets in step 5
```

Plus:

- A **GitHub** account.
- A **Cloudflare** account — the free plan is enough (Workers, D1, KV).
- (For deployed auth) a **[Resend](https://resend.com)** account to send
  sign-in codes — free tier is enough to start.

## 2 · Create your repo from the template

On GitHub: **Use this template → Create a new repository**, then clone
it. Or in one line:

```bash
gh repo create my-app --template saasflare-dev/starter --private --clone
cd my-app
pnpm install
```

### Make it yours (5 minutes, do it now)

The product identity lives in ONE place — the `saasflare` block in the
root `package.json`; every title, resource name, e2e guard, and API key
prefix derives from it (details in [docs/ports.md](ports.md)):

```json
"saasflare": {
  "projectName": "my-app",
  "displayName": "My App",
  "appId": "my-app",
  "apiKeyPrefix": "myapp_"
}
```

Still manual: `apps/web/public/favicon.svg` (your icon), the `description`
meta in `__root.tsx`, and local ports if you run several saasflare apps
side by side (ports.md).

## 3 · Run it locally

Local dev needs Cloudflare auth once (alchemy provisions local resources
and a remote-backed R2 binding):

```bash
pnpm dlx alchemy login   # opens a browser, log into your CF account
pnpm dev                 # server on :4000, web on :3000
```

Open http://localhost:3000 — the console shows live health checks and
the example cards. Try the login story end to end, **no configuration
needed**:

1. Click **Sign in**, enter any email address.
2. The 6-digit code is **printed in the server terminal** (no mail
   service locally) — or fetch it:
   `curl "http://localhost:4000/api/dev/otp?email=<the-email>"`.
3. Enter the code — you're signed up and in. Visit the *Per-User Data*
   and *API Keys* examples to see what the template gives you.

Quality gates you'll use constantly:

```bash
pnpm test        # Miniflare integration tests (real D1, no mocks)
pnpm typecheck
pnpm exec biome ci .
pnpm --filter web test:e2e   # Playwright against the local dev server
```

## 4 · First manual deploy to YOUR Cloudflare account

You're already authenticated — the `pnpm dlx alchemy login` from step 3
covers deploys too (credentials in alchemy's local store, deploy state
in `.alchemy/`). So the first deploy is one command:

```bash
pnpm run deploy:dev
```

Alchemy provisions KV + D1 (with migrations) + the two Workers and
**prints both URLs at the end of the run**. Verify:

```bash
curl -fsS "<the-server-url>/health"   # → {"status":"ok"}
```

The deployed app runs with **auth disabled** (that's the deployed
default when `AUTH_MODE` isn't set — the deploy log says so): no login
button, protected demos 401. For a public site, you may be done.

> First deploy on a fresh CF account can fail resolving `*.workers.dev`
> — new accounts have no workers.dev subdomain until the first Worker
> exists. Fix: `pnpm dlx wrangler deploy --name throwaway`, then
> `wrangler delete throwaway`, and re-run the deploy.

### 4.1 Enable sign-in (when you want it)

Set the mode explicitly and provide mail delivery — create
`apps/server/.dev.env`:

```bash
cat >> apps/server/.dev.env <<'ENV'
AUTH_MODE=open
BETTER_AUTH_SECRET=<openssl rand -hex 32>
ADMIN_EMAILS=you@example.com
RESEND_API_KEY=re_xxxxxxxxx
EMAIL_FROM=My App <auth@yourdomain.com>
ENV
pnpm run deploy:dev
```

- `AUTH_MODE` — `open` (customers sign up) or `admin-only` (only
  `ADMIN_EMAILS` may sign in). Full matrix: [docs/auth.md](auth.md).
- `ADMIN_EMAILS` — comma-separated; these accounts get the admin role.
- `RESEND_API_KEY` — from [resend.com](https://resend.com) → API Keys.
- `EMAIL_FROM` — must be a **verified sender domain** in Resend
  (Domains → Add Domain, add the DNS records). While testing you can
  use Resend's sandbox sender `onboarding@resend.dev`, which only
  delivers to your own Resend account email.

Once `AUTH_MODE` is `open`/`admin-only`, the deploy **fails closed**
without the other three values — a half-configured login can never
ship. Sign in on the deployed site with an `ADMIN_EMAILS` address: the
code now arrives by real email (the local `/api/dev/otp` backdoor does
not exist on deployed stages; that's enforced, not a convention).

### 4.2 (Optional) custom domains and R2

Skip on the first pass — you'll get free `*.workers.dev` URLs.
When you want `app.yourdomain.com` or file uploads, follow
[deploy.md A3](deploy.md#a3-create-per-app-stageenv-files).

## 5 · Multi-environment auto deploy (GitHub Actions)

The workflows are already in the template — you only feed them secrets.
From here on, every git ref maps to an isolated **stage** (same code,
separate Workers/D1/KV):

| Stage | Created by | Purpose |
|---|---|---|
| `local` | `pnpm dev` | Your machine (`localhost:3000` / `:4000`) |
| `dev` | push to the `dev` branch | Shared development environment |
| `pr-<N>` | opening a PR | Isolated preview per PR, auto-destroyed on close |
| `prod` | push to `main` | Production |

**Pipeline** (`.github/workflows/deploy.yml` + `preview.yml`):

| Git event | What happens |
|---|---|
| Pull request | lint + typecheck + tests, **plus** an isolated `pr-<N>` stage with its own Workers/D1/KV — preview URLs posted as a PR comment, auto-destroyed on close |
| Push to `dev` | tests → deploy the `dev` stage |
| Push to `main` | tests → deploy the `prod` stage |

### 5.1 Prepare prod env

Only needed if you enabled sign-in (4.1) — same values for prod, with
**a different signing secret**:

```bash
cat >> apps/server/.prod.env <<EOF
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
ADMIN_EMAILS=you@example.com
RESEND_API_KEY=re_xxxxxxxxx
EMAIL_FROM=My App <auth@yourdomain.com>
EOF
```

Add prod domains / R2 keys here too if you use them (and mirror the
domains into `apps/web/.prod.env` — see deploy.md A3).

### 5.2 Headless credentials → `.alchemy.env`

CI has no browser, so it can't use `alchemy login` — it needs an API
token in an env file that gets uploaded as a secret:

```bash
cp .alchemy.env.example .alchemy.env
```

1. **`CLOUDFLARE_API_TOKEN`** — mint it with the helper (interactive
   browser OAuth, one time):

   ```bash
   pnpm dlx alchemy util create-cloudflare-token
   ```

   ⚠️ **Do not** create this token from the Cloudflare dashboard's
   "Edit Cloudflare Workers" template — it's missing the D1 and R2-data
   scopes alchemy needs, and the deploy will fail halfway with
   `401 Authentication error`. The helper is the only supported path.

2. **`CLOUDFLARE_EMAIL`** — your Cloudflare login email.
3. **`ALCHEMY_STATE_TOKEN`** — `openssl rand -hex 32`. When the token is
   present, alchemy switches to a **remote state store** (encrypted with
   this value) so every CI run shares state. If you run several projects
   from this template on the same CF account, they **must all share this
   value**. Resources you already deployed manually are re-adopted by
   name (`adopt: true` everywhere), so the local→CI transition is safe.

### 5.3 Upload secrets to GitHub

```bash
gh auth login          # once
gh repo set-default    # once, pick your repo
pnpm sync:secrets
```

`sync:secrets` uploads your local env files as repository secrets
(missing files are skipped with a warning):

| Local file | GitHub secret | Used by |
|---|---|---|
| `.alchemy.env` | `ENV_ALCHEMY` | every deploy job |
| `apps/server/.dev.env` | `ENV_SERVER_DEV` | `dev` + every `pr-<N>` |
| `apps/web/.dev.env` | `ENV_WEB_DEV` | `dev` + every `pr-<N>` |
| `apps/server/.prod.env` | `ENV_SERVER_PROD` | `prod` |
| `apps/web/.prod.env` | `ENV_WEB_PROD` | `prod` |

Secrets are **snapshots**: whenever you edit an env file locally, run
`pnpm sync:secrets` again before pushing.

### 5.4 Turn it on

```bash
git push origin dev
gh run watch           # test → deploy(dev)
```

Then open a PR against `dev` and watch the bot comment preview URLs
within ~2 minutes. When you're ready for production:

```bash
git checkout main
git merge dev
git push origin main   # tests → deploys prod
```

That's the whole loop from here on: work on branches → PR previews →
merge to `dev` (auto dev deploy) → merge to `main` (auto prod deploy).

## 6 · When something breaks

| Symptom | Cause / fix |
|---|---|
| Deploy aborts: `stage "dev" requires env: BETTER_AUTH_SECRET, …` | You set `AUTH_MODE=open`/`admin-only` without the mail env — finish 4.1 (or remove `AUTH_MODE` to stay disabled), re-run — and `pnpm sync:secrets` if it happened in CI. |
| `401 Authentication error` on the first D1/R2 resource | Token minted from the dashboard template. Re-mint with `pnpm dlx alchemy util create-cloudflare-token`, update `.alchemy.env`, re-sync, re-push. |
| `computeWorkerDevDomain` fails on a fresh account | No workers.dev subdomain yet — deploy + delete a throwaway Worker once (see 4.4). |
| `gh secret set` → "no default repository" | `gh repo set-default`. |
| No login button on the deployed site | Deployed default is `disabled` — set `AUTH_MODE=open` + mail env (4.1). |
| Sign-in works locally but not on dev | Deployed stages send real email: is `EMAIL_FROM` a verified Resend domain? Is the recipient allowed (sandbox sender only delivers to yourself)? |
| CI deploy green but env change didn't apply | Secrets are snapshots — `pnpm sync:secrets` after every env edit. |

More in [deploy.md → Common issues](deploy.md#common-issues).

## 7 · Where to go next

| Topic | Doc |
|---|---|
| Configure auth modes, admin, API keys | [docs/auth.md](auth.md) |
| Every env var, and the sync rules | [docs/environment.md](environment.md) |
| Add API endpoints / DB tables | [docs/api-development.md](api-development.md), [docs/database-d1.md](database-d1.md) |
| Full deploy runbook (domains, www redirect, R2 keys) | [docs/deploy.md](deploy.md) |
| Agent onboarding index | [AGENTS.md](../AGENTS.md) |
