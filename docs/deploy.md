# Deploy

Runbook for deploying saasflare starter to Cloudflare via alchemy.

## Can this be auto-run?

Mostly. An agent (or you with a script) can drive every step **except A2**,
which needs two human-provided secrets:

| Step | Auto-runnable? | Why / why not |
|---|---|---|
| A0 rename the fork | ✅ | edit one JSON block, but get it right before the first deploy |
| A1 preflight | ✅ | scripted checks |
| A2 fill `.alchemy.env` | ❌ | CF token **must** be minted via `pnpm dlx alchemy util create-cloudflare-token` (interactive browser OAuth). The dashboard "Edit Cloudflare Workers" template lacks D1, R2 Data, and other scopes alchemy needs — using it will fail at the first D1/R2 resource. Agent cannot drive the OAuth flow, so the user runs the helper and pastes the token back. |
| A3 per-app `.env` | ⚠️ partly | the files themselves are **mandatory** (a deploy dies without them) and can be created empty; filling in domains/R2/auth needs human choices |
| A4 sync secrets | ✅ | `pnpm sync:secrets` |
| A5 push | ✅ | `git push` |
| A6 verify | ✅ | curl + jq |
| A7 PR preview | ✅ | happens automatically on PR |
| A8 promote prod | ✅ except typed confirmation | requires literal `deploy prod` for safety |

So an agent should pause at A2 / A3 / A8 to collect input, then drive
the rest end-to-end. Pause points are marked inline with
**🛑 AGENT PAUSE** blocks — ask the questions in those blocks using the
user's language and plain words (no jargon), then continue.

## Mental model

- **Two Workers**: `server` (Hono backend, port 4000 locally) and `web`
  (TanStack Start frontend, port 3000 locally), each provisioned by its
  own `apps/{server,web}/alchemy.run.ts`.
- **Stages** (`app.stage`):
  - `local` — `pnpm dev` (alchemy dev). Local state in `.alchemy/`.
  - `dev` — auto-deploys on push to `dev` branch.
  - `prod` — auto-deploys on push to `main`.
  - `pr-<N>` — auto-created on PR open, destroyed on PR close. Always uses
    `*.workers.dev` URLs (custom domain env vars are ignored for pr-*).
- **Split env**: control plane (`.alchemy.env` at root, shared by all
  stages and both apps) + per-app/per-stage extras
  (`apps/{server,web}/.{stage}.env`). The root-level `pnpm run deploy:*`
  scripts wrap deploys with `scripts/deploy.sh`, which auto-sources
  `.alchemy.env` so child alchemy processes inherit the control-plane
  env. Per-app `--env-file .{stage}.env` adds domain + R2 keys on top.
- **State store**: alchemy uses `CloudflareStateStore` (remote KV) when
  `CLOUDFLARE_API_TOKEN` is in the env — i.e. whenever `.alchemy.env`
  exists, since `scripts/deploy.sh` sources it. Without the file (Path B
  after `alchemy login`), state stays in a local `.alchemy/` directory
  instead. Resources are `adopt: true`, so a stage deployed both ways
  re-adopts by name rather than duplicating — but the two paths track
  state separately.

## Env files

Two layers, never mixed:

```text
.alchemy.env                                    control plane, repo root
apps/{server,web}/.local.env / .dev.env / .prod.env   per-app Worker config
```

Each app runs its own alchemy process with its own `--env-file`, and
nothing is shared between the two runs. A value both apps need —
`WEB_DOMAIN` and `SERVER_DOMAIN` — must be written into both files.
Control-plane credentials live at the root because `scripts/deploy.sh`
sources that file into the shell, where every child process inherits it.

| File | Scope | Contents | Synced to GitHub as |
|---|---|---|---|
| `.alchemy.env` | root, all stages, both apps | `CLOUDFLARE_API_TOKEN`, `ALCHEMY_STATE_TOKEN` | `ENV_ALCHEMY` |
| `apps/server/.local.env` | server, local stage | R2 keys for local testing | — (local-only) |
| `apps/web/.local.env`    | web, local stage    | future `NEXT_PUBLIC_*` for local | — (local-only) |
| `apps/server/.dev.env`   | server, dev + every `pr-<N>` | `WEB_DOMAIN`, `SERVER_DOMAIN`, auth, R2 keys | `ENV_SERVER_DEV` |
| `apps/web/.dev.env`      | web, dev + every `pr-<N>`    | `WEB_DOMAIN`, `SERVER_DOMAIN` | `ENV_WEB_DEV` |
| `apps/server/.prod.env`  | server, prod | same as dev | `ENV_SERVER_PROD` |
| `apps/web/.prod.env`     | web, prod    | same as dev | `ENV_WEB_PROD` |

All files are gitignored; only `*.example` is committed. What each
variable does, and how to generate a value, lives in the example files —
they are the source of truth:

- `.alchemy.env.example`
- `apps/server/.local.env.example`
- `apps/web/.local.env.example`

> **🛑 A missing `--env-file` target is fatal.** The process dies with a
> non-zero exit rather than falling back, and every `dev` / `deploy:*` script passes
> `--env-file` unconditionally. So `pnpm dev` needs both `.local.env`
> files, `deploy:dev` needs both `.dev.env` files, and `deploy:prod`
> needs both `.prod.env` files — **even when you have nothing to put in
> them.** Empty files are enough. (`destroy:dev` / `destroy:prod` are the
> exception: they pass no `--env-file` at all, so a destroy re-runs
> `alchemy.run.ts` without the domains or auth mode and resolves
> different URLs than the deploy did.)

## Deploy flows

| Path | When | What runs the deploy |
|---|---|---|
| **A. CI-first** | Fresh clone, normal day-to-day | GitHub Actions on push |
| **B. Local** | Debugging deploy issues | Your machine |

**Default to Path A** — CI always has the right env, no state divergence.

---

## Path A — CI-first

### A0. Rename the fork (do this before the first deploy)

Every Cloudflare resource is named `${projectName}-{kind}-${stage}`, from
the `saasflare` block in the root `package.json`:

```json
"saasflare": {
  "projectName": "my-app",       // Worker/D1/KV resource names
  "displayName": "My App",       // <title>, console/login headings
  "appId": "my-app",             // <html data-app> and the E2E guard
  "apiKeyPrefix": "myapp_"       // better-auth key prefix
}
```

> **🛑 Deploying under a name another project already uses on the same
> Cloudflare account adopts and overwrites its Workers and database** —
> every resource is declared `adopt: true`. `projectName` is validated
> (`^[a-z][a-z0-9-]*$`) and throws on a bad format, but it cannot tell
> that a *valid* name is already someone else's. Leaving it as `starter`
> and deploying is the easiest way to clobber a sibling project.

Full field-by-field breakdown: [docs/quickstart.md](quickstart.md).

### A1. Preflight

```bash
node -v              # >= 23.6 (project parses .ts directly via Node)
pnpm -v              # >= 9
gh auth status       # else: gh auth login
gh repo set-default  # else `gh secret set` fails
test -d node_modules || pnpm install
```

### A2. Create `.alchemy.env`

```bash
cp .alchemy.env.example .alchemy.env
# fill in the two values:
#   CLOUDFLARE_API_TOKEN — see "Getting the CF token" below
#   ALCHEMY_STATE_TOKEN  — openssl rand -hex 32 (or reuse from another
#                          saasflare project on this CF account — MUST match)
```

> **🛑 AGENT PAUSE — the CF token step is interactive (browser OAuth), so
> the agent cannot run it. Tell the user to do it themselves, then collect
> the two values:**
>
> 1. **CF token.** Say: *"The Cloudflare token step needs a browser login,
>    so I can't run it for you. Please run this in your terminal:*
>
>    ```bash
>    pnpm dlx alchemy util create-cloudflare-token
>    ```
>
>    *It opens a browser, you log in, and it prints a token. Paste the
>    token back here."*
>
>    **Do not** offer the dashboard "Edit Cloudflare Workers" template as
>    a fallback — it omits D1, Workers R2 Data, and other scopes alchemy
>    needs, and the deploy will fail at the first D1/R2 resource with
>    `401 Authentication error`. The helper mints a token with the full
>    scope set; insist on it.
>    Wait for the token before continuing.
> 2. **State token.** Ask: *"Is this your first saasflare project on this
>    Cloudflare account? If you have other saasflare projects on the same
>    account, paste their `ALCHEMY_STATE_TOKEN` here — it must match. If
>    this is the first one, just say 'first' and I'll generate one for
>    you with `openssl rand -hex 32`."*
>
> Then write both into `.alchemy.env` and move on. If the user mentions
> having more than one Cloudflare account, also ask for the Account ID
> and set `CLOUDFLARE_ACCOUNT_ID` — see below.

#### Getting the CF token

**Always use the alchemy helper.** Do not mint the token from the
dashboard — see the warning below.

```bash
pnpm dlx alchemy util create-cloudflare-token
```

Interactive OAuth: opens a browser, you log in, it prints a token. The
helper requests the full scope set alchemy needs (Workers Scripts, KV,
**D1**, R2, **Workers R2 Data**, Account Settings, DNS, Workers Routes,
User Details, Memberships).

If you have **multiple CF accounts** logged into alchemy, use the
`--profile` flag to pick one. A profile needs two steps: `configure`
creates it and picks the auth method, `login` then runs the OAuth flow.
Skipping `configure` gives `cloudflare is not configured on profile
"<name>"`.

```bash
# One-time per account
pnpm dlx alchemy configure -p saasflare  # creates profile, pick "Cloudflare" → "OAuth"
pnpm dlx alchemy login -p saasflare      # opens browser, log into the right CF account

pnpm dlx alchemy configure -p personal   # repeat for any other account
pnpm dlx alchemy login -p personal

# Then mint the token from the chosen profile
pnpm dlx alchemy util create-cloudflare-token -p saasflare
```

Profiles live in `~/.alchemy/config.json`, with their credentials under
`~/.alchemy/credentials/<profile>/`. `pnpm dlx alchemy whoami -p <profile>`
shows who's logged in there.

> **🛑 If a deploy lands in the wrong account, the profile is not your
> fix.** When credentials can see several accounts, alchemy lists them,
> **uses the first one**, and only prints a warning. Set
> `CLOUDFLARE_ACCOUNT_ID` in `.alchemy.env` to skip that guess entirely
> (dashboard → any domain → Overview → Account ID). Profiles only affect
> which account you mint the *token* from — see the note below.

> **Why not the dashboard "Edit Cloudflare Workers" template?** It looks
> close but omits D1, Workers R2 Data, and a few other scopes alchemy
> uses. KV creation will succeed, then the deploy fails on the first D1
> binding with `CloudflareApiError: 401 Authentication error`. The
> helper is the only supported path.

> **Note**: profile selection only matters for the **token generation**
> step. Once the token is in `.alchemy.env`, deploys read
> `CLOUDFLARE_API_TOKEN` from env directly and don't touch profile
> credentials — so you never need to pass `--profile` to `deploy:*`.

### A3. Create per-app `.{stage}.env` files

**The four files must exist before you deploy**, even if every one of
them is empty — `deploy:dev` / `deploy:prod` pass `--env-file`
unconditionally and the process dies on a missing target:

```bash
touch apps/server/.dev.env apps/web/.dev.env
touch apps/server/.prod.env apps/web/.prod.env
```

Everything below is what you optionally put *inside* them.

**Auth is opt-in on deployed stages** — unset `AUTH_MODE` deploys with
auth disabled and needs zero env. Enabling sign-in requires all four
values below (the deploy fails closed otherwise); the canonical
matrix and mode semantics live in [docs/auth.md §1–2](auth.md):

```bash
cat >> apps/server/.dev.env <<'ENV'
AUTH_MODE=open
BETTER_AUTH_SECRET=<openssl rand -hex 32>
ADMIN_EMAILS=you@example.com
RESEND_API_KEY=re_...          # resend.com → API Keys
EMAIL_FROM=My App <auth@yourdomain.com>   # verified Resend sender
ENV
# Repeat for .prod.env with a DIFFERENT secret when promoting.
```

Domains and R2 remain optional — skip them and the apps deploy on
`*.workers.dev` URLs.

> **🛑 AGENT PAUSE — first settle auth, then ask two yes/no questions:**
>
> 0. *"Does this deployment need sign-in? If yes: which emails should be
>    administrators, and paste a Resend API key + verified sender (I'll
>    generate the signing secret). If it's a pure public site, I'll set
>    AUTH_MODE=disabled and skip all of that."*
>
> 1. *"Do you want to use your own domain (like `app.yourcompany.com`)?
>    If yes, the domain must already be managed by Cloudflare DNS, and
>    I'll need the exact web hostname and the API hostname (e.g.
>    `dev.yourcompany.com` and `api-dev.yourcompany.com`). If no, we'll
>    use the free `*.workers.dev` URLs and skip this."*
> 2. *"Do you need file storage (Cloudflare R2) for the server? If yes,
>    paste your R2 access key ID and secret access key. If no, skip."*
>
> If both answers are no → still create the four empty files above, then
> move on. Otherwise only write the keys the user actually provided into
> the matching `.dev.env` / `.prod.env` files.

```bash
# Custom domains (zone must be on Cloudflare DNS)
cat >> apps/server/.dev.env <<EOF
WEB_DOMAIN=dev.example.com
SERVER_DOMAIN=api-dev.example.com
EOF
cat >> apps/web/.dev.env <<EOF
WEB_DOMAIN=dev.example.com
SERVER_DOMAIN=api-dev.example.com
EOF

# R2 (server only)
cat >> apps/server/.dev.env <<EOF
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
EOF

# Same pattern for .prod.env when you're ready to deploy prod
```

(Domains need to live in both apps' files because each app's
`alchemy.run.ts` resolves the other side's URL independently.)

#### Adding `www` → apex (or any alias-to-canonical 301)

`alchemy.run.ts` only binds the canonical domain (`WEB_DOMAIN`). To make
`www.<your-apex>` also reach your site and 301 to the canonical, do this
**once in the Cloudflare dashboard** — not in code.

Why not IaC? alchemy has `DnsRecords` + `RedirectRule` resources that
could automate this, but they need two scopes that the
`pnpm dlx alchemy util create-cloudflare-token` helper does not request
by default:

- `Zone > DNS > Edit`
- `Zone > Single Redirect > Edit` (a.k.a. `Dynamic URL Redirects: Edit`)

Adding those scopes to the token is fine, but for a one-time setup the
dashboard route is faster and zero-config. The redirect rule template
described below is officially documented by Cloudflare — see
[Redirect www to domain apex](https://developers.cloudflare.com/pages/how-to/www-redirect/).

Prerequisite: prod is already deployed and `https://<your-apex>` returns
HTTP 200 (i.e. `WEB_DOMAIN=<your-apex>` is set and you've completed A5
or A8 once).

**Step 1 — Add a proxied DNS record for `www`**

1. Dashboard → your zone (e.g. `<your-apex>`) → **DNS → Records**
2. **Add record**

   | Field | Value |
   |---|---|
   | Type | `A` |
   | Name | `www` |
   | IPv4 address | `192.0.2.1` |
   | Proxy status | **Proxied** (orange cloud, required) |

   The IP is a documentation sentinel ([RFC 5737](https://www.rfc-editor.org/rfc/rfc5737)).
   Traffic never reaches it because step 2 intercepts the request at
   Cloudflare's edge before any origin lookup.

3. **Save**

**Step 2 — Create the Single Redirect rule from the official template**

1. Dashboard → your zone → **Rules → Overview** (URL pattern:
   `https://dash.cloudflare.com/<account_id>/<your-apex>/rules/overview`)
2. Find the **Redirect from WWW to root** template
3. **Create from template** — Cloudflare pre-fills:
   - **When incoming requests match** → Wildcard pattern → `https://www.*`
   - **Target URL** → `https://${1}`
   - **Status code** → `301`
   - **Preserve query string** → Enabled
4. **Deploy**

(The template's wildcard `https://www.*` matches `www.<anything>` within
the zone. Scoped to a single zone, this only ever fires for
`www.<your-apex>`. If you need a stricter match, switch to
`https://www.<your-apex>/*` → `https://<your-apex>/${1}`.)

**Verify**

```bash
curl -sI https://www.<your-apex>/some/path?q=1 | head -3
# Expect:
#   HTTP/2 301
#   location: https://<your-apex>/some/path?q=1
```

Single Redirects execute in the `http_request_dynamic_redirect` phase,
which runs **before** Workers — the redirected request never reaches
your Worker, so it doesn't count against Worker invocations.

#### Getting R2 keys

R2 needs an **Account API token** (S3-compatible key pair), *not* a User
API token. The two look similar in the dash but produce different
artifacts:

| | User API token | Account API token |
|---|---|---|
| Produces | Single bearer token | `Access Key ID` + `Secret Access Key` pair |
| Templates | "Edit Cloudflare Workers" etc. | R2 scopes only |
| Used for | Control-plane (the `CLOUDFLARE_API_TOKEN` we already minted) | S3 SDK access to R2 buckets |

Steps:

1. https://dash.cloudflare.com → **R2 Object Storage** (accept terms /
   add billing if first use; 10GB/month is free)
2. **Manage R2 API Tokens** → **Create Account API token**
3. Name: e.g. `saasflare-dev-r2`
4. Permissions: **Object Read & Write**
5. Optionally scope to specific bucket(s); leave TTL blank for no expiry
6. **Create Account API Token**
7. Copy `Access Key ID` and `Secret Access Key` — the Secret is shown
   **only once**, so capture it before closing the page

Paste the two values into `apps/server/.{stage}.env` as shown above.

### A4. Sync to GitHub Secrets

```bash
pnpm sync:secrets
```

Uploads `.alchemy.env` (as `ENV_ALCHEMY`) and the four
`apps/{server,web}/.{dev,prod}.env` files (as `ENV_{SERVER,WEB}_{DEV,PROD}`).
Missing files are skipped with a warning.

Those five are the only repository secrets the workflows read, apart from
the Actions-provided `GITHUB_TOKEN`. There is no standalone
`CLOUDFLARE_API_TOKEN` or `ALCHEMY_STATE_TOKEN` secret — they travel
inside `ENV_ALCHEMY`. CI writes each secret back to its original path
before deploying.

Secrets are snapshots: re-run `pnpm sync:secrets` after every local edit.

### A5. Push and watch

```bash
git push origin dev
gh run watch
```

`deploy.yml` runs test → deploy. (There is no e2e job — Playwright
installs kept hanging in Actions. Run `pnpm --filter web test:e2e`
locally against a deployed URL instead.)

The preview workflow additionally injects `PR_STAGE` (`pr-<number>`),
which the `deploy:pr` script consumes through shell expansion — so a
`process.env` grep will not find it.

### A6. Verify

```bash
URLS=$(node \
  --env-file=.alchemy.env \
  --env-file=apps/server/.dev.env \
  scripts/resolve-urls.ts --stage dev)
echo "$URLS" | jq

SERVER=$(echo "$URLS" | jq -r .server)
WEB=$(echo "$URLS" | jq -r .web)
curl -fsS "$SERVER/health"     # → {"status":"ok"}
curl -fsSI "$WEB" | head -1    # → HTTP/2 200
```

### A7. PR previews

Already enabled by `.github/workflows/preview.yml`. Open a PR against
`dev` and within ~2 min the bot posts preview URLs as a PR comment.
Each PR gets isolated stage `pr-<N>` with its own KV/D1/R2/Workers.

### A8. Promoting to prod

> **🛑 AGENT PAUSE — require a typed confirmation:**
>
> Ask: *"Ready to promote to production. This deploys to the **real**
> prod stage on the `main` branch and will be visible to users. To
> confirm, type exactly `deploy prod`. Anything else cancels."*
>
> Only run the commands below if the user typed literally `deploy prod`.

```bash
git checkout main
git merge dev
git push origin main
```

Make sure `apps/{server,web}/.prod.env` exist locally (if you have prod
domains or R2 keys) and you've run `pnpm sync:secrets`.

---

## Path B — Local deploy

For debugging when CI is broken or you're iterating on `alchemy.run.ts`.

### B1. Preflight + env files

Same as A1–A3 — except `.alchemy.env` is optional locally: if you've run
`pnpm dlx alchemy login` (browser OAuth), deploys use those credentials
and keep state in `.alchemy/`. The env file (and its remote state store)
is only mandatory for CI, which has no browser.

### B2. Deploy

```bash
pnpm run deploy:dev    # or deploy:prod (after typed `deploy prod` confirmation)
```

`scripts/deploy.sh` auto-sources `.alchemy.env` before invoking pnpm,
so the alchemy child processes inherit `CLOUDFLARE_API_TOKEN` etc.
Each app additionally loads its `.{stage}.env` via alchemy's
`--env-file` flag (which forwards to Node's `--env-file`).

No `source` step required.

### B3. Verify

Same as A6.

---

## Derived bindings — never set these by hand

Computed in `alchemy.run.ts`. Putting them in an env file does nothing.

| Binding | Value |
|---|---|
| `CORS_ORIGIN` | `localhost:3000`–`:3009` locally, else `WEB_DOMAIN` or workers.dev |
| `SERVER_URL` | The server's own public URL; better-auth uses it as `baseURL` |
| `R2_PUBLIC_DOMAIN` | `BUCKET.devDomain` |
| `R2_ACCOUNT_ID` | Fetched at deploy time via `AccountId()` |
| `R2_BUCKET_NAME` | `${app.name}-bucket-${app.stage}` |
| `BUCKET` / `KV` / `DB` | Resource bindings created by alchemy |
| `NEXT_PUBLIC_SERVER_URL` | Web only. **Assigned unconditionally on every stage** — a value set in an env file is silently discarded |

Binding *types* need no maintenance: `apps/server/env.d.ts` is generated
from `typeof server.Env`. What the type system cannot express is which
bindings are derived, hence this table.

## Adding a new env var

1. Add the binding in the relevant `apps/*/alchemy.run.ts`:
   ```ts
   bindings: {
     ...,
     MY_VAR: process.env.MY_VAR || '',
   }
   ```
2. Add it to your `.local.env`, `.dev.env`, and `.prod.env`.
3. Document it in `apps/<app>/.local.env.example` — that file is the
   source of truth, not this document.
4. `pnpm sync:secrets`, then push.
5. Restart `pnpm dev` so `env.d.ts` regenerates.

Client-bundle variables follow different rules — see the `NEXT_PUBLIC_`
section of `apps/web/.local.env.example`.

---

## Common issues

- **Deploy aborts with `stage "<stage>" requires env: BETTER_AUTH_SECRET,
  RESEND_API_KEY, EMAIL_FROM, ADMIN_EMAILS`**: you set
  `AUTH_MODE=open`/`admin-only` without the rest of the auth env (A3).
  Fill `apps/server/.{stage}.env`, or drop `AUTH_MODE` to stay disabled;
  re-run `pnpm sync:secrets` if deploying via CI.

- **`computeWorkerDevDomain` errors / wrong URL**: alchemy hits
  `GET /accounts/{id}/workers/subdomain`. New CF accounts don't have a
  workers.dev subdomain until the first Worker is deployed. Workaround:
  `pnpm dlx wrangler deploy --name throwaway` once to provision the
  subdomain, then `wrangler delete throwaway`.

- **`gh secret set` fails with "no default repository"**: run
  `gh repo set-default` once.

- **Deploy fails on D1 with `CloudflareApiError: 401 Authentication
  error`** (KV created fine, then 401 on the first D1 resource): the
  `CLOUDFLARE_API_TOKEN` was minted from the dashboard "Edit Cloudflare
  Workers" template instead of `pnpm dlx alchemy util
  create-cloudflare-token`. That template is missing D1 (and a few
  others). Re-mint with the helper, update `.alchemy.env`, re-run
  `pnpm sync:secrets`, and re-push.

- **`pnpm run deploy:dev` says CF auth missing locally**: confirm
  `.alchemy.env` exists at the repo root and has both keys filled in.
  The wrapper sources it but doesn't validate contents.

- **Custom domain stuck "pending"**: zone must be on Cloudflare DNS. If
  registered elsewhere, change nameservers at the registrar or transfer
  to CF.

- **`adopt: true` not adopting** (alchemy errors "resource already
  exists"): the existing resource name doesn't match
  `${PROJECT_NAME}-{kind}-${stage}`. Inspect with
  `pnpm dlx wrangler kv namespace list` / `wrangler d1 list`, rename or
  `alchemy destroy --stage <stage>` to start clean.

- **`pnpm sync:secrets` skips files**: by design — missing
  `.{stage}.env` files emit a warning, not an error. But the deploy
  itself does **not** tolerate them missing (see the callout in
  [Env files](#env-files)), so create them even if empty.

- **Deploy dies with `node: .dev.env: not found`** (exit 9, or exit 1
  with alchemy's own `Environment file ... does not exist`): `deploy:*`
  passes `--env-file` unconditionally. `touch` the four
  `apps/{server,web}/.{dev,prod}.env` files; empty is fine.

- **PR preview ignores my custom domain**: by design —
  `apps/{server,web}/alchemy.run.ts` checks `app.stage.startsWith('pr-')`
  and skips `WEB_DOMAIN` / `SERVER_DOMAIN` env vars for those stages, so
  each PR gets a clean isolated `*.workers.dev` URL.

- **`www.<your-apex>` returns HTTP 530** (or `ERR_SSL_PROTOCOL_ERROR`,
  or DNS not found): only `WEB_DOMAIN` is bound to the Worker. `www`
  isn't part of the IaC config — add it in the dashboard per
  [Adding `www` → apex](#adding-www--apex-or-any-alias-to-canonical-301)
  above.

- **`ALCHEMY_STATE_TOKEN` rotation**: if lost or compromised, update
  `.alchemy.env` in **every** saasflare project on this CF account,
  re-sync secrets (`pnpm sync:secrets`), and redeploy each project
  (alchemy's `adopt: true` re-claims existing resources).
