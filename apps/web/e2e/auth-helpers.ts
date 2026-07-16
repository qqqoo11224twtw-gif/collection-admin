import { expect, type Page } from '@playwright/test';

/**
 * E2E auth harness. Full sign-in only works against a LOCAL dev server:
 * it reads the OTP back from the server's dev-only /api/dev/otp endpoint,
 * which does not exist when a mail key is configured (all deployed stages).
 *
 * In the default `open` mode any email may sign up, so no server-side
 * whitelist setup is needed. To exercise admin flows, add E2E_ADMIN_EMAIL to
 * the local server's ADMIN_EMAILS (see apps/server/.local.env.example).
 */

export const USER_EMAIL = process.env.E2E_USER_EMAIL ?? 'e2e-user@test.dev';
export const SERVER_URL = process.env.E2E_SERVER_URL ?? 'http://localhost:4000';

/** True when running against a deployed URL (no dev OTP endpoint there). */
export const isRemote = !!process.env.PLAYWRIGHT_BASE_URL;

/**
 * Type into a controlled input, retrying until React state catches up.
 * The login page is SSR'd: a fill() that lands before hydration never fires
 * onChange, so the submit button stays disabled — retype until it enables.
 */
export async function fillUntilEnabled(
  page: Page,
  placeholder: string,
  value: string,
  buttonName: RegExp,
): Promise<void> {
  const input = page.getByPlaceholder(placeholder);
  await expect(input).toBeVisible();
  await expect(async () => {
    await input.fill(value);
    await expect(page.getByRole('button', { name: buttonName })).toBeEnabled({
      timeout: 1000,
    });
  }).toPass({ timeout: 15000 });
}

/** Complete the two-step email OTP login through the real UI. */
export async function signIn(page: Page, email = USER_EMAIL): Promise<void> {
  // Keep any ?redirect=... the gate put there — only navigate if needed.
  if (!page.url().includes('/login')) await page.goto('/login');
  await fillUntilEnabled(page, 'you@example.com', email, /send code/i);
  await page.getByRole('button', { name: /send code/i }).click();

  // The shadcn OTP input appears once the code is "sent".
  const otpInput = page.getByTestId('otp-input');
  await expect(otpInput).toBeVisible();

  const res = await page.request.get(
    `${SERVER_URL}/api/dev/otp?email=${encodeURIComponent(email)}`,
  );
  if (!res.ok()) {
    throw new Error(
      `could not read OTP from ${SERVER_URL}/api/dev/otp (${res.status()}); ` +
        'is the local server running without RESEND_API_KEY?',
    );
  }
  const { otp } = (await res.json()) as { otp: string };

  // Typing the 6th digit auto-submits — no button click needed.
  await otpInput.fill(otp);
}
