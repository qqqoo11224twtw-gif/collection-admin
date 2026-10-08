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
      page.getByRole('heading', { name: '案件管理', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('18 筆案件 · 第 1 ／ 2')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(10);
    await page.screenshot({
      path: testInfo.outputPath('cases-list.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '下一頁' }).click();
    await expect(page.getByText('18 筆案件 · 第 2 ／ 2')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(8);
    await page.getByLabel('搜尋案件').fill('示範星河');
    await expect(page.locator('tbody tr')).toHaveCount(6);
    await page.getByLabel('搜尋案件').fill('no-such-fictional-customer');
    await expect(
      page.getByRole('heading', { name: '找不到案件' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '清除篩選' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(10);
  });

  test('global search opens case details and all six tabs', async ({
    page,
  }) => {
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, 'admin@example.test');
    const search = page.getByLabel('全域案件搜尋');
    await search.fill('DEMO-2026-001');
    const results = page.getByRole('region', { name: '搜尋結果' });
    await results.getByRole('link', { name: /DEMO-2026-001/ }).click();
    await expect(page).toHaveURL(/\/cases\/demo-case-001/);
    await expect(
      page.getByRole('tab', { name: '概覽', exact: true }),
    ).toBeVisible();
    const panel = page.getByRole('tabpanel');
    for (const label of [
      '客戶',
      '案件編號',
      '代號',
      '地址',
      '應收款項',
      '案件狀態',
      '二訪建議',
      '來源',
      '建立時間',
      '更新時間',
    ])
      await expect(panel.getByText(label, { exact: true })).toBeVisible();
    await expect(panel.getByText('值得二訪', { exact: true })).toBeVisible();
    for (const name of ['收款紀錄']) {
      await page.getByRole('tab', { name, exact: true }).click();
      await expect(
        page.getByText('暫無收款紀錄。', { exact: true }),
      ).toBeVisible();
    }
    await search.fill('測試路 2 號');
    await expect(
      results.getByRole('link', { name: /DEMO-2026-002/ }),
    ).toBeVisible();
    await search.fill('unfindable');
    await expect(results.getByText('找不到符合條件的案件。')).toBeVisible();
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
    await page.getByRole('tab', { name: '委外圖片' }).click();
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
    await expect(page.getByText(/排序 1 ·/)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('case-images.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '登出' }).click();
    await expect(page.getByLabel('全域案件搜尋')).toHaveCount(0);
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
    await expect(page.getByText('6 筆案件 · 第 1 ／ 1')).toBeVisible();
    await page.getByLabel('全域案件搜尋').fill('DEMO-002');
    await expect(page.getByText('找不到符合條件的案件。')).toBeVisible();
    const denied = await page.request.get(
      'http://localhost:4000/api/cases/demo-case-002/media/demo-case-002-media-1/image',
    );
    expect(denied.status()).toBe(404);
    await page.goto('/cases/demo-case-002');
    await expect(page.getByRole('alert')).toContainText('查看權限');
    await page.goto('/cases/demo-case-001');
    await page.getByRole('tab', { name: '委外圖片' }).click();
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
    await expect(page.getByLabel('載入案件中')).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(10);
    await page.goto('/cases/unknown-case');
    await expect(page.getByRole('alert')).toContainText('無法載入');
    await page.getByRole('button', { name: '重試' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.goto('/cases/demo-case-018');
    await page.getByRole('tab', { name: '委外圖片' }).click();
    await expect(page.getByText('此案件暫無委外圖片。')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: '概覽', exact: true }).click();
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
