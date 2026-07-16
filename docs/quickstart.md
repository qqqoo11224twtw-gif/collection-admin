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
- **Four kinds of stages**, all from the same code:

  | Stage | Created by | Purpose |
  |---|---|---|
  | `local` | `pnpm dev` | Your machine (`localhost:3000` / `:4000`) |
  | `dev` | push to the `dev` branch | Shared development environment |
  | `pr-<N>` | opening a PR | Isolated preview per PR, auto-destroyed on close |
  | `prod` | push to `main` | Production |

- **Auth is on by default** (`AUTH_MODE=open`: anyone can sign up via
  email OTP, no passwords). This matters for deploys: an auth-enabled
  deployed stage **refuses to deploy** until you provide four env values
  (step 4.2) — deliberately fail-closed, so you can never ship a
  half-configured login.

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

You'll deploy the `dev` stage from your machine once. After step 5, CI
takes over and you never do this again (keep it for debugging).

### 4.1 Control-plane secrets → `.alchemy.env`

```bash
cp .alchemy.env.example .alchemy.env
```

Fill in the three values:

1. **`CLOUDFLARE_API_TOKEN`** — mint it with the helper (interactive
   browser OAuth):

   ```bash
   pnpm dlx alchemy util create-cloudflare-token
   ```

   ⚠️ **Do not** create this token from the Cloudflare dashboard's
   "Edit Cloudflare Workers" template — it's missing the D1 and R2-data
   scopes alchemy needs, and the deploy will fail halfway with
   `401 Authentication error`. The helper is the only supported path.

2. **`CLOUDFLARE_EMAIL`** — your Cloudflare login email.
3. **`ALCHEMY_STATE_TOKEN`** — `openssl rand -hex 32`. If you run
   several projects from this template on the same CF account, they
   **must all share this value** (it encrypts alchemy's remote state).

### 4.2 Auth env → `apps/server/.dev.env` (required)

Because `AUTH_MODE` defaults to `open`, a deployed stage requires real
auth config or the deploy aborts with
`stage "dev" requires env: …`. Create `apps/server/.dev.env`:

```bash
cat >> apps/server/.dev.env <<EOF
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
ADMIN_EMAILS=you@example.com
RESEND_API_KEY=re_xxxxxxxxx
EMAIL_FROM=My App <auth@yourdomain.com>
EOF
```

- `ADMIN_EMAILS` — comma-separated; these accounts get the admin role.
- `RESEND_API_KEY` — from [resend.com](https://resend.com) → API Keys.
- `EMAIL_FROM` — must be a **verified sender domain** in Resend
  (Domains → Add Domain, add the DNS records). While testing you can
  use Resend's sandbox sender `onboarding@resend.dev`, which only
  delivers to your own Resend account email.

**Building a public site with no login at all?** Skip Resend and put
`AUTH_MODE=disabled` in the env file instead — then none of the four
values are required. See [docs/auth.md](auth.md) for the full matrix
(`open` / `admin-only` / `disabled`).

### 4.3 (Optional) custom domains and R2

Skip on the first pass — you'll get free `*.workers.dev` URLs.
When you want `app.yourdomain.com` or file uploads, follow
[deploy.md A3](deploy.md#a3-optional-create-per-app-stageenv-files).

### 4.4 Deploy and verify

```bash
pnpm run deploy:dev
```

The script auto-sources `.alchemy.env`, provisions KV + D1 (with
migrations) + the two Workers, and prints their URLs. Verify:

```bash
URLS=$(node --env-file=.alchemy.env --env-file=apps/server/.dev.env \
  scripts/resolve-urls.ts --stage dev)
echo "$URLS" | jq
curl -fsS "$(echo "$URLS" | jq -r .server)/health"   # → {"status":"ok"}
```

Open the web URL, sign in with an `ADMIN_EMAILS` address — the code now
arrives by **real email**. (The local `/api/dev/otp` backdoor does not
exist on deployed stages; that's enforced, not a convention.)

> First deploy on a fresh CF account can fail resolving `*.workers.dev`
> — new accounts have no workers.dev subdomain until the first Worker
> exists. Fix: `pnpm dlx wrangler deploy --name throwaway`, then
> `wrangler delete throwaway`, and re-run the deploy.

## 5 · Multi-environment auto deploy (GitHub Actions)

The workflows are already in the template — you only feed them secrets.

**Pipeline** (`.github/workflows/deploy.yml` + `preview.yml`):

| Git event | What happens |
|---|---|
| Pull request | lint + typecheck + tests, **plus** an isolated `pr-<N>` stage with its own Workers/D1/KV — preview URLs posted as a PR comment, auto-destroyed on close |
| Push to `dev` | tests → deploy the `dev` stage |
| Push to `main` | tests → deploy the `prod` stage |

### 5.1 Prepare prod env

Same as 4.2 but for prod — **use a different secret**:

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

### 5.2 Upload secrets to GitHub

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

### 5.3 Turn it on

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
| Deploy aborts: `stage "dev" requires env: BETTER_AUTH_SECRET, …` | Step 4.2 skipped. Fill the auth env (or set `AUTH_MODE=disabled` for a no-login site), re-run — and `pnpm sync:secrets` if it happened in CI. |
| `401 Authentication error` on the first D1/R2 resource | Token minted from the dashboard template. Re-mint with `pnpm dlx alchemy util create-cloudflare-token`, update `.alchemy.env`, re-sync, re-push. |
| `computeWorkerDevDomain` fails on a fresh account | No workers.dev subdomain yet — deploy + delete a throwaway Worker once (see 4.4). |
| `gh secret set` → "no default repository" | `gh repo set-default`. |
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
