import { expect, test } from '@playwright/test';
import { APP_DISPLAY_NAME } from '../src/lib/brand';

/**
 * Frontend smoke test — the browser-side counterpart to the server smoke
 * test. Run after bumping frontend packages (TanStack Start/Router/Query,
 * Vite, oRPC client, Tailwind, ...) to confirm the app still renders and the
 * full frontend → oRPC → backend round-trip works.
 *
 * Read-only on purpose: it never mutates data, so it's safe against the
 * shared dev/prod stage.
 */

test.describe('Smoke tests', () => {
  test('homepage renders and the API round-trip works', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(new RegExp(APP_DISPLAY_NAME, 'i'));

    // All four system-status cards render (proves SSR + hydration). Scoped
    // to the section — "R2 Storage" also appears as an example card.
    const status = page.locator('section').filter({ hasText: 'System Status' });
    for (const name of [
      'API Connection',
      'KV Storage',
      'D1 Database',
      'R2 Storage',
    ]) {
      await expect(status.getByText(name, { exact: true })).toBeVisible();
    }

    // At least one health check resolves to "Healthy" — proves the full
    // frontend → oRPC client → TanStack Query → Hono backend chain is intact.
    // We don't assert all four, since R2 may be unconfigured on a given stage.
    await expect(page.getByText('Healthy').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('homepage lists the example cards (no hub page)', async ({ page }) => {
    await page.goto('/');
    const demos = page.locator('section').filter({ hasText: 'Examples' });
    await expect(demos.getByText('Per-User Data — Todos')).toBeVisible();
    await expect(demos.getByText('API Key Authentication')).toBeVisible();
    await expect(demos.getByText('File Uploads — R2')).toBeVisible();
    await expect(demos.getByText('SSR Data Fetching')).toBeVisible();
  });
});
