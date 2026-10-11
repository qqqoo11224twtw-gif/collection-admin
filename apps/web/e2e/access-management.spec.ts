import { expect, test } from '@playwright/test';
import { isRemote, signIn } from './auth-helpers';

test.describe('Access 授權信箱 UI（本機 provider fixture）', () => {
  test.skip(isRemote, 'Only fictional local accounts and provider responses');
  test.setTimeout(90000);
  for (const width of [1440, 375]) {
    test(`${width}px: CRUD confirmation, sync feedback and no overflow`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/cases');
      await signIn(page, 'admin@example.test');
      let active = true,
        mutationCalls = 0;
      await page.route('**/rpc/access/**', async (route) => {
        const action = new URL(route.request().url()).pathname
          .split('/')
          .at(-1);
        const input = route.request().postDataJSON()?.json;
        let json: unknown;
        if (action === 'mutate') {
          mutationCalls++;
          if (input.action === 'disable') {
            expect(input.confirmAccountWideRevocation).toBe(true);
            active = false;
          }
          json = {
            success: true,
            partial: false,
            message: 'Cloudflare 白名單已讀回確認。',
            revocation: 'provider_confirmed',
          };
        } else if (action === 'history')
          json = [
            {
              id: 'fixture-op',
              email: 'approved@example.test',
              action: 'disable',
              status: 'success',
              created_at: Date.now(),
              operator: '虛構管理員',
            },
          ];
        else if (action === 'protection')
          json = {
            hostname: 'staging.example.test',
            exactHostnameOnly: true,
            soleAllowGroup: true,
            otpOnly: true,
            allSessions720h: true,
            noDeviceSessionOverride: true,
            applicationSession: '720h',
            policySession: '720h',
            globalSession: '720h',
          };
        else
          json = {
            revision: 'a'.repeat(64),
            busy: false,
            activeCount: active ? 2 : 1,
            items: [
              {
                id: 'fixture-email',
                email: 'approved@example.test',
                active: Number(active),
                cloudActive: active,
                sync_status: 'synced',
                deleted_at: null,
                created_at: Date.now(),
                updated_at: Date.now(),
                modified_by: '虛構管理員',
              },
            ],
          };
        await route.fulfill({ json: { json } });
      });
      await page.goto('/cases/access');
      await expect(
        page.getByRole('heading', { name: 'Access 授權信箱', exact: true }),
      ).toBeVisible();
      await expect(
        page
          .getByText('approved@example.test', { exact: true })
          .filter({ visible: true }),
      ).toBeVisible();
      await page
        .getByRole('button', { name: '停用', exact: true })
        .filter({ visible: true })
        .click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('所有 Access 應用');
      await expect(
        dialog.getByRole('button', { name: '確認停用' }),
      ).toBeDisabled();
      expect(mutationCalls).toBe(0);
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: '確認停用' }).click();
      await expect(dialog).not.toBeVisible();
      await expect(
        page
          .getByRole('button', { name: '啟用', exact: true })
          .filter({ visible: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: '檢視操作紀錄' }).click();
      await expect(
        page.getByRole('heading', { name: '操作紀錄', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: '核對 Access 設定' }).click();
      await expect(page.getByText('Global Session：720h')).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(mutationCalls).toBe(1);
    });
  }
  test('collector sees no navigation or management controls', async ({
    page,
  }) => {
    await page.goto('/cases');
    await signIn(page);
    await page.goto('/cases/access');
    await expect(
      page.getByRole('alert').filter({ hasText: '無操作權限' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '新增 Email' })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('link', { name: 'Access 授權信箱' }),
    ).toHaveCount(0);
  });
});
