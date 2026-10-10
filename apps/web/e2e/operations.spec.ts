import { expect, test } from '@playwright/test';
import {
  completeEnrollment,
  isRemote,
  SERVER_URL,
  signIn,
} from './auth-helpers';

test.describe('正式帳號與營運設定', () => {
  test.skip(isRemote, 'Local fictional data only');
  test.setTimeout(120000);
  test('admin creates account with grouped overrides; first password change and TOTP are mandatory', async ({
    page,
  }, info) => {
    await page.goto('/cases');
    await signIn(page, 'phase8-admin@example.test');
    await page.goto('/cases/users');
    await expect(
      page.getByRole('heading', { name: '帳號管理', exact: true }),
    ).toBeVisible();
    const username = `operations-${Date.now()}`;
    await page.getByRole('button', { name: '新增帳號', exact: true }).click();
    await page.getByLabel('帳號', { exact: true }).fill(username);
    await page.getByLabel('顯示名稱').fill('虛構營運管理員');
    await page.getByLabel('角色範本').selectOption('restricted');
    await page.getByLabel('案件管理權限').selectOption('allow');
    await page.locator('summary').filter({ hasText: '進階權限' }).click();
    await page.getByLabel('case.search', { exact: true }).selectOption('deny');
    await page.getByRole('button', { name: '儲存變更', exact: true }).click();
    const password = await page.getByLabel('一次性暫時密碼').inputValue();
    expect(password.length).toBeGreaterThan(24);
    await page.getByRole('button', { name: '已安全交付' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath('managed-accounts-mobile.png'),
    });
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByLabel('帳號', { exact: true }).fill(username);
    await page.getByLabel('密碼', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登入', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '設定新密碼' }),
    ).toBeVisible();
    const denied = await page.request.post(`${SERVER_URL}/rpc/cases/list`, {
      data: { json: {} },
    });
    expect(denied.status()).toBe(401);
    await page
      .getByLabel('新密碼', { exact: true })
      .fill('Fictional-new-account-password!');
    await page.getByLabel('確認新密碼').fill('Fictional-new-account-password!');
    await page.getByRole('button', { name: '儲存新密碼' }).click();
    await completeEnrollment(page);
    await expect(
      page.getByRole('button', { name: '新增案件', exact: true }),
    ).toBeVisible();
    expect(
      (
        await page.request.post(`${SERVER_URL}/rpc/cases/list`, {
          data: { json: { query: 'test' } },
        })
      ).status(),
    ).toBe(403);
  });
  test('system log captures failed managed login, supports handling and mobile layout', async ({
    page,
  }, info) => {
    await page.goto('/cases');
    await signIn(page, 'phase8-admin@example.test');
    await page.request.post(`${SERVER_URL}/api/auth/login`, {
      data: {
        username: `missing-log-${Date.now()}`,
        password: 'Fictional-invalid-password!',
      },
    });
    await page.goto('/cases/system-logs');
    await page.getByLabel('事件狀態').selectOption('denied');
    await page.getByLabel('搜尋日誌').fill('LOGIN_PASSWORD_FAILED');
    const row = page
      .getByRole('button')
      .filter({ hasText: 'LOGIN_PASSWORD_FAILED' })
      .first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByRole('heading', { name: '日誌詳情' })).toBeVisible();
    await page.getByLabel('處理備註').fill('虛構安全驗收');
    await page.getByRole('button', { name: '已處理', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath('managed-login-log-mobile.png'),
    });
  });
});
