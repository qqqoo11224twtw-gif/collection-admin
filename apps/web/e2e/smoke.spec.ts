import { expect, test } from '@playwright/test';
import { isRemote, signIn } from './auth-helpers';

test('unauthenticated homepage presents the safe OTP login', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await expect(page).toHaveTitle('案件管理後台');
  await expect(page.getByLabel('電子郵件', { exact: true })).toBeVisible();
});
test('dashboard reads permission-scoped case data', async ({ page }) => {
  test.skip(isRemote, 'Local fictional account');
  await page.goto('/');
  await signIn(page, 'phase8-admin@example.test');
  await expect(page.getByRole('heading', { name: '儀表總覽' })).toBeVisible();
  await expect(page.getByText('全部案件', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '最近案件' })).toBeVisible();
});
