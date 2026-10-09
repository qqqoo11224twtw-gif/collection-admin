import { expect, test } from '@playwright/test';
import { isRemote, signIn } from './auth-helpers';

test.describe('Local case reports', () => {
  test.skip(isRemote, 'Reports use fictional local data only');
  test('admin creates and edits reports, synchronizes summary and preserves history', async ({
    page,
  }, testInfo) => {
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, 'phase3-admin@example.test');
    await page.getByRole('button', { name: '新增案件', exact: true }).click();
    const create = page.getByRole('dialog');
    await create.getByLabel('地區', { exact: true }).selectOption('台北市');
    await create.getByLabel('客戶姓名').fill('虛構三階段瀏覽器測試戶');
    await create
      .getByLabel('代號', { exact: true })
      .fill(`REPORT-${Date.now()}`);
    await create
      .getByLabel('地址', { exact: true })
      .fill('虛構市回報路（非真實地址）');
    await create.getByLabel('應收款項（新臺幣）').fill('15000');
    await create.getByRole('button', { name: '新增案件', exact: true }).click();
    await expect(page).toHaveURL(/\/cases\/[a-f0-9-]+$/);
    await page.getByRole('tab', { name: '回報紀錄', exact: true }).click();
    await expect(
      page.getByText('暫無回報紀錄。', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '新增回報' }).click();
    let dialog = page.getByRole('dialog');
    await dialog
      .getByLabel('回報內容')
      .fill('完全虛構：本次未尋獲，建議再訪。');
    await dialog.getByLabel('回報狀態').selectOption('cannot_find');
    await dialog.getByLabel('二訪建議').selectOption('recommended');
    await dialog.getByLabel('二訪原因').fill('虛構理由：下次再觀察');
    await dialog.getByRole('button', { name: '新增回報', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('tabpanel').getByText('找不到客戶', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('tabpanel').getByText(/ · 管理員$/),
    ).toBeVisible();
    await page.getByRole('tab', { name: '概覽', exact: true }).click();
    await expect(
      page.getByRole('tabpanel').getByText('安排二訪', { exact: true }),
    ).toBeVisible();
    await page.getByRole('tab', { name: '回報紀錄', exact: true }).click();
    await page.getByRole('button', { name: '新增回報' }).click();
    dialog = page.getByRole('dialog');
    await dialog
      .getByLabel('回報內容')
      .fill('完全虛構：第二次回報為分期觀察。');
    await dialog.getByLabel('回報狀態').selectOption('installment');
    await dialog.getByLabel('二訪建議').selectOption('observe');
    await dialog.getByLabel('有收款標記', { exact: true }).check();
    await dialog.getByLabel('回報收款金額（新臺幣）').fill('15000');
    await dialog.getByRole('button', { name: '新增回報', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('tabpanel').getByText('分期', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('tabpanel').getByText('值得二訪', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: '編輯回報', exact: true })
      .first()
      .click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('回報狀態').selectOption('settled');
    await dialog.getByLabel('二訪建議').selectOption('not_needed');
    await dialog.getByRole('button', { name: '儲存回報', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('tab', { name: '概覽', exact: true }).click();
    await expect(
      page.getByRole('tabpanel').getByText('結清', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('tabpanel').getByText('不需二訪', { exact: true }),
    ).toBeVisible();
    await page.getByRole('tab', { name: '操作紀錄', exact: true }).click();
    await expect(page.getByText('已建立回報', { exact: true })).toHaveCount(2);
    await expect(page.getByText('已編輯回報', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '回報紀錄', exact: true }).click();
    await page.screenshot({
      path: testInfo.outputPath('reports-history.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: '新增回報' })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('reports-mobile.png'),
      fullPage: true,
    });
  });
  test('collector creates a report for an assigned case and cannot edit or open another case', async ({
    page,
  }) => {
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, 'agent@example.test');
    await expect(page.getByTestId('user-email')).toBeVisible();
    await page.goto('/cases/demo-case-004');
    await page.getByRole('tab', { name: '回報紀錄', exact: true }).click();
    await page.getByRole('button', { name: '新增回報' }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByLabel('回報內容')
      .fill(`完全虛構的外收回報 ${Date.now()}`);
    await dialog.getByLabel('回報狀態').selectOption('needs_review');
    await dialog.getByRole('button', { name: '新增回報', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page
        .getByRole('tabpanel')
        .getByText('外收人員入口', { exact: false })
        .first(),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '編輯回報', exact: true }),
    ).toHaveCount(0);
    await page.goto('/cases/demo-case-002');
    await expect(page.getByRole('button', { name: '新增回報' })).toHaveCount(0);
    await expect(
      page.getByRole('alert').getByText(/無法載入資料/),
    ).toBeVisible();
  });
});
