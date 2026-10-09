import { expect, test } from '@playwright/test';
import { isRemote, SERVER_URL, signIn } from './auth-helpers';

test.describe('Local Telegram administration', () => {
  test.skip(isRemote, 'Synthetic local Telegram configuration only');
  test('admin manages intake route, tests delivery, simulates private image and checks mobile layout', async ({
    page,
  }, info) => {
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, 'phase6-admin@example.test');
    await page.getByRole('link', { name: 'Telegram 設定' }).click();
    await expect(
      page.getByRole('heading', { name: 'Telegram 群組設定' }),
    ).toBeVisible();
    const suffix = Date.now();
    const chatId = `-${suffix}`;
    await page.getByRole('button', { name: '新增路由', exact: true }).click();
    await page
      .getByLabel('名稱', { exact: true })
      .fill(`虛構測試收件-${suffix}`);
    await page.getByLabel('群組 ID', { exact: true }).fill(chatId);
    await page.getByLabel('Topic ID（選填）').fill('55');
    await page.getByRole('button', { name: '儲存路由', exact: true }).click();
    const row = page
      .getByText(`虛構測試收件-${suffix}`, { exact: true })
      .locator('..');
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '測試發送' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '確認測試發送', exact: true })
      .click();
    await expect(page.getByText('測試成功', { exact: true })).toBeVisible();
    await row.getByRole('button', { name: '停用', exact: true }).click();
    await expect(row.getByText('停用', { exact: true })).toBeVisible();
    await row.getByRole('button', { name: '啟用', exact: true }).click();
    await expect(row.getByText('啟用', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Telegram 使用者 ID')).toHaveCount(0);
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
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole('heading', { name: 'Telegram 群組設定' }),
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
