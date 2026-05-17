# Deploy

Runbook for deploying saasflare starter to Cloudflare via alchemy.

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
- **Single source of truth per stage**: each app's `.{stage}.env` file
  holds **everything** that stage needs — Cloudflare auth tokens, alchemy
  state token, optional custom domains, optional R2 keys. No separate
  config file, no machine-wide dotfile.
- **State store**: alchemy uses `CloudflareStateStore` (remote KV) when
  `CLOUDFLARE_API_TOKEN` is present in the env (it always is, via the
  app's `.{stage}.env` file). Without it, state stays local in `.alchemy/`.

## Env files

| File | Loaded for | Synced to GitHub as |
|---|---|---|
| `apps/server/.local.env` | `pnpm dev` (server) | — (local-only) |
| `apps/web/.local.env`    | `pnpm dev` (web)    | — (local-only) |
| `apps/server/.dev.env`   | `dev` + every `pr-<N>` | `ENV_SERVER_DEV` |
| `apps/web/.dev.env`      | `dev` + every `pr-<N>` | `ENV_WEB_DEV`    |
| `apps/server/.prod.env`  | `prod` | `ENV_SERVER_PROD` |
| `apps/web/.prod.env`     | `prod` | `ENV_WEB_PROD`    |

Each stage env file can contain:

```bash
# Control plane (required for any non-local deploy)
CLOUDFLARE_API_TOKEN=...        # pnpm dlx alchemy util create-cloudflare-token
CLOUDFLARE_EMAIL=...            # your CF account email
ALCHEMY_STATE_TOKEN=...         # openssl rand -hex 32 — MUST match across
                                # all saasflare projects on this CF account

# Custom domains (optional; only honored for dev/prod, ignored for pr-*)
WEB_DOMAIN=app.example.com      # zone must be on Cloudflare DNS
SERVER_DOMAIN=api.example.com

# R2 storage (server only, optional)
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
```

Both `apps/server/.{stage}.env` and `apps/web/.{stage}.env` need the
control-plane vars (each app's `alchemy.run.ts` calls Cloudflare's API
to resolve URLs). Same values, just copied — the duplication is the
trade-off for "all secrets live next to the app that uses them".

## Deploy flows

| Path | When | What runs the deploy |
|---|---|---|
| **A. CI-first** | Fresh clone, normal day-to-day | GitHub Actions on push |
| **B. Local** | Debugging deploy issues | Your machine |

**Default to Path A** — CI always has the right env, no state divergence.

---

## Path A — CI-first

### A1. Preflight

```bash
node -v              # >= 23.6 (project parses .ts directly via Node --experimental-strip-types)
pnpm -v              # >= 9
gh auth status       # else: gh auth login
gh repo set-default  # else gh secret set fails
test -d node_modules || pnpm install
```

### A2. Create env files

For each stage you want to deploy (`dev`, then later `prod`), create
both apps' env files with at least the control-plane vars:

```bash
# Generate once, paste into all four files (or use the helper below)
CF_TOKEN=$(pnpm dlx alchemy util create-cloudflare-token)
CF_EMAIL="your-email@example.com"
ALCHEMY_TOKEN=$(openssl rand -hex 32)   # or paste from another saasflare project

# Helper: write the same control-plane block to all four files
for f in apps/server/.dev.env apps/web/.dev.env \
         apps/server/.prod.env apps/web/.prod.env; do
  cat > "$f" <<EOF
CLOUDFLARE_API_TOKEN=$CF_TOKEN
CLOUDFLARE_EMAIL=$CF_EMAIL
ALCHEMY_STATE_TOKEN=$ALCHEMY_TOKEN
EOF
done
```

Then add per-stage extras to the relevant file(s):

```bash
# Custom domains for dev (optional)
cat >> apps/server/.dev.env <<EOF
WEB_DOMAIN=dev.example.com
SERVER_DOMAIN=api-dev.example.com
EOF
cat >> apps/web/.dev.env <<EOF
WEB_DOMAIN=dev.example.com
SERVER_DOMAIN=api-dev.example.com
EOF

# R2 keys for dev (optional, server only)
cat >> apps/server/.dev.env <<EOF
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
EOF
```

### A3. Sync to GitHub Secrets

```bash
pnpm sync:secrets
```

Uploads `apps/{server,web}/.{dev,prod}.env` as `ENV_{SERVER,WEB}_{DEV,PROD}`.
Missing files are skipped with a warning (e.g., if you haven't set up
prod yet).

### A4. Push and watch

```bash
git push origin dev
gh run watch
```

`deploy.yml` runs test → deploy dev → resolve URL → e2e.

### A5. Verify

```bash
URLS=$(node --env-file apps/server/.dev.env scripts/resolve-urls.ts --stage dev)
echo "$URLS" | jq

SERVER=$(echo "$URLS" | jq -r .server)
WEB=$(echo "$URLS" | jq -r .web)
curl -fsS "$SERVER/health"     # → {"status":"ok"}
curl -fsSI "$WEB" | head -1    # → HTTP/2 200
```

### A6. PR previews

Already enabled by `.github/workflows/preview.yml`. Open a PR against
`dev` and within ~2 min the bot posts preview URLs as a PR comment.
Each PR gets isolated stage `pr-<N>` with its own KV/D1/R2/Workers.

### A7. Promoting to prod

Same flow, different branch:

```bash
git checkout main
git merge dev
git push origin main
```

Make sure `apps/{server,web}/.prod.env` exists locally and you've run
`pnpm sync:secrets` so the prod GH secrets are populated.

---

## Path B — Local deploy

For debugging when CI is broken or you're iterating on `alchemy.run.ts`.

### B1. Preflight + env files

Same as A1 / A2. Make sure `apps/{server,web}/.dev.env` exists locally
with at least the control-plane vars.

### B2. Deploy

```bash
pnpm run deploy:dev    # alchemy --env-file injects everything into process.env
```

No `source`, no manual env export — alchemy CLI uses Node's `--env-file`
flag to load the env file before `alchemy.run.ts` runs. Custom domains
in `.dev.env` are honored; PR-stage env vars are ignored automatically
by `alchemy.run.ts` (`isPRStage` check).

For **prod**: require typed confirmation (`deploy prod`), then:

```bash
pnpm run deploy:prod
```

### B3. Verify

Same as A5.

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

- **`adopt: true` not adopting** (alchemy errors "resource already
  exists"): the existing resource name doesn't match
  `${PROJECT_NAME}-{kind}-${stage}`. Inspect with
  `pnpm dlx wrangler kv namespace list` / `wrangler d1 list`, rename or
  `alchemy destroy --stage <stage>` to start clean.

- **`pnpm sync:secrets` skips files**: by design — missing
  `.{stage}.env` files emit a warning, not an error. Create them if you
  want them synced.

- **PR preview ignores my custom domain**: by design —
  `apps/{server,web}/alchemy.run.ts` checks `app.stage.startsWith('pr-')`
  and skips `WEB_DOMAIN` / `SERVER_DOMAIN` env vars for those stages, so
  each PR gets a clean isolated `*.workers.dev` URL.

- **`ALCHEMY_STATE_TOKEN` rotation**: if lost or compromised, generate a
  new one, update all `.{stage}.env` files for **every** saasflare
  project on this CF account, re-sync secrets, and redeploy each
  project (alchemy's `adopt: true` re-claims existing resources).
