import { expect, type Page, test } from '@playwright/test';
import { isRemote, SERVER_URL, signIn } from './auth-helpers';

async function rpc<T>(page: Page, path: string, input: unknown): Promise<T> {
  const r = await page.request.post(
    `${SERVER_URL}/rpc/${path.replaceAll('.', '/')}`,
    { data: { json: input } },
  );
  expect(r.status()).toBe(200);
  return (await r.json()).json;
}
test.describe('批量編輯與歷史外收補登', () => {
  test.skip(isRemote, 'Only fictional local data');
  test.setTimeout(60000);
  test('desktop and mobile select explicit fields, fill-empty warning and explicit overwrite', async ({
    page,
  }, info) => {
    await page.goto('/cases');
    await signIn(page, 'phase8-admin@example.test');
    const prefix = `EDIT-${Date.now()}`;
    const collector = await rpc<{ id: string }>(page, 'collectors.create', {
      displayName: prefix,
      code: prefix,
      userId: null,
      isActive: true,
    });
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const c = await rpc<{ id: string }>(page, 'cases.create', {
        code: `${prefix}-${i}`,
        customerName: `虛構批量${prefix}-${i}`,
        address: '虛構',
        region: '桃園市',
        amountDue: 1000,
        status: 'pending',
        source: 'manual',
        revisitStatus: 'pending',
        revisitReason: '',
      });
      ids.push(c.id);
    }
    await rpc(page, 'cases.bulkEdit', {
      caseIds: [ids[0]],
      batchId: crypto.randomUUID(),
      fields: { collectorId: collector.id },
      note: '虛構歷史',
    });
    await page.goto(`/cases?query=${prefix}`);
    await expect(
      page.getByRole('checkbox', { name: '全選目前頁面' }),
    ).toBeEnabled();
    await page.getByRole('checkbox', { name: '全選目前頁面' }).click();
    await expect(page.getByLabel('已選案件')).toContainText('已選取 2 筆案件');
    await page.getByRole('button', { name: '批量編輯', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('有 1 筆已有外收人員');
    await dialog.getByLabel('修改外收人員').click();
    await dialog.getByLabel('補登外收人員').selectOption(collector.id);
    await expect(dialog.getByLabel('外收補登模式')).toHaveValue('fill_empty');
    await dialog.getByLabel('批量操作原因').fill('虛構核對只補空白');
    await dialog.getByRole('button', { name: '確認批量編輯' }).click();
    await expect(dialog).toContainText('成功：1 · 跳過：1');
    await dialog.getByRole('button', { name: '關閉' }).first().click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('checkbox', { name: '全選目前頁面' }).click();
    await page.getByRole('button', { name: '批量編輯', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('修改地區').click();
    await dialog.getByLabel('批量地區').selectOption('台北市');
    await dialog.getByLabel('批量操作原因').fill('虛構地區修正');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath('bulk-edit-mobile.png'),
      fullPage: true,
    });
    await dialog.getByRole('button', { name: '確認批量編輯' }).click();
    await expect(dialog).toContainText('成功：2 · 跳過：0');
    await dialog.getByRole('button', { name: '關閉' }).first().click();
    for (const id of ids) {
      const c = await rpc<{ region: string; amountDue: number }>(
        page,
        'cases.detail',
        { id },
      );
      expect(c.region).toBe('台北市');
      expect(c.amountDue).toBe(1000);
    }
    await page.getByRole('checkbox', { name: '全選目前頁面' }).click();
    await page.getByRole('button', { name: '批量編輯', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('修改外收人員').click();
    await dialog.getByLabel('補登外收人員').selectOption(collector.id);
    await dialog.getByLabel('外收補登模式').selectOption('overwrite');
    await dialog.getByLabel('批量操作原因').fill('虛構覆蓋確認');
    await expect(
      dialog.getByRole('button', { name: '確認批量編輯' }),
    ).toBeDisabled();
    await dialog.getByLabel('確認覆蓋').click();
    await dialog.getByRole('button', { name: '確認批量編輯' }).click();
    await expect(dialog).toContainText('成功：2 · 跳過：0');
    await dialog.getByRole('button', { name: '關閉' }).first().click();
    await page.getByRole('checkbox', { name: '全選目前頁面' }).click();
    await page.getByRole('button', { name: '批量刪除' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('保留案件、圖片、委外、回報與財務歷史');
    await dialog.getByLabel('批量操作原因').fill('虛構案件作廢');
    await expect(
      dialog.getByRole('button', { name: '確認作廢' }),
    ).toBeDisabled();
    await dialog.getByLabel('確認作廢').click();
    await dialog.getByRole('button', { name: '確認作廢' }).click();
    await expect(dialog).toContainText('成功：2 · 跳過：0');
  });
  test('ordinary users have no bulk edit controls and backend denies the action', async ({
    page,
  }) => {
    await page.goto('/cases');
    await signIn(page, 'agent@example.test');
    await page.goto('/cases');
    await expect(
      page.getByRole('button', { name: '批量編輯', exact: true }),
    ).toHaveCount(0);
    const r = await page.request.post(`${SERVER_URL}/rpc/cases/bulkEdit`, {
      data: {
        json: {
          caseIds: ['fictional-missing'],
          fields: { region: '台北市' },
          batchId: crypto.randomUUID(),
          note: '虛構',
        },
      },
    });
    expect(r.status()).toBe(403);
  });
});
