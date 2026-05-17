# Deploy

Runbook for deploying saasflare starter to Cloudflare via alchemy.

## Can this be auto-run?

Mostly. An agent (or you with a script) can drive every step **except A2**,
which needs three human-provided secrets:

| Step | Auto-runnable? | Why / why not |
|---|---|---|
| A1 preflight | ✅ | scripted checks |
| A2 fill `.alchemy.env` | ❌ | needs human to log in to CF (browser OAuth) and decide whether to reuse an existing `ALCHEMY_STATE_TOKEN` |
| A3 per-app `.env` | ❌ if domains/R2 desired | needs human choices |
| A4 sync secrets | ✅ | `pnpm sync:secrets` |
| A5 push | ✅ | `git push` |
| A6 verify | ✅ | curl + jq |
| A7 PR preview | ✅ | happens automatically on PR |
| A8 promote prod | ✅ except typed confirmation | requires literal `deploy prod` for safety |

So a `/deploy` agent should pause at A2/A3 to collect input, then drive
the rest end-to-end.

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
  `CLOUDFLARE_API_TOKEN` is in the env (it always is, since
  `.alchemy.env` is sourced).

## Env files

| File | Scope | Contents | Synced to GitHub as |
|---|---|---|---|
| `.alchemy.env` | root, all stages, both apps | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_EMAIL`, `ALCHEMY_STATE_TOKEN` | `ENV_ALCHEMY` |
| `apps/server/.local.env` | server, local stage | R2 keys for local testing | — (local-only) |
| `apps/web/.local.env`    | web, local stage    | future `NEXT_PUBLIC_*` for local | — (local-only) |
| `apps/server/.dev.env`   | server, dev + every `pr-<N>` | `WEB_DOMAIN`, `SERVER_DOMAIN`, R2 keys | `ENV_SERVER_DEV` |
| `apps/web/.dev.env`      | web, dev + every `pr-<N>`    | `WEB_DOMAIN`, `SERVER_DOMAIN`, `NEXT_PUBLIC_*` | `ENV_WEB_DEV` |
| `apps/server/.prod.env`  | server, prod | same as dev | `ENV_SERVER_PROD` |
| `apps/web/.prod.env`     | web, prod    | same as dev | `ENV_WEB_PROD` |

All files are gitignored. Examples: `.alchemy.env.example`,
`apps/{server,web}/.local.env.example`.

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
node -v              # >= 23.6 (project parses .ts directly via Node)
pnpm -v              # >= 9
gh auth status       # else: gh auth login
gh repo set-default  # else `gh secret set` fails
test -d node_modules || pnpm install
```

### A2. Create `.alchemy.env`

```bash
cp .alchemy.env.example .alchemy.env
# fill in the three values:
#   CLOUDFLARE_API_TOKEN — see "Getting the CF token" below
#   CLOUDFLARE_EMAIL     — your CF account email
#   ALCHEMY_STATE_TOKEN  — openssl rand -hex 32 (or reuse from another
#                          saasflare project on this CF account — MUST match)
```

#### Getting the CF token

Two ways. Pick whichever is more convenient.

**Option 1 — alchemy helper** (interactive, OAuth via browser):

```bash
pnpm dlx alchemy util create-cloudflare-token
```

If you have **multiple CF accounts** logged into alchemy, use the
`--profile` flag to pick one:

```bash
# One-time per account
pnpm dlx alchemy login -p saasflare      # opens browser, lets you pick the account
pnpm dlx alchemy login -p personal       # different account, different profile

# Then mint the token from the chosen profile
pnpm dlx alchemy util create-cloudflare-token -p saasflare
```

Profiles are stored under `~/.config/.alchemy/credentials/<profile>/`.
`pnpm dlx alchemy whoami -p <profile>` shows who's logged in there.

**Option 2 — CF dashboard** (manual, no profile juggling):

1. https://dash.cloudflare.com → make sure the right account is selected
2. Profile (top-right) → **API Tokens** → **Create Token**
3. Use the **Edit Cloudflare Workers** template (or replicate its scopes)
4. Copy the token into `.alchemy.env`

This bypasses alchemy's OAuth entirely — useful when you don't want to
log in via alchemy at all (e.g., a CI-only setup).

> **Note**: profile selection only matters for the **token generation**
> step. Once the token is in `.alchemy.env`, deploys read
> `CLOUDFLARE_API_TOKEN` from env directly and don't touch profile
> credentials — so you never need to pass `--profile` to `deploy:*`.

### A3. (Optional) Create per-app `.{stage}.env` files

Only if you need custom domains or R2. Skip otherwise — the apps deploy
fine with just `.alchemy.env`.

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

### A4. Sync to GitHub Secrets

```bash
pnpm sync:secrets
```

Uploads `.alchemy.env` (as `ENV_ALCHEMY`) and the four
`apps/{server,web}/.{dev,prod}.env` files (as `ENV_{SERVER,WEB}_{DEV,PROD}`).
Missing files are skipped with a warning.

### A5. Push and watch

```bash
git push origin dev
gh run watch
```

`deploy.yml` runs test → deploy dev → resolve URL → e2e.

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

Same as A1–A3. Make sure `.alchemy.env` exists.

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

## Common issues

- **`computeWorkerDevDomain` errors / wrong URL**: alchemy hits
  `GET /accounts/{id}/workers/subdomain`. New CF accounts don't have a
  workers.dev subdomain until the first Worker is deployed. Workaround:
  `pnpm dlx wrangler deploy --name throwaway` once to provision the
  subdomain, then `wrangler delete throwaway`.

- **`gh secret set` fails with "no default repository"**: run
  `gh repo set-default` once.

- **`pnpm run deploy:dev` says CF auth missing locally**: confirm
  `.alchemy.env` exists at the repo root and has all three keys filled
  in. The wrapper sources it but doesn't validate contents.

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

- **`ALCHEMY_STATE_TOKEN` rotation**: if lost or compromised, update
  `.alchemy.env` in **every** saasflare project on this CF account,
  re-sync secrets (`pnpm sync:secrets`), and redeploy each project
  (alchemy's `adopt: true` re-claims existing resources).
