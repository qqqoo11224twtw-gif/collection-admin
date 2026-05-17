---
name: deploy
description: >-
  Deploy the saasflare starter app to Cloudflare Workers via alchemy. Handles
  first-time setup (CLOUDFLARE_API_TOKEN, ALCHEMY_STATE_TOKEN, GitHub Secrets,
  env files, custom domains) and routine deploys to dev/prod stages. Also sets
  up the GitHub Actions CI/CD pipeline (push-to-deploy + PR previews).

  Use whenever the user asks to deploy, ship, push to dev/prod, set up CI,
  configure deployment, configure Cloudflare, or asks "how do I deploy".
---

# Deploy

This skill walks through deploying the saasflare starter to Cloudflare. The app
runs as two independent Workers (`server` + `web`) provisioned by alchemy. Each
stage (`dev`, `prod`, `pr-<N>`) gets its own isolated KV, D1, R2, Workers.

## Mental model

- **Stages**: `dev` (auto-deployed from `dev` branch), `prod` (from `main`),
  `pr-<N>` (per PR, auto-created/destroyed by `.github/workflows/preview.yml`).
- **URLs are auto-resolved**: `apps/{server,web}/alchemy.run.ts` reads custom
  domains from `config.ts` (per-stage), or falls back to workers.dev via
  `computeWorkerDevDomain()`. Cross-app references (`CORS_ORIGIN`,
  `NEXT_PUBLIC_SERVER_URL`) are derived automatically — never ask the user to
  fill them in.
- **State**: alchemy writes per-stage state to a Cloudflare KV namespace
  encrypted with `ALCHEMY_STATE_TOKEN`. This token MUST be the same across all
  projects under the same CF account.

## Workflow

Follow this order. After each step that asks the user for input, wait for their
answer before continuing.

### 1. Preflight

Run in parallel:
- `node -v` → require v20+ (CI uses 24)
- `pnpm -v` → require v9+ (project pins via `packageManager`)
- `gh auth status` → if not logged in, ask user to run `gh auth login`
- `git remote get-url origin` → confirm it points to `saasflare-dev/<repo>`
- Check for `apps/server/.dev.env` / `apps/web/.dev.env` (later steps need this)

If `node_modules` missing: `pnpm install`.

### 2. Pick stage

Ask: "Deploy to which stage? (local / dev / prod)"

- `local` → just run `pnpm dev`. Skip rest of this skill.
- `dev` → continue. This is the common case.
- `prod` → continue, but require typed confirmation in step 6 (`"deploy prod"`).

PR previews are NOT deployed manually — they happen automatically via the
`preview.yml` workflow when a PR is opened. If the user wants to deploy a PR
preview locally for testing, set `PR_STAGE=pr-test` and run `pnpm run deploy:pr`.

### 3. First-time setup (skip if already done)

Detect: if any of these GitHub Secrets is missing, this is a first-time setup.

Check via `gh secret list`:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_EMAIL`
- `ALCHEMY_STATE_TOKEN`
- `ENV_SERVER_DEV` / `ENV_WEB_DEV` (required for `dev` stage)
- `ENV_SERVER_PROD` / `ENV_WEB_PROD` (required for `prod` stage)

If missing, gather + set them:

**`CLOUDFLARE_API_TOKEN`** — ask user to run `pnpm dlx alchemy util create-cloudflare-token` in their terminal (this is interactive — must be the user, not Claude). Then paste the token; pipe to `gh secret set CLOUDFLARE_API_TOKEN`.

**`CLOUDFLARE_EMAIL`** — ask user for their Cloudflare account email. Set via `gh secret set CLOUDFLARE_EMAIL --body "<email>"`.

**`ALCHEMY_STATE_TOKEN`** — ask user: "Is this your first saasflare project under this CF account?"
- Yes → generate: `openssl rand -hex 32` and set as secret.
- No → ask user to paste the existing token from another project (must match).

### 4. Configure domains (config.ts) + secrets (env files)

**Custom domains live in `config.ts` at the repo root.** This is non-secret deploy topology, checked into git. Ask the user one block at a time:

1. "Use custom domains for `<stage>`? (y/N)"
   - If y: ask for web domain (e.g., `app.example.com`) and server domain (e.g., `api.example.com`).
   - Both zones must already be hosted on Cloudflare DNS.
   - Edit `config.ts` → fill in `domains.{stage}.web` and `domains.{stage}.server`. Don't touch other stages.
   - If only one is provided, leave the other commented out — alchemy will fall back to workers.dev for that side.

2. "Enable R2 file uploads for `<stage>`? (y/N)"
   - If y: ask for `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (Cloudflare dashboard → R2 → Manage R2 API tokens → **Object Read & Write** scope).
   - Write to `apps/server/.{stage}.env` (R2 keys are secrets, NOT in config.ts).

After env files exist, sync to GitHub Secrets:

```bash
pnpm sync:secrets        # uploads .{stage}.env files as ENV_{SERVER|WEB}_{STAGE} secrets
```

(If neither app has app-specific keys for this stage, the env files can be empty — the secrets just won't exist, and CI's `echo "${{ secrets.ENV_SERVER_DEV }}"` writes an empty file, which is fine.)

### 5. Verify alchemy can authenticate

Run `pnpm dlx alchemy --version` to confirm the CLI is installed.

Verify CF access by computing a URL (cheap, read-only API call):
```bash
node -e "
import('alchemy/cloudflare').then(async ({ createCloudflareApi, computeWorkerDevDomain }) => {
  const api = await createCloudflareApi();
  const url = await computeWorkerDevDomain(api, 'starter-web-${STAGE}');
  console.log('CF auth OK. Web will deploy to:', url);
});
" --input-type=module
```

If this fails, the most common cause is missing/wrong `CLOUDFLARE_API_TOKEN` env var locally. Source the env file: `export $(cat apps/server/.{stage}.env | xargs)` and retry.

### 6. Deploy

For **dev**: run directly.
```bash
pnpm run deploy:dev
```

For **prod**: ask the user to type `deploy prod` literally. Only proceed if their reply is exactly that string. Then:
```bash
pnpm run deploy:prod
```

Watch stdout for `{ server: '<url>' }` and `{ web: '<url>' }` lines.

### 7. Post-deploy verification

Resolve URLs:
```bash
node scripts/resolve-urls.ts --stage <stage>
```

Smoke test:
```bash
curl -fsSI "$(node scripts/resolve-urls.ts --stage <stage> | jq -r .server)/health" | head -1
curl -fsSI "$(node scripts/resolve-urls.ts --stage <stage> | jq -r .web)" | head -1
```

Report URLs back to the user in a small table:

```
✅ Deployed to <stage>
  Web:    https://...
  Server: https://...
```

### 8. CI/CD (one-time)

After the first successful manual deploy:
- Push the `dev` branch → `.github/workflows/deploy.yml` auto-deploys
- Open a PR against `dev` → `.github/workflows/preview.yml` spins up a `pr-<N>` stage and comments URLs on the PR
- Merge to `main` → auto-deploys to prod

Confirm with the user that GitHub Actions is enabled in the repo settings.
If `Actions` is disabled (`gh api repos/{owner}/{repo} --jq .has_workflows` returns false or actions are turned off), tell the user to enable in Settings → Actions → General.

## Common issues

- **`computeWorkerDevDomain` returns wrong URL**: alchemy queries
  `/accounts/{id}/workers/subdomain`. Account must have at least one Worker
  deployed (subdomain auto-provisions on first deploy). For brand-new accounts,
  do a `wrangler deploy` of any throwaway worker first.
- **Custom domain stuck on "pending"**: alchemy creates a Worker custom domain
  binding, but DNS must be on Cloudflare. If domain is registered elsewhere,
  add an NS delegation or transfer to CF.
- **`adopt: true` not adopting**: an existing resource with a different name
  pattern. Inspect with `wrangler kv namespace list` / `wrangler d1 list`,
  rename to `${PROJECT_NAME}-{kind}-${stage}`, or `alchemy destroy --stage <stage>`
  to start clean.
- **CORS error after deploy**: `CORS_ORIGIN` is derived from `config.ts`
  domain entry for this stage, or workers.dev URL fallback. If the web URL
  changed (e.g., user added a custom domain mid-deploy), redeploy server.
- **`pnpm sync:secrets` fails on missing file**: that env file simply doesn't
  exist for the stage. Either create it or it's expected (e.g., no prod env
  yet) — sync skips missing files with a warning, not a fatal error.
