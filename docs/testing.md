# Testing Guide

What is non-obvious about testing in this scaffold. Commands live in
`package.json`; test patterns live in the test files themselves. This document
covers only what you would otherwise have to discover the hard way.

## Mental model

Two test types, no unit tests, **no mocks** — mocking Cloudflare bindings
diverges from the real runtime, so everything runs against miniflare instead.

| Type | Tool | Runs in | Covers |
|---|---|---|---|
| **Integration** | Vitest + `@cloudflare/vitest-pool-workers` | Real miniflare Worker runtime, in-process | Hono routes · oRPC procedures · D1/KV/R2 bindings |
| **E2E** | Playwright (Chromium) | Local dev server, or a deployed URL you point it at | User-visible flows worth a real browser |

Backend tests go in `apps/server/tests/`, frontend tests in `apps/web/e2e/`.
The other workspaces have none on purpose: `packages/api` handlers all need
Cloudflare bindings and are covered transitively by the server tests,
`packages/db` is schema only, `packages/ui` is vendored shadcn, `packages/config`
is tsconfig.

## Start from an existing test, not from a snippet

- Server: `apps/server/tests/server.test.ts`
- E2E: `apps/web/e2e/smoke.spec.ts`

Copy the nearest one. Snippets pasted into docs rot — this file used to carry a
sample asserting `'Hello nn stack server!'`, a product name that had been gone
for months.

## Server tests — the parts that surprise people

**oRPC wraps everything.** Inputs go over the wire as `{ json: input }` and
come back as `{ json: output }`, so SuperJSON and binary encodings stay
transparent. Asserting on the raw body gives you the wrapper, not your data.
`server.test.ts` has an `rpc()` helper that hides this and maps
`todos.createTodo` → `POST /rpc/todos/createTodo`; use it.

**`new Request()` needs an absolute URL** but Hono only routes on the path, so
tests use `http://localhost/...` as a placeholder. No HTTP server is started.

**D1 and KV come from `apps/server/vitest.config.ts`**, which declares the
miniflare bindings, and `tests/setup.ts`, which applies migrations before each
test file via `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`.

`TEST_MIGRATIONS` is the one binding worth understanding: the Worker sandbox has
no Node `fs`, so the `.sql` files from `packages/db/migrations/` cannot be read
at runtime. `vitest.config.ts` loads them into a binding instead. It exists only
for tests and never reaches a deployed Worker. Anything else your tests need
from disk has to arrive the same way.

**D1 and KV state persists from one test to the next inside a file** — it is
miniflare's in-memory SQLite, not a fresh store per test, and nothing rolls it
back. So never assert on a whole-table count or a list length. The todos test
shows the pattern: it keeps the id it created and asserts with
`.some((t) => t.id === todo.id)`, which is true regardless of what else is in
the table. `tests/setup.ts` is a `setupFile`, so migrations re-run per file, not
per test.

**R2 is exercisable without network.** `vitest.config.ts` binds a `BUCKET` plus
dummy `R2_*` credentials, because `presign` signs URLs locally — fake values
still exercise the whole AWS SDK path.

### Pitfalls

- Using `GET` for an oRPC procedure — oRPC is always POST
- Reading a file with Node `fs` — no `fs` in the Worker sandbox, pass data via a
  binding (see `TEST_MIGRATIONS`)
- Asserting on the `{ json: ... }` wrapper instead of unwrapping

## E2E — local vs deployed

`apps/web/playwright.config.ts` switches on one variable:

```
PLAYWRIGHT_BASE_URL unset  → playwright auto-starts `pnpm run dev`, hits :3000
PLAYWRIGHT_BASE_URL set    → skips webServer, hits the URL you gave it
```

Nothing sets it for you. Locally, `pnpm test:e2e` bootstraps the dev server and
you need nothing else. To test a deployed stage, export it by hand:

```bash
PLAYWRIGHT_BASE_URL=https://<stage-frontend-url> pnpm --filter web test:e2e
```

Against a remote target the auth and API-key specs **skip themselves** — they
read login codes from `/api/dev/otp`, which only exists when `RESEND_API_KEY` is
unset. The smoke spec is the one that runs everywhere.

A guard in `e2e/global-setup.ts` aborts the suite if the target URL serves a
different app. Playwright reuses whatever is already on `:3000`, and every
saasflare product defaults to that port, so without the guard a run against a
sibling product would fail confusingly — or quietly pass.

Tests hitting a deployed stage share its real D1: use throwaway data, assert on
what the test created, never on initial state.

## Package-upgrade smoke net

Two tests deliberately cover breadth over depth, one happy path per feature:

| File | Covers |
|---|---|
| `apps/server/tests/server.test.ts` | Hono routing, all four `healthCheck.*` binding probes (D1 · KV · R2), and the planet / todos / storage procedures |
| `apps/web/e2e/smoke.spec.ts` | App renders, plus the frontend → oRPC → backend round-trip |

Auth, API keys and `config.status` are **not** in that file — they have
dedicated suites (`auth-modes`, `api-keys`, `config-status`, `dev-otp`,
`todos-ownership`) because they need to mutate `env.AUTH_MODE` per test.

After bumping Hono, oRPC, Zod, Drizzle, `@aws-sdk/*`, TanStack, Vite or the
Cloudflare runtime, run these — a regression in any layer fails loudly here
instead of reaching prod. When you add a feature, extend these two files so the
net keeps covering the whole surface. Edge cases belong in dedicated files.

## CI

```
PR (any branch)  →  test                     (biome ci · typecheck · vitest)
push dev         →  test  →  deploy(dev)
push main        →  test  →  deploy(prod)
```

A failing `test` blocks the deploy — `deploy` declares `needs: test`.

**E2E does not run in CI.** The job was removed: Playwright installs kept
hanging in Actions and burning minutes. Run it locally against a deployed stage
as shown above. Full workflow: `.github/workflows/deploy.yml`.

## Generating E2E tests in natural language

Three sub-agents defined in `.claude/agents/` drive a real browser through the
`playwright-test` MCP server (declared in `.mcp.json`, approve on first use).
Read those agent files for what each one does; the workflow is:

**plan** → a reviewable markdown spec in `apps/web/e2e/specs/<feature>.md`
→ **generate** → a `.spec.ts` whose selectors came from real browser
exploration → **heal** → repairs selector drift after UI changes.

They need `pnpm dev` running. Generated tests are plain Playwright — no AI runs
in CI.

The spec markdown is the source of truth, not the generated code: when
requirements change, edit the spec and regenerate. `e2e/seed.spec.ts` is
committed on purpose — the agents read it every run for shared setup.

Worth it for a new feature with several flows, for backfilling coverage on an
existing area, or when tests keep breaking on CSS changes. Hand-write instead
for a short smoke check, for anything needing fine control over timing or
network mocking, and for critical infra like auth — there you want full
ownership.

The healer marks a test `test.fixme()` with an explanation as a last resort. It
must never silently delete an assertion; if it does, that is a bug worth fixing
in the agent prompt.

> **Only approve MCP servers you added deliberately** — `playwright-test` here.
> Treat any other server that asks for approval as untrusted.
