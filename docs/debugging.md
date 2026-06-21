# UI Debugging Workflow

Debug frontend issues **Playwright-CLI-first**. The CLI (`pnpm exec playwright ...`)
reproduces the problem in a real browser, captures artifacts, and replays failures
deterministically. Fall back to the Playwright MCP (the `playwright` server in
`.mcp.json`) only for free-form, one-off exploration where writing a spec isn't worth it.

## Step 0: Reach for the right CLI command

| Goal | Command |
|------|---------|
| Step through a flow interactively (time-travel, pick locators, watch mode) | `pnpm exec playwright test --ui` |
| Pause on each action with the Inspector + headed browser | `pnpm exec playwright test --debug` |
| Just watch it run in a real browser | `pnpm exec playwright test --headed` |
| Debug one test / one line | `pnpm exec playwright test e2e/foo.spec.ts:12 --debug` |
| Open a page and explore / generate selectors | `pnpm exec playwright codegen http://localhost:3000` |
| Inspect a recorded failure (DOM, network, console, screenshots per step) | `pnpm exec playwright show-trace` |
| Open the last HTML report | `pnpm exec playwright show-report` |

Run these from `apps/web/`. Add `page.pause()` in a spec to drop into the Inspector at
an exact point. `PWDEBUG=console` exposes a `playwright` object in the browser devtools console.

## Step 1: Reproduce

1. **Write or pick a spec** that hits the broken flow, then run it with `--ui` (or `--debug`).
   The UI mode timeline gives you a DOM snapshot, console, and network panel for every step —
   the same observations below, captured deterministically and re-runnable.
2. No spec yet and not worth one? Use `codegen <url>` to drive the page, or the Playwright MCP
   to take a screenshot, read console messages, and check network requests ad hoc.

## Step 2: Diagnose

3. **Inspect the DOM snapshot** at the failing step (UI mode timeline, or `show-trace` on a
   `retain-on-failure` trace) — check elements exist and carry the expected state/attributes.
4. **Evaluate JS in page context** — `page.evaluate(...)` in the spec, the codegen browser
   console, or the MCP — to inspect component state, variables, and selectors.
5. **Correlate with source code** — read the relevant source files to find the root cause.

## Step 3: Fix & Verify

6. **Fix the code** — make the minimal change to resolve the issue.
7. **Re-run the spec** (`pnpm exec playwright test e2e/foo.spec.ts`) — it must pass, and the
   failure trace/screenshot/video under `apps/web/playwright-report/` should be clean.
8. **Check console is clean** — no new errors introduced (visible in the UI mode / trace console panel).

## Common Scenarios

| Symptom | What to check |
|---------|---------------|
| White/blank page | Console for JS errors, network for failed chunk loads |
| Data not showing | Network requests — is the API returning data? |
| Layout broken | Screenshot + DOM snapshot, compare with expected structure |
| Button does nothing | Click it, then check console for errors |
| Stale data | Network tab — is the request firing? Check cache/query invalidation |
| Hydration mismatch | Console warnings, compare server HTML vs client render |
