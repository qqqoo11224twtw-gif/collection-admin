import { expect, test } from '@playwright/test';
import { isRemote, SERVER_URL, signIn } from './auth-helpers';

/**
 * API key lifecycle through the real UI: create (plaintext shown once) →
 * call the external API with it → revoke → the key is dead. Local-only.
 */

test.describe('API keys', () => {
  test.skip(isRemote, 'key E2E needs the local dev OTP endpoint');

  test('create → call /api/v1/whoami → revoke → 401', async ({ page }) => {
    await page.goto('/examples/components/api-keys');
    // Wait for the gate's redirect so signIn keeps ?redirect=... intact.
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, `keys-${Date.now()}@test.dev`);
    await expect(page).toHaveURL(/\/api-keys/);
    await expect(
      page.getByRole('heading', { name: 'API Keys Demo' }),
    ).toBeVisible();

    // Create.
    await page.getByRole('button', { name: /create key/i }).click();
    await page.getByLabel('Name').fill('e2e-key');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const key = (await page.getByTestId('created-key').textContent()) ?? '';
    expect(key).toMatch(/^sfapp_/);
    await page.getByRole('button', { name: 'Done' }).click();

    // The one-time plaintext works against the external API.
    const ok = await page.request.get(`${SERVER_URL}/api/v1/whoami`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(ok.status()).toBe(200);

    // The table shows metadata, never the full key.
    await expect(page.getByRole('cell', { name: 'e2e-key' })).toBeVisible();
    await expect(page.locator('table')).not.toContainText(key);

    // Revoke; the key dies immediately.
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await page.getByRole('button', { name: /revoke key/i }).click();
    await expect(page.getByRole('cell', { name: 'e2e-key' })).not.toBeVisible();

    const dead = await page.request.get(`${SERVER_URL}/api/v1/whoami`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(dead.status()).toBe(401);
  });
});
