# Deploy

Runbook for deploying saasflare starter to Cloudflare via alchemy. Covers
first-time setup and routine deploys. Read this top-to-bottom on a fresh
clone; thereafter, jump to the section you need.

## Mental model

- **Two Workers**: `server` (Hono backend, port 4000 locally) and `web`
  (TanStack Start frontend, port 3000 locally). Each is independently
  deployed by its own `alchemy.run.ts`.
- **Stages** (`app.stage`):
  - `local` — `pnpm dev` (alchemy dev with `--stage local`). Uses local
    state in `.alchemy/`.
  - `dev` — auto-deploys on push to `dev` branch.
  - `prod` — auto-deploys on push to `main`.
  - `pr-<N>` — auto-created on PR open, destroyed on PR close.
- **Topology in `config.ts`** (custom domains per stage), **secrets in env
  files** (R2 keys, etc.), **URLs auto-derived** in `alchemy.run.ts`.
- **Env file layout** — control-plane is flat (one CF account auths every
  stage); app secrets are per-stage (R2 keys differ between dev/prod):

  | File | Scope | Used by | Goes to GitHub as |
  |---|---|---|---|
  | `~/.saasflare/auth.env` | machine-wide, all saasflare projects | Path B local + every CI job (CF auth + state token) | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_EMAIL`, `ALCHEMY_STATE_TOKEN` |
  | `apps/{server,web}/.local.env` | this repo | `pnpm dev` only | — (local-only) |
  | `apps/{server,web}/.dev.env` | this repo | `dev` stage + every `pr-<N>` preview | `ENV_{SERVER,WEB}_DEV` |
  | `apps/{server,web}/.prod.env` | this repo | `prod` stage | `ENV_{SERVER,WEB}_PROD` |

  PR previews reuse dev's app secrets so you don't have to mint new
  tokens per PR. Each PR still gets its own isolated KV / D1 / R2
  bucket (named by stage), so data is sandboxed.
- **State store**: alchemy uses `CloudflareStateStore` (remote KV) **only
  when `CLOUDFLARE_API_TOKEN` is in the env**. Without it, state stays
  local in `.alchemy/`. This means **local-only deploys and CI deploys can
  diverge** — see [State store gotcha](#state-store-gotcha) below.

## Picking a path

Two flows, pick based on the situation:

| Path | When | What runs the deploy |
|---|---|---|
| **A. CI-first** | Fresh clone, first deploy, normal workflow | GitHub Actions |
| **B. Local** | Debugging deploy failures, iterating on `alchemy.run.ts` | Your machine |

**Default to Path A.** It avoids local-vs-remote state divergence and is
how the team will deploy day-to-day. Use Path B only when you need to
inspect what alchemy is doing.

## Detecting first-time deploy

There is no single reliable signal. Use multi-signal detection and ask
the user if ambiguous:

```bash
# Signal 1: GitHub Secrets configured?
gh secret list 2>/dev/null | grep -q '^CLOUDFLARE_API_TOKEN'

# Signal 2: local alchemy auth present?
test -f ~/.alchemy/auth.json || test -n "$CLOUDFLARE_API_TOKEN"

# Signal 3: local state exists?
test -d .alchemy && test -n "$(ls -A .alchemy 2>/dev/null)"
```

| GH secret | Local auth | Local state | Verdict |
|:-:|:-:|:-:|---|
| ✗ | ✗ | ✗ | **Truly first time** — full setup |
| ✓ | ✗ | ✗ | CI configured, nobody deployed locally — Path A push will deploy |
| ✓ | ✓ | ✓ | Already deployed — incremental, just `pnpm run deploy:dev` |
| ✓ | ✓ | ✗ | Ambiguous — ask user: "Has this project been deployed before (from any machine or CI)?" |
| any | any | any | Once you have local auth, run `pnpm dlx wrangler deployments list starter-server-dev 2>/dev/null` — non-empty = deployed |

---

## Path A — CI-first (recommended)

### A1. Preflight

```bash
node -v              # >= 20 (CI uses 24, project parses .ts directly so 23+ is safest)
pnpm -v              # >= 9
gh auth status       # else: gh auth login
gh repo set-default  # one-time, picks the current repo
git remote get-url origin   # should be saasflare-dev/<repo>.git
test -d node_modules || pnpm install
```

### A2. Configure GitHub Secrets

The three control-plane secrets live in a **machine-wide dotfile at
`~/.saasflare/auth.env`** — outside any repo, so every saasflare project
on this CF account shares the same file. This guarantees
`ALCHEMY_STATE_TOKEN` is identical across projects (it must be — it's
the encryption key for shared alchemy state) and avoids per-repo
duplication.

**One-time per machine** (skip if you already did this for another
saasflare project):

```bash
mkdir -p ~/.saasflare
cat > ~/.saasflare/auth.env <<EOF
CLOUDFLARE_API_TOKEN=$(pnpm dlx alchemy util create-cloudflare-token)
CLOUDFLARE_EMAIL=your-email@example.com
ALCHEMY_STATE_TOKEN=$(openssl rand -hex 32)
EOF
chmod 600 ~/.saasflare/auth.env
```

**Per-repo** (run from inside this repo):

```bash
gh secret set -f ~/.saasflare/auth.env    # uploads all three to this repo's GH Secrets
```

Notes:
- Reusing an existing `ALCHEMY_STATE_TOKEN` from another project? Skip the
  `mkdir`/`cat` block — the file already exists. Just run the `gh secret set`.
- `~/.saasflare/auth.env` is the backup. Keep it safe (password manager
  copy, encrypted disk, etc.). GitHub Secrets can't be read back via API,
  so losing the file means regenerating `CLOUDFLARE_API_TOKEN` (easy) and
  rotating `ALCHEMY_STATE_TOKEN` across **all** projects + redeploy to
  re-adopt resources (painful — don't lose it).

Verify:
```bash
gh secret list             # should show all three
test -f ~/.saasflare/auth.env && echo "auth file ok"
```

### A3. (Optional) Custom domains in `config.ts`

Skip if you're fine with `*.workers.dev` URLs.

Otherwise, edit `config.ts`:
```ts
export const domains: Record<string, StageDomains> = {
  dev:  { web: 'dev.example.com', server: 'api-dev.example.com' },
  prod: { web: 'example.com',     server: 'api.example.com' },
};
```

**Constraint**: zones must already be on Cloudflare DNS. If domain is
registered elsewhere, add an NS delegation in your registrar first.

### A4. (Optional) Per-app secrets

Only if you need R2 file uploads (or have added other secret env vars
the workers consume at runtime). Create one file per stage you plan to
deploy — `.dev.env` covers both `dev` and PR previews; `.prod.env` is
prod-only.

```bash
# Create the file(s) with R2 keys (CF dashboard → R2 → Manage R2 API
# tokens → Object Read & Write scope). Same keys can go in both files,
# or you can isolate prod by minting separate ones.
cat > apps/server/.dev.env <<EOF
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
EOF

cat > apps/server/.prod.env <<EOF
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
EOF

# Upload all *.{dev,prod}.env files at once as ENV_{SERVER,WEB}_{DEV,PROD}
pnpm sync:secrets
```

Skip this step entirely if no R2. CI tolerates missing
`ENV_*_{DEV,PROD}` secrets — it just writes empty env files in the
runner, which is fine.

**Local dev** uses a separate `.local.env` per app (gitignored, never
uploaded to GitHub). Copy from `.local.env.example` if you want R2
locally:
```bash
cp apps/server/.local.env.example apps/server/.local.env
# edit in R2 keys
```

### A5. Push and watch

```bash
git push origin dev
gh run watch     # follow the latest Actions run live
```

The `deploy.yml` workflow runs: test → deploy dev → resolve URL → e2e.

### A6. Verify

```bash
# Get the deployed URL (uses CF API to compute the workers.dev URL or
# read from config.ts custom domain)
URLS=$(node scripts/resolve-urls.ts --stage dev)
echo "$URLS" | jq

# Smoke test
SERVER=$(echo "$URLS" | jq -r .server)
WEB=$(echo "$URLS" | jq -r .web)
curl -fsS "$SERVER/health"   # → {"status":"ok"}
curl -fsSI "$WEB" | head -1  # → HTTP/2 200
```

Report URLs to the user:
```
✅ Deployed to dev
  Web:    https://...
  Server: https://...
```

### A7. (Optional) Enable PR previews

Already enabled by `.github/workflows/preview.yml`. Verify Actions is
turned on:
```bash
gh api "repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)" --jq .has_issues
# (has_issues is a sanity check the repo metadata is reachable; Actions
# enablement is shown in the web UI — Settings → Actions → General)
```

Open a PR against `dev`. Within ~2min the preview-bot should comment
preview URLs.

### A8. Promoting to prod

Before the first prod deploy, make sure `apps/{server,web}/.prod.env`
exist locally (even if empty — `pnpm sync:secrets` skips missing files
and CI writes an empty file from an empty secret, which is fine for the
no-R2 case). See A4 for the prod variants.

```bash
# Same Path A flow but on main branch
git checkout main
git merge dev
git push origin main
```

---

## Path B — Local deploy

### B1. Preflight

Same as A1.

### B2. Authenticate alchemy locally

```bash
set -a; source ~/.saasflare/auth.env; set +a
# exports CLOUDFLARE_API_TOKEN, CLOUDFLARE_EMAIL, ALCHEMY_STATE_TOKEN
# from the machine-wide auth file (A2) into your shell
```

This matches CI's state store (remote KV) — see
[State store gotcha](#state-store-gotcha).

**Alternative** (OAuth, uses local file state — diverges from CI, not
recommended unless you only deploy locally):

```bash
pnpm dlx alchemy login    # OAuth flow, opens browser, writes ~/.alchemy/auth.json
pnpm dlx alchemy whoami   # should print your CF account
```

### B3. (Optional) config.ts + per-app secrets

Same as A3 / A4 (you don't need to sync to GitHub if you only deploy
locally — env files stay local).

### B4. Deploy

```bash
pnpm run deploy:dev
```

Watch stdout for `{ server: '<url>' }` and `{ web: '<url>' }`.

For **prod**: require the user to type literally `deploy prod` before
proceeding. Only then:
```bash
pnpm run deploy:prod
```

### B5. Verify

Same as A6.

---

## State store gotcha

`apps/{server,web}/alchemy.run.ts` checks `process.env.CLOUDFLARE_API_TOKEN`:
- **set** → uses `CloudflareStateStore` (state lives in a CF KV namespace, encrypted with `ALCHEMY_STATE_TOKEN`).
- **unset** → state lives in local `.alchemy/` directory.

This means:
- `alchemy login` alone → **local state** (file-based).
- `export CLOUDFLARE_API_TOKEN=...` → **remote state** (KV-based).
- CI always sets the env → **remote state**.

**Risk**: if you do your first deploy via `alchemy login` (local state),
then push to dev (CI remote state), CI sees no prior state and tries to
create resources from scratch. Because `adopt: true` is set on every
resource, CI will silently re-adopt them — but you end up with state in
two places, and any future `alchemy destroy --stage dev` may miss
resources tracked in the other store.

**Recommendation**: from day one, source `~/.saasflare/auth.env` (from
A2) before any `pnpm run deploy:*`, so local and CI share the same
remote state store:

```bash
set -a; source ~/.saasflare/auth.env; set +a
pnpm run deploy:dev
```

Same file, two consumers: `gh secret set -f ~/.saasflare/auth.env` for
CI, `source` for local. (GitHub Secrets can't be read back via API —
that's why the auth file stays on your machine.)

Or, accept the divergence and **only deploy via CI** after the first
local experiment.

---

## Common issues

- **`computeWorkerDevDomain` errors / wrong URL**: alchemy hits
  `GET /accounts/{id}/workers/subdomain`. New CF accounts don't have a
  workers.dev subdomain until the first Worker is deployed. Workaround:
  `pnpm dlx wrangler deploy --name throwaway` once to provision the
  subdomain, then `wrangler delete throwaway`.

- **`gh secret set` fails with "no default repository"**: run
  `gh repo set-default` once.

- **Custom domain stuck "pending"**: zone must be on Cloudflare DNS. If
  registered elsewhere, change nameservers at the registrar or transfer
  to CF.

- **`adopt: true` not adopting** (alchemy says "resource already exists"
  loudly instead of silently adopting): the existing resource name
  doesn't match `${PROJECT_NAME}-{kind}-${stage}`. Inspect with
  `pnpm dlx wrangler kv namespace list` / `wrangler d1 list`, rename or
  `alchemy destroy --stage <stage>` to start clean.

- **CORS error after deploy**: `CORS_ORIGIN` is computed in
  `apps/server/alchemy.run.ts` from `config.ts` domains or the
  workers.dev URL fallback. If web URL changed (added custom domain mid-
  deploy), redeploy server so it picks up the new value.

- **PR preview empty `.dev.env`**: by design — PR previews use the same
  `ENV_SERVER_DEV` / `ENV_WEB_DEV` secrets as dev stage. If you have no
  R2 / no app secrets for dev, those secrets don't exist, and CI writes
  an empty file. Alchemy reads it as "no extra vars". Not an error.

- **`pnpm sync:secrets` skips files**: by design — missing `.{stage}.env`
  files emit a warning, not an error. Create the file if you wanted it
  synced.
