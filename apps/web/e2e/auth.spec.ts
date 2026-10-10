import { expect, test } from '@playwright/test';
import { isRemote, SERVER_URL, signIn, USER_EMAIL } from './auth-helpers';

test.describe('正式帳號登入', () => {
  test.skip(isRemote, 'Only local fictional credentials');
  test('username password and TOTP establish a protected session, logout revokes access', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByLabel('帳號', { exact: true })).toBeVisible();
    await expect(page.getByText('電子郵件', { exact: true })).toHaveCount(0);
    await signIn(page);
    await expect(page).toHaveURL(/\/cases/);
    await page.setViewportSize({ width: 1366, height: 900 });
    await expect(page.getByTestId('user-email')).toHaveText(
      `e2e-${USER_EMAIL.replace(/[^a-z0-9]/g, '-')}`,
    );
    await page
      .getByRole('button', { name: '登出', exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/login/);
    const rejected = await page.request.post(`${SERVER_URL}/rpc/cases/list`, {
      data: { json: {} },
    });
    expect(rejected.status()).toBe(401);
  });
  test('public signup and Email OTP are retired and invalid login stays anonymous', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.goto('/login');
    await expect(page.getByRole('link', { name: /註冊/ })).toHaveCount(0);
    await page
      .getByLabel('帳號', { exact: true })
      .fill('fictional-missing-account');
    await page
      .getByLabel('密碼', { exact: true })
      .fill('Fictional-wrong-password!');
    await page.getByRole('button', { name: '登入', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 30000 });
    const old = await page.request.post(
      `${SERVER_URL}/api/auth/email-otp/send-verification-otp`,
      { data: { email: 'fictional@test.dev', type: 'sign-in' } },
    );
    expect(old.status()).toBe(403);
  });
  test('mobile login fits all target widths', async ({ page }) => {
    for (const width of [375, 390, 430]) {
      await page.setViewportSize({ width, height: 812 });
      await page.goto('/login');
      await expect(
        page.getByRole('button', { name: '登入', exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
  });
});
