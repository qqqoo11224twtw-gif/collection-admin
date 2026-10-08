import { expect, test } from '@playwright/test';
import { DEMO_IMAGES } from '../../../packages/db/src/demo-images';
import { isRemote, SERVER_URL, signIn } from './auth-helpers';

test.describe('Fictional phase eight finance and dispatch', () => {
  test.skip(isRemote, 'Local fictional data only');
  test('manual finished image, duplicate override, receipt, separate return status, XLSX and mobile dispatch', async ({
    page,
  }, info) => {
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, 'phase8-admin@example.test');
    await expect(
      page.getByRole('button', { name: '新增案件', exact: true }),
    ).toBeVisible();
    const suffix = Date.now(),
      code = `FIN-${suffix}`,
      name = `Fictional finance ${suffix}`;
    async function manual() {
      await page.getByRole('button', { name: '新增案件', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('客戶姓名').fill(name);
      await dialog.getByLabel('代號', { exact: true }).fill(code);
      await dialog.getByLabel('地區', { exact: true }).selectOption('高雄市');
      await dialog.getByLabel('委外圖片').setInputFiles({
        name: 'fictional-finished.png',
        mimeType: 'image/png',
        buffer: Buffer.from(DEMO_IMAGES[0].base64, 'base64'),
      });
      await dialog
        .getByRole('button', { name: '新增案件', exact: true })
        .click();
    }
    await manual();
    await expect(page).toHaveURL(/\/cases\/[a-f0-9-]+$/);
    const first = page.url().split('/').at(-1);
    await page.getByRole('tab', { name: '委外圖片', exact: true }).click();
    await expect(
      page.getByRole('img', { name: 'fictional-finished.png' }),
    ).toHaveAttribute('src', /^blob:/);
    await page.goto('/cases');
    await manual();
    const warning = page.getByRole('alertdialog', {
      name: '重複建案提醒',
    });
    await expect(
      warning.getByText('發現疑似重複案件', { exact: true }),
    ).toBeVisible();
    await expect(warning).not.toContainText('外收人員');
    await warning.getByRole('button', { name: '繼續建檔' }).click();
    await expect(page).toHaveURL(/\/cases\/[a-f0-9-]+$/);
    expect(page.url().split('/').at(-1)).not.toBe(first);
    const caseId = page.url().split('/').at(-1);
    await page.getByRole('tab', { name: '收款紀錄', exact: true }).click();
    await page.getByRole('button', { name: '新增收款', exact: true }).click();
    const receipt = page.getByRole('dialog');
    await receipt.getByLabel('收款日期').fill('2026-09-10');
    await receipt.getByLabel('收款金額（新臺幣）').fill('15000');
    await receipt
      .getByRole('button', { name: '確認收款', exact: true })
      .click();
    await expect(receipt).toBeHidden();
    await expect(page.getByRole('tabpanel').getByText(/已收款/)).toBeVisible();
    await page.getByRole('link', { name: '財務管理', exact: true }).click();
    await page.getByLabel('起始日期').fill('2026-09-10');
    await page.getByLabel('結束日期').fill('2026-09-10');
    const returnSection = page
      .getByRole('heading', { name: '回款紀錄', exact: true })
      .locator('..');
    const row = returnSection.locator('article').filter({ hasText: code });
    await expect(row).toContainText('尚未回款');
    await expect(row).toContainText('7,500');
    await row.getByRole('button', { name: '標記已回款' }).click();
    await expect(row).toContainText('已回款');
    await row.getByRole('button', { name: '改回尚未回款' }).click();
    await expect(row).toContainText('尚未回款');
    const downloadPromise = page.waitForEvent('download');
    await page
      .getByRole('button', { name: '匯出 Excel（.xlsx）', exact: true })
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(
      'settlements-2026-09-10-2026-09-10.xlsx',
    );
    await download.saveAs(info.outputPath('fictional-settlements.xlsx'));
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath('finance-mobile.png'),
      fullPage: true,
    });
    await page.getByRole('link', { name: '地區調度', exact: true }).click();
    const region = page.locator('article').filter({
      has: page.getByRole('heading', { name: '高雄市', exact: true }),
    });
    await region.getByRole('link', { name: '未委外案件', exact: true }).click();
    await expect(page.getByLabel('地區')).toHaveValue('高雄市');
    await expect(page.getByLabel('委外狀態')).toHaveValue('unassigned');
    await page.getByLabel('搜尋案件').fill(code);
    await expect(page.getByRole('link', { name, exact: true })).toHaveCount(2);
    await page.getByRole('link', { name, exact: true }).last().click();
    await expect(page).toHaveURL(/\/cases\/[a-f0-9-]+$/);
    const old = await page.request.post(`${SERVER_URL}/rpc/cases/detail`, {
      data: { json: { id: first } },
    });
    expect(old.status()).toBe(200);
    const detail = await page.request.post(`${SERVER_URL}/rpc/cases/detail`, {
      data: { json: { id: caseId } },
    });
    expect(detail.status()).toBe(200);
  });
  test('ordinary user cannot access finance or export a workbook', async ({
    page,
  }) => {
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, `phase8-user-${Date.now()}@example.test`);
    await expect(
      page.getByRole('heading', { name: '案件管理', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: '財務管理', exact: true }),
    ).toHaveCount(0);
    await page.goto('/cases/finance');
    await expect(page.getByText('無操作權限', { exact: true })).toBeVisible();
    expect(
      (
        await page.request.get(`${SERVER_URL}/api/finance/settlements.xlsx`)
      ).status(),
    ).toBe(403);
  });
});
