import { expect, test } from '@playwright/test';
import { fillUntilEnabled, isRemote, SERVER_URL, signIn } from './auth-helpers';

test.describe('營運設定與 Email 白名單', () => {
  test.setTimeout(60000);
  test.skip(isRemote, 'Only local fictional data');
  test('admin creates allowlisted account and updates individual permissions on mobile', async ({
    page,
  }, info) => {
    await page.goto('/cases');
    await signIn(page, 'phase8-admin@example.test');
    await page.goto('/cases/users');
    await expect(
      page.getByRole('heading', { name: '使用者與權限' }),
    ).toBeVisible();
    const email = `operations-${Date.now()}@example.test`;
    await page.getByRole('button', { name: '新增使用者', exact: true }).click();
    await page.getByLabel('姓名', { exact: true }).fill('虛構財務營運帳號');
    await page.getByLabel('電子郵件', { exact: true }).fill(email);
    await page.getByLabel('角色', { exact: true }).selectOption('finance');
    await page.getByLabel('新增案件', { exact: true }).selectOption('allow');
    await page.getByLabel('搜尋案件', { exact: true }).selectOption('deny');
    await page.getByRole('button', { name: '儲存', exact: true }).click();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath('users-mobile.png'),
      fullPage: true,
    });
    await page.context().clearCookies();
    await page.goto('/login');
    await signIn(page, email);
    await page.goto('/cases');
    await expect(
      page.getByRole('button', { name: '新增案件', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: '搜尋案件', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('textbox', { name: '全域案件搜尋' }),
    ).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Telegram 設定' })).toHaveCount(
      0,
    );
    const search = await page.request.post(`${SERVER_URL}/rpc/cases/list`, {
      data: { json: { query: 'abc' } },
    });
    expect(search.status()).toBe(403);
  });
  test('system logs support filters, safe details, handling and mobile layout', async ({
    page,
  }, info) => {
    await page.goto('/cases');
    await signIn(page, 'phase8-admin@example.test');
    await page.request.post(
      `${SERVER_URL}/api/auth/email-otp/send-verification-otp`,
      {
        data: {
          email: `unauthorized-${Date.now()}@example.test`,
          type: 'sign-in',
        },
      },
    );
    await page.goto('/cases/system-logs');
    await expect(
      page.getByRole('heading', { name: '系統管理日誌' }),
    ).toBeVisible();
    await page.getByLabel('事件狀態').selectOption('denied');
    await page.getByLabel('搜尋日誌').fill('EMAIL_NOT_ALLOWED');
    await expect(
      page.getByText('此 Email 未被管理員授權登入。', { exact: true }).first(),
    ).toBeVisible();
    await page
      .getByText('此 Email 未被管理員授權登入。', { exact: true })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: '日誌詳情' })).toBeVisible();
    await page.getByLabel('處理備註').fill('虛構驗收已確認');
    await page.getByRole('button', { name: '已處理', exact: true }).click();
    await expect(
      page
        .getByRole('button')
        .filter({ hasText: /EMAIL_NOT_ALLOWED/ })
        .first(),
    ).toContainText('已處理');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath('system-logs-mobile.png'),
      fullPage: true,
    });
  });
  test('unauthorized email sees Chinese rejection and no registration entry', async ({
    page,
  }) => {
    await page.goto('/login');
    await fillUntilEnabled(
      page,
      'you@example.com',
      `not-allowed-${Date.now()}@example.test`,
      /寄送驗證碼/,
    );
    await page.getByRole('button', { name: '寄送驗證碼', exact: true }).click();
    await expect(
      page.getByText('此帳號未被授權使用本系統。', { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('otp-input')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /註冊|建立帳號/ }),
    ).toHaveCount(0);
  });
});
