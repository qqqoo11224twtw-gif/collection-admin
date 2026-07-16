import { expect, test } from '@playwright/test';
import { APP_DISPLAY_NAME } from '../src/lib/brand';
import { isRemote, signIn, USER_EMAIL } from './auth-helpers';

/**
 * The open-mode sign-up/sign-in story through the real UI. Local-only: the
 * flows read the OTP back from the dev-only endpoint.
 */

test.describe('Auth (open mode)', () => {
  test.skip(isRemote, 'sign-in E2E needs the local dev OTP endpoint');

  test('any email signs up via OTP and lands back home', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /sign in/i }).click();
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

  test('Back from the login gate returns home — no redirect loop', async ({
    page,
  }) => {
    // Home → gated example card → the gate REPLACES the gated page with
    // /login. Back must land on home; with a pushed entry it would bounce
    // straight back to /login and the Back button would appear dead.
    await page.goto('/');
    await page.getByRole('link', { name: /per-user data/i }).click();
    await expect(page).toHaveURL(/\/login\?.*redirect=/);

    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(`${APP_DISPLAY_NAME} Console`)).toBeVisible();
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
    await page.getByRole('link', { name: /sign in/i }).click();
    await signIn(page);
    await expect(page.getByTestId('user-email')).toBeVisible();

    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page.getByRole('link', { name: /sign in/i })).toBeVisible();
  });
});
