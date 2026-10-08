import { expect, test } from '@playwright/test';
import { isRemote, SERVER_URL, signIn } from './auth-helpers';

test.describe('Local Telegram administration', () => {
  test.skip(isRemote, 'Synthetic local Telegram configuration only');
  test('admin manages source route and identity, simulates a private image and checks mobile layout', async ({
    page,
  }, info) => {
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, 'phase6-admin@example.test');
    await page.getByRole('link', { name: 'Telegram 設定' }).click();
    await expect(
      page.getByRole('heading', { name: 'Telegram 設定' }),
    ).toBeVisible();
    const suffix = Date.now();
    const chatId = `-${suffix}`;
    await page.getByLabel('Telegram 群組 ID', { exact: true }).fill(chatId);
    await page.getByLabel('Telegram 話題 ID（選填）').fill('55');
    await page.getByRole('button', { name: '儲存路由', exact: true }).click();
    await expect(
      page.getByText(`收件來源 · ${chatId} / Topic 55`),
    ).toBeVisible();
    await page.getByLabel('Telegram 使用者 ID').fill(String(suffix));
    await page
      .getByLabel('顯示名稱（選填）')
      .fill(`Fictional identity ${suffix}`);
    await page.getByRole('button', { name: '儲存身分' }).click();
    await expect(
      page.getByText(`Fictional identity ${suffix} · ${suffix}`),
    ).toBeVisible();
    const row = page.getByText(`收件來源 · ${chatId} / Topic 55`).locator('..');
    await row.getByRole('button', { name: '編輯路由' }).click();
    await page.getByLabel('路由啟用中').uncheck();
    await page.getByRole('button', { name: '儲存路由', exact: true }).click();
    await expect(row.getByText('已停用')).toBeVisible();
    await row.getByRole('button', { name: '編輯路由' }).click();
    await page.getByLabel('路由啟用中').check();
    await page.getByRole('button', { name: '儲存路由', exact: true }).click();
    await expect(row.getByText('啟用中', { exact: true })).toBeVisible();
    const payload = {
      update_id: suffix,
      message: {
        message_id: 1,
        date: 1791400000,
        chat: { id: Number(chatId) },
        message_thread_id: 55,
        from: { id: 900001 },
        photo: [{ file_id: 'fictional-browser-image', file_size: 500 }],
      },
    };
    const receive = await page.request.post(
      `${SERVER_URL}/rpc/telegram/simulate`,
      { data: { json: payload } },
    );
    expect(receive.status()).toBe(200);
    // The local scheduler drains the durable inbox without a manual processing request.
    await expect
      .poll(
        async () => {
          const response = await page.request.post(
            `${SERVER_URL}/rpc/telegram/updates`,
            { data: {} },
          );
          const body = (await response.json()) as {
            json: { id: string; status: string }[];
          };
          return body.json.find((update) => update.id === String(suffix))
            ?.status;
        },
        { timeout: 15000 },
      )
      .toBe('done');
    await page.getByRole('button', { name: '處理本機工作' }).click();
    await expect(
      page.getByRole('button', { name: '處理本機工作' }),
    ).toBeEnabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole('heading', { name: 'Telegram 設定' }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath('telegram-mobile.png'),
      fullPage: true,
    });
  });
  test('ordinary user cannot open administration or invoke management API', async ({
    page,
  }) => {
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, `phase6-user-${Date.now()}@example.test`);
    await expect(page.getByRole('link', { name: 'Telegram 設定' })).toHaveCount(
      0,
    );
    await page.goto('/cases/telegram');
    await expect(page.getByText('無操作權限', { exact: true })).toBeVisible();
    const response = await page.request.post(
      `${SERVER_URL}/rpc/telegram/routes`,
      { data: {} },
    );
    expect(response.status()).toBe(403);
  });
});
