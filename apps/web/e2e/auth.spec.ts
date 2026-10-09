import { expect, test } from '@playwright/test';
import { isRemote, signIn, USER_EMAIL } from './auth-helpers';

/**
 * The provisioned-account sign-in story through the real UI. Local-only: the
 * flows read the OTP back from the dev-only endpoint.
 */

test.describe('Auth (open mode)', () => {
  test.skip(isRemote, 'sign-in E2E needs the local dev OTP endpoint');

  test('allowlisted email signs in via OTP and lands back home', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page).toHaveURL(/\/login/);

    await signIn(page);

    // Signed-in header state.
    await expect(page.getByTestId('user-email')).toHaveText(USER_EMAIL);
  });

  test('protected page redirects to /login and returns after sign-in', async ({
    page,
  }) => {
    await page.goto('/examples/components/todos');
    await expect(page).toHaveURL(/\/login\?.*redirect=/);

    await signIn(page);
    await expect(page).toHaveURL(/\/examples\/components\/todos/);
    await expect(page.getByText('Private Todos Demo')).toBeVisible();
  });

  test('login rejects external redirect destinations', async ({ page }) => {
    await page.goto('/login?redirect=https%3A%2F%2Fexample.invalid');
    await signIn(page);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: '儀表總覽' })).toBeVisible();
  });

  test('todos are private to the account', async ({ page }) => {
    await page.goto('/examples/components/todos');
    // Wait for the gate's redirect so signIn keeps ?redirect=... intact.
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, `owner-${Date.now()}@test.dev`);
    await expect(page).toHaveURL(/\/examples\/components\/todos/);

    const text = `mine ${Date.now()}`;
    await page.getByPlaceholder('Add a new todo').fill(text);
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText(text)).toBeVisible();

    // A different account must not see it (fresh session, same browser).
    await page.context().clearCookies();
    await page.goto('/examples/components/todos');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, `other-${Date.now()}@test.dev`);
    await expect(page.getByText('Private Todos Demo')).toBeVisible();
    await expect(page.getByText(text)).not.toBeVisible();
  });

  test('sign out returns to the logged-out header', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page);
    await expect(page.getByTestId('user-email')).toBeVisible();

    await page.getByRole('button', { name: /登出/i }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByLabel('電子郵件', { exact: true })).toBeVisible();
  });
});
