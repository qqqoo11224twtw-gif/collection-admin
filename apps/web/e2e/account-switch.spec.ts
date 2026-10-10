import { expect, test } from '@playwright/test';
import {
  completeEnrollment,
  isRemote,
  SERVER_URL,
  signIn,
} from './auth-helpers';

test('same mobile browser switches admin to two new collectors without stale identity', async ({
  page,
}) => {
  test.skip(isRemote, 'Local fictional accounts only');
  test.setTimeout(180000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await signIn(page, 'phase8-admin@example.test');
  const accounts = [];
  for (const suffix of ['a', 'b']) {
    const collectorResponse = await page.request.post(
      `${SERVER_URL}/rpc/collectors/create`,
      {
        data: {
          json: {
            displayName: `虛構切帳${suffix}`,
            code: `SW-${suffix}-${Date.now()}`,
            userId: null,
            isActive: true,
          },
        },
      },
    );
    expect(collectorResponse.status()).toBe(200);
    const collector = (await collectorResponse.json()).json;
    const username = `switch-${suffix}-${Date.now()}`;
    const saved = await page.request.post(`${SERVER_URL}/rpc/accounts/save`, {
      data: {
        json: {
          username,
          name: `虛構切帳${suffix}`,
          role: 'user',
          active: true,
          collectorId: collector.id,
          allow: [],
          deny: [],
        },
      },
    });
    expect(saved.status()).toBe(200);
    accounts.push({
      ...(await saved.json()).json,
      username,
      collectorId: collector.id,
    });
  }
  for (const account of accounts) {
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page
      .getByRole('button', { name: '登出', exact: true })
      .last()
      .click();
    await expect(page).toHaveURL(/\/login/);
    const anonymous = await page.request.get(
      `${SERVER_URL}/api/auth/get-session`,
    );
    expect(await anonymous.json()).toBeNull();
    await page.getByLabel('帳號', { exact: true }).fill(account.username);
    await page
      .getByLabel('密碼', { exact: true })
      .fill(account.temporaryPassword);
    await page.getByRole('button', { name: '登入', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '設定新密碼' }),
    ).toBeVisible();
    await expect(page.getByLabel('新密碼', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('確認新密碼')).toHaveValue('');
    await page.getByLabel('新密碼', { exact: true }).fill('abc123');
    await page.getByLabel('確認新密碼').fill('abc123');
    await page.getByRole('button', { name: '儲存新密碼' }).click();
    await completeEnrollment(page);
    await page.reload();
    const session = await page.request.get(
      `${SERVER_URL}/api/auth/get-session`,
    );
    expect((await session.json()).user).toMatchObject({
      id: account.id,
      username: account.username,
      role: 'user',
    });
    const viewer = await page.request.post(`${SERVER_URL}/rpc/cases/viewer`, {
      data: { json: {} },
    });
    expect((await viewer.json()).json).toMatchObject({
      username: account.username,
      role: 'user',
    });
    const permissionResponse = await page.request.post(
      `${SERVER_URL}/rpc/cases/permissions`,
      { data: { json: {} } },
    );
    const permissions = (await permissionResponse.json()).json;
    expect(permissions).not.toContain('user_permission.manage');
    expect(permissions).not.toContain('case.view_all');
    const cases = await page.request.post(`${SERVER_URL}/rpc/cases/list`, {
      data: { json: {} },
    });
    expect((await cases.json()).json.total).toBe(0);
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await expect(
      page.getByRole('link', { name: '帳號管理', exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '登出', exact: true }).last().click();
  await expect(page).toHaveURL(/\/login/);
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page, 'phase8-admin@example.test');
  const restored = await page.request.get(`${SERVER_URL}/api/auth/get-session`);
  expect((await restored.json()).user.role).toBe('admin');
  await expect(
    page.getByRole('link', { name: '帳號管理', exact: true }),
  ).toBeVisible();
});
