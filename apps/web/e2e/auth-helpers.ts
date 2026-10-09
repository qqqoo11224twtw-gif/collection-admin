import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

/**
 * E2E auth harness. Full sign-in only works against a LOCAL dev server:
 * it reads the OTP back from the server's dev-only /api/dev/otp endpoint,
 * which does not exist when a mail key is configured (all deployed stages).
 *
 * In the default `open` mode any email may sign up, so no server-side setup
 * is needed. Admin-only flows have no e2e coverage — they would need an
 * ADMIN_EMAILS entry matching the address below.
 */

export const USER_EMAIL = 'e2e-user@test.dev';
export const SERVER_URL = 'http://localhost:4000';

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
  if (!isRemote) {
    const dir = new URL('../../server/.wrangler/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    const safe = email.replaceAll("'", "''");
    const now = Date.now();
    const admin = /^(admin|phase[2-8]-admin)@example\.test$/.test(email);
    writeFileSync(
      new URL('e2e-user.sql', dir),
      `INSERT INTO user(id,name,email,email_verified,role,created_at,updated_at) VALUES ('${crypto.randomUUID()}','虛構測試帳號','${safe}',0,'${admin ? 'admin' : 'user'}',${now},${now}) ON CONFLICT(email) DO NOTHING;`,
    );
    await expect(async () =>
      execFileSync(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              '../../../node_modules/wrangler/bin/wrangler.js',
              import.meta.url,
            ),
          ),
          'd1',
          'execute',
          'starter-local-db',
          '--local',
          '--config',
          'wrangler.local.jsonc',
          '--file',
          '.wrangler/e2e-user.sql',
        ],
        {
          cwd: fileURLToPath(new URL('../../server/', import.meta.url)),
          stdio: 'pipe',
          windowsHide: true,
        },
      ),
    ).toPass({ timeout: 10000, intervals: [250, 500, 1000] });
  }
  // Keep any ?redirect=... the gate put there — only navigate if needed.
  if (!page.url().includes('/login')) await page.goto('/login');
  await fillUntilEnabled(page, 'you@example.com', email, /寄送驗證碼/i);
  await page.getByRole('button', { name: /寄送驗證碼/i }).click();

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
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
}
