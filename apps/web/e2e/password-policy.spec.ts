import { expect, test } from '@playwright/test';
import {
  completeEnrollment,
  isRemote,
  SERVER_URL,
  signIn,
} from './auth-helpers';

test('六碼密碼：首次設定、本人修改及管理員重設後設定一致', async ({
  page,
  browser,
}) => {
  test.skip(isRemote, 'Local fictional accounts only');
  test.setTimeout(120000);
  await page.goto('/cases');
  await signIn(page, 'phase8-admin@example.test');
  const username = `six-${Date.now()}`;
  const saved = await page.request.post(`${SERVER_URL}/rpc/accounts/save`, {
    data: {
      json: {
        username,
        name: '虛構六碼驗收',
        role: 'restricted',
        active: true,
        collectorId: null,
        allow: ['case.view', 'case.view_all'],
        deny: [],
      },
    },
  });
  expect(saved.status()).toBe(200);
  const account = (await saved.json()).json;
  expect(account.temporaryPassword.length).toBeGreaterThan(24);
  const context = await browser.newContext({
    baseURL: 'http://localhost:3000',
    extraHTTPHeaders: { Origin: 'http://localhost:3000' },
  });
  const user = await context.newPage();
  try {
    await user.goto('/login');
    await user.getByLabel('帳號', { exact: true }).fill(username);
    await user
      .getByLabel('密碼', { exact: true })
      .fill(account.temporaryPassword);
    await user.getByRole('button', { name: '登入', exact: true }).click();
    await expect(
      user.getByRole('heading', { name: '設定新密碼' }),
    ).toBeVisible();
    await expect(user.getByLabel('新密碼', { exact: true })).toHaveAttribute(
      'minlength',
      '6',
    );
    await user.getByLabel('新密碼', { exact: true }).fill('12345');
    await user.getByLabel('確認新密碼').fill('12345');
    await user.getByRole('button', { name: '儲存新密碼' }).click();
    expect(
      await user
        .getByLabel('新密碼', { exact: true })
        .evaluate((e: HTMLInputElement) => e.validationMessage),
    ).toBe('密碼至少需要 6 碼。');
    await user.getByLabel('新密碼', { exact: true }).fill('123456');
    await user.getByLabel('確認新密碼').fill('123456');
    await user.getByRole('button', { name: '儲存新密碼' }).click();
    await completeEnrollment(user);
    await user.goto('/cases/profile');
    await expect(user.getByLabel('新密碼', { exact: true })).toHaveAttribute(
      'minlength',
      '6',
    );
    await user.locator('#currentPassword').fill('123456');
    await user.getByLabel('新密碼', { exact: true }).fill('abcdef');
    await user.getByLabel('確認新密碼').fill('abcdef');
    await user.getByRole('button', { name: '儲存新密碼' }).click();
    await expect(
      user.getByText('密碼已更新，其他登入已撤銷。', { exact: true }),
    ).toBeVisible();
    await user.locator('#currentPassword').fill('abcdef');
    await user.getByLabel('新密碼', { exact: true }).fill('abcdefg');
    await user.getByLabel('確認新密碼').fill('abcdefg');
    await user.getByRole('button', { name: '儲存新密碼' }).click();
    await expect
      .poll(async () => {
        const r = await user.request.post(`${SERVER_URL}/api/auth/login`, {
          data: { username, password: 'abcdefg' },
        });
        return r.status();
      })
      .toBe(200);
    const reset = await page.request.post(`${SERVER_URL}/rpc/accounts/action`, {
      data: {
        json: { id: account.id, action: 'reset_password', expectedVersion: 0 },
      },
    });
    expect(reset.status()).toBe(200);
    const temporary = (await reset.json()).json.temporaryPassword;
    expect(temporary.length).toBeGreaterThan(24);
    await context.clearCookies();
    await user.goto('/login');
    await user.getByLabel('帳號', { exact: true }).fill(username);
    await user.getByLabel('密碼', { exact: true }).fill(temporary);
    await user.getByRole('button', { name: '登入', exact: true }).click();
    await user.getByLabel('新密碼', { exact: true }).fill('abc123');
    await user.getByLabel('確認新密碼').fill('abc123');
    await user.getByRole('button', { name: '儲存新密碼' }).click();
    await expect(
      user.getByRole('heading', { name: '兩步驟驗證', exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
