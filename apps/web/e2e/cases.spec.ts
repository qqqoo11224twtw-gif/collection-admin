import { expect, test } from '@playwright/test';
import { isRemote, signIn } from './auth-helpers';

test.describe('Local case workspace', () => {
  test.skip(isRemote, 'Synthetic cases and OTP sign-in are local only');

  test('admin lists, paginates, filters and handles an empty result', async ({
    page,
  }, testInfo) => {
    await page.goto('/cases?query=DEMO-');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, 'admin@example.test');
    await expect(
      page.getByRole('heading', { name: 'Cases', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('18 cases · Page 1 of 2')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(10);
    await page.screenshot({
      path: testInfo.outputPath('cases-list.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText('18 cases · Page 2 of 2')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(8);
    await page.getByLabel('Filter cases').fill('示範星河');
    await expect(page.locator('tbody tr')).toHaveCount(6);
    await page.getByLabel('Filter cases').fill('no-such-fictional-customer');
    await expect(
      page.getByRole('heading', { name: 'No cases found' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Clear filter' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(10);
  });

  test('global search opens case details and all six tabs', async ({
    page,
  }) => {
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, 'admin@example.test');
    const search = page.getByLabel('Global case search');
    await search.fill('DEMO-2026-001');
    const results = page.getByRole('region', { name: 'Search results' });
    await results.getByRole('link', { name: /DEMO-2026-001/ }).click();
    await expect(page).toHaveURL(/\/cases\/demo-case-001/);
    await expect(
      page.getByRole('tab', { name: 'Overview', exact: true }),
    ).toBeVisible();
    const panel = page.getByRole('tabpanel');
    for (const label of [
      'Customer',
      'Case no.',
      'Code',
      'Address',
      'Amount due',
      'Status',
      'Revisit recommendation',
      'Source',
      'Created',
      'Updated',
    ])
      await expect(panel.getByText(label, { exact: true })).toBeVisible();
    await expect(panel.getByText('Recommended', { exact: true })).toBeVisible();
    for (const name of ['Payment history']) {
      await page.getByRole('tab', { name, exact: true }).click();
      await expect(
        page.getByText('No payments yet.', { exact: true }),
      ).toBeVisible();
    }
    await search.fill('測試路 2 號');
    await expect(
      results.getByRole('link', { name: /DEMO-2026-002/ }),
    ).toBeVisible();
    await search.fill('unfindable');
    await expect(results.getByText('No matching cases.')).toBeVisible();
  });

  test('private thumbnails use authenticated fetch and blob URLs', async ({
    page,
  }, testInfo) => {
    await page.goto('/cases/demo-case-001');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, 'admin@example.test');
    const imageResponse = page.waitForResponse((response) =>
      response
        .url()
        .endsWith('/api/cases/demo-case-001/media/demo-case-001-media-1/image'),
    );
    await page.getByRole('tab', { name: 'Outsourcing images' }).click();
    const response = await imageResponse;
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('private, no-store');
    const images = page.getByRole('tabpanel').locator('img');
    await expect(images).toHaveCount(3);
    for (const image of await images.all()) {
      await expect(image).toHaveAttribute('src', /^blob:/);
      await expect
        .poll(() =>
          image.evaluate(
            (element) => (element as HTMLImageElement).naturalWidth,
          ),
        )
        .toBe(600);
    }
    await expect(
      page.getByText('demo-document-1-1.png', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/Order 1 ·/)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('case-images.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByLabel('Global case search')).toHaveCount(0);
    const denied = await page.request.get(
      'http://localhost:4000/api/cases/demo-case-001/media/demo-case-001-media-1/image',
    );
    expect(denied.status()).toBe(401);
  });

  test('agent only sees assigned cases; forged image URLs are denied', async ({
    page,
  }) => {
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, 'agent@example.test');
    await expect(page.getByText('6 cases · Page 1 of 1')).toBeVisible();
    await page.getByLabel('Global case search').fill('DEMO-002');
    await expect(page.getByText('No matching cases.')).toBeVisible();
    const denied = await page.request.get(
      'http://localhost:4000/api/cases/demo-case-002/media/demo-case-002-media-1/image',
    );
    expect(denied.status()).toBe(404);
    await page.goto('/cases/demo-case-002');
    await expect(page.getByRole('alert')).toContainText('outside your access');
    await page.goto('/cases/demo-case-001');
    await page.getByRole('tab', { name: 'Outsourcing images' }).click();
    await expect(page.getByRole('tabpanel').locator('img')).toHaveCount(3);
  });

  test('loading, missing detail, empty media and responsive layout', async ({
    page,
  }, testInfo) => {
    await page.goto('/login');
    await signIn(page, 'admin@example.test');
    await expect(page.getByTestId('user-email')).toHaveText(
      'admin@example.test',
    );
    // Delay a real request; never replace API responses or Cloudflare bindings.
    await page.route('**/rpc/cases/list', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });
    await page.goto('/cases');
    await expect(page.getByLabel('Loading cases')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(10);
    await page.goto('/cases/unknown-case');
    await expect(page.getByRole('alert')).toContainText('Unable to load');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.goto('/cases/demo-case-018');
    await page.getByRole('tab', { name: 'Outsourcing images' }).click();
    await expect(
      page.getByText('No images attached to this case.'),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('case-mobile.png'),
      fullPage: true,
    });
  });
});
