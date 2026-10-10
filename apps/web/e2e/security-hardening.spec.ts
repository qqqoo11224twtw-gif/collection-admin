import { expect, test } from '@playwright/test';

test('SSR login and unknown pages carry safe headers without exposing source maps', async ({
  request,
}) => {
  for (const path of ['/login', '/security-test-missing']) {
    const response = await request.get(path);
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(response.headers()['referrer-policy']).toBe('no-referrer');
    expect(response.headers()['x-frame-options']).toBe('DENY');
    expect(response.headers()['x-robots-tag']).toBe(
      'noindex, nofollow, noarchive',
    );
    expect(response.headers()['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers()['content-security-policy-report-only']).toContain(
      'connect-src',
    );
  }
  const map = await request.get('/assets/security-test.js.map');
  expect(map.status()).toBe(404);
  expect(await map.text()).not.toContain('sourcesContent');
  const robots = await request.get('/robots.txt');
  expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');
});

test('login still renders under the baseline CSP', async ({ page }) => {
  await page.goto('/login');
  await expect(
    page.getByRole('button', { name: '登入', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('帳號', { exact: true })).toBeVisible();
});
