# Local dev ports

Starter's baseline is **web `:3000` / server `:4000`**. If you run several
projects cloned from this template side by side, give each one its own
hundreds-block so they do not collide: block `X` → **web `3X00`, server `4X00`**.

Changing the ports means touching **8 functional spots across 6 files**, plus
comments and docs. Miss one and the failure is usually silent or confusing
rather than a clean error — `pnpm test:e2e` hanging for 60s, or a test suite
that quietly runs against a *different* product's dev server.

## The 8 functional spots

Replace `3000` → `3X00` and `4000` → `4X00`.

| # | File | What | Breaks if missed |
|---|------|------|------------------|
| 1 | `apps/web/vite.config.ts` | `server.port` | Frontend serves on the old port |
| 2 | `apps/server/alchemy.run.ts` | `dev.port` | Backend serves on the old port |
| 3 | `apps/server/alchemy.run.ts` | `3000 + i` CORS allowlist base | Browser blocks every API call (CORS) |
| 4 | `apps/web/alchemy.run.ts` | `NEXT_PUBLIC_SERVER_URL` (local stage) | Frontend calls the wrong backend |
| 5 | `apps/web/playwright.config.ts` | `baseURL` fallback | E2E hits the wrong app |
| 6 | `apps/web/playwright.config.ts` | `webServer.url` | `pnpm test:e2e` waits 60s, then fails |
| 7 | `apps/web/e2e/global-setup.ts` | `targetUrl()` fallback | Guard probes the wrong app |
| 8 | `apps/web/e2e/auth-helpers.ts` | `SERVER_URL` | `signIn()` reads the login OTP from the **server**, not the web app — a stale port makes `auth.spec` and `api-keys.spec` fail on every sign-in |

Spot 3 builds a **10-port range** (`3X00`..`3X09`), not a single origin — Vite
shifts to the next free port when the base one is taken, and the backend has to
accept whichever one it landed on.

Spot 8 is the odd one: it is the only **server** port inside `apps/web`. The
browser sits on the web app, but the dev-only OTP endpoint lives on the server
Worker, and there is no vite proxy between them — so the helper has to name the
backend origin itself.

Spots 5–8 only take effect when `PLAYWRIGHT_BASE_URL` is **unset**, i.e. exactly
when you run e2e locally. **CI never runs e2e at all** (the job was removed), so
nothing anywhere will catch a stale value here. Verify by running
`pnpm test:e2e` yourself, never from a green CI badge.

## Also update (cosmetic, but misleading if stale)

- Header comments naming the ports: `apps/server/alchemy.run.ts`,
  `apps/web/alchemy.run.ts`, `apps/web/playwright.config.ts`
- `apps/web/e2e/global-setup.ts` — the abort message and its `lsof -nP -iTCP:3000` hint
- Docs: `README.md`, `AGENTS.md`, `docs/deploy.md`,
  `docs/debugging.md`, `docs/testing.md`

## Deliberately left at :3000

`apps/server/vitest.config.ts` sets `CORS_ORIGIN: 'http://localhost:3000'`. This
is an inert miniflare binding — the integration tests assert against
`example.com` origins and never read it. Leave it; `docs/testing.md` quotes the
file verbatim, so changing one without the other just creates drift.

## Verify

Run this **in the product repo after renumbering** — not in starter, where
`3000`/`4000` are the correct baseline and the grep matches everywhere:

```bash
grep -rn "localhost:3000\|localhost:4000\|port 3000\|port 4000" \
  --include="*.ts" --include="*.md" . | grep -v node_modules | grep -v .alchemy
```

The only expected hits are `apps/server/vitest.config.ts` and the
`docs/testing.md` line quoting it (see above). Anything else is a spot you missed.

Then actually run it — a grep can't catch a port that's right but unreachable:

```bash
pnpm dev          # web on :3X00, server on :4X00
pnpm test:e2e     # must start within seconds, not hang for 60
```

Renaming the product itself (the `saasflare` block in the root `package.json`)
is a separate task — see [quickstart.md](quickstart.md#make-it-yours-5-minutes-do-it-now).
