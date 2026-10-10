import { expect, test } from '@playwright/test';
import {
  configureCaseFinance,
  isRemote,
  SERVER_URL,
  signIn,
} from './auth-helpers';

test.describe('批量建檔與分期客追蹤', () => {
  test.skip(isRemote, 'Local fictional data only');
  test.setTimeout(90000);
  test('twenty new rows paste, preview and establish cases; a second batch allows partial success on mobile', async ({
    page,
  }, info) => {
    await page.goto('/cases');
    await signIn(page, 'phase8-admin@example.test');
    await page.getByRole('link', { name: '批量建檔', exact: true }).click();
    await page
      .getByRole('button', { name: '新案件批量建檔', exact: true })
      .click();
    const prefix = `BROWSER-${Date.now()}`;
    const text = Array.from(
      { length: 20 },
      (_, i) => `${prefix}-${i}\t虛構批量戶${i}\t桃園市\t虛構地址${i}`,
    ).join('\n');
    await page.getByLabel('貼上 Excel／Google Sheet 資料').fill(text);
    await page.getByRole('button', { name: '解析並填入表格' }).click();
    await expect(
      page.getByText('已解析，請檢查每列資料並預覽。', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '預覽並驗證' }).click();
    await expect(page.getByText('可建立', { exact: true })).toHaveCount(20);
    await page.getByRole('button', { name: '確認批量建立' }).click();
    await expect(
      page.getByText('成功：20 · 失敗：0；每列結果顯示於上方。', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: '查看案件' })).toHaveCount(20);
    await page.getByRole('button', { name: '開始下一批' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByLabel('貼上 Excel／Google Sheet 資料')
      .fill(`${prefix}-partial\t虛構成功戶\t桃園市\t\n\t虛構缺欄戶\t桃園市\t`);
    await page.getByRole('button', { name: '解析並填入表格' }).click();
    await expect(
      page.getByText('已解析，請檢查每列資料並預覽。', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '預覽並驗證' }).click();
    await expect(
      page.getByText('缺少代號、客戶姓名或地區', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '確認批量建立' }).click();
    await expect(
      page.getByText('成功：1 · 失敗：1；每列結果顯示於上方。', {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath('bulk-create-mobile.png'),
      fullPage: true,
    });
  });
  test('historical mode is explicit, creates assignments without outbound and supports desktop/mobile widths', async ({
    page,
  }, info) => {
    await page.goto('/cases');
    await signIn(page, 'phase8-admin@example.test');
    const created = await page.request.post(
      `${SERVER_URL}/rpc/collectors/create`,
      {
        data: {
          json: {
            displayName: '虛構歷史批量外收',
            code: `HISTORY-${Date.now()}`,
            isActive: true,
            userId: null,
          },
        },
      },
    );
    expect(created.status()).toBe(200);
    const collector = (await created.json()).json;
    await page.goto('/cases/bulk-create');
    await page
      .getByRole('button', { name: '歷史案件批量建檔', exact: true })
      .click();
    await expect(page.getByText(/Telegram outbound 為 0/)).toBeVisible();
    await page
      .getByLabel('貼上 Excel／Google Sheet 資料')
      .fill(
        Array.from(
          { length: 20 },
          (_, i) =>
            `HIST-${Date.now()}-${i}\t虛構歷史戶${i}\t新北市\t虛構街\t${collector.id}`,
        ).join('\n'),
      );
    await page.getByRole('button', { name: '解析並填入表格' }).click();
    await expect(
      page.getByText('已解析，請檢查每列資料並預覽。', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '預覽並驗證' }).click();
    await expect(page.getByText('可建立', { exact: true })).toHaveCount(20);
    await page.getByRole('button', { name: '確認批量建立' }).click();
    await expect(
      page.getByText('成功：20 · 失敗：0；每列結果顯示於上方。', {
        exact: true,
      }),
    ).toBeVisible();
    const first = page.getByRole('link', { name: '查看案件' }).first();
    await first.click();
    await page.getByRole('tab', { name: '派單紀錄', exact: true }).click();
    await expect(
      page.getByText('歷史補登', { exact: false }).first(),
    ).toBeVisible();
    for (const width of [375, 390, 430, 1366, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/cases/bulk-create');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.screenshot({
      path: info.outputPath('bulk-create-desktop.png'),
      fullPage: true,
    });
  });
  test('installment tracking shows latest report with valid assignment, filters, badge and six responsive widths', async ({
    page,
  }, info) => {
    await page.goto('/cases');
    await signIn(page, 'phase8-admin@example.test');
    const rpc = async (path: string, input: unknown) => {
      const r = await page.request.post(
        `${SERVER_URL}/rpc/${path.replaceAll('.', '/')}`,
        { data: { json: input } },
      );
      expect(r.status()).toBe(200);
      return (await r.json()).json;
    };
    const name = `虛構追蹤戶-${Date.now()}`;
    const created = await rpc('cases.create', {
      customerName: name,
      code: name,
      region: '桃園市',
      address: '虛構地址',
      amountDue: 0,
      status: 'installment',
      source: 'manual',
      revisitStatus: 'pending',
      revisitReason: '',
    });
    await configureCaseFinance(page, created.id);
    const detail = await rpc('cases.detail', { id: created.id });
    await rpc('reports.create', {
      caseId: created.id,
      expectedCaseVersion: detail.version,
      content: '家人說每月10號會處理',
      status: 'installment',
      revisitStatus: null,
      revisitReason: null,
      paymentDetected: false,
      paymentAmount: null,
    });
    await page.goto('/cases/installments');
    await expect(
      page.getByRole('heading', { name: '分期客追蹤', exact: true }),
    ).toBeVisible();
    await page.getByLabel('搜尋分期案件').fill(name);
    await page.getByLabel('分期地區').fill('桃園市');
    await expect(
      page.getByText('最新回報：家人說每月10號會處理'),
    ).toBeVisible();
    await expect(page.getByText('共 1 件', { exact: true })).toBeVisible();
    await expect(page.getByText('下次付款日', { exact: true })).toHaveCount(0);
    await expect(page.getByText('剩餘計畫金額', { exact: true })).toHaveCount(
      0,
    );
    for (const width of [375, 390, 430, 1366, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(
        page.getByRole('link', { name: '查看案件', exact: true }),
      ).toBeVisible();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: info.outputPath('tracking-mobile.png'),
      fullPage: true,
    });
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Taipei',
    });
    await rpc('finance.createPayment', {
      caseId: created.id,
      installmentScheduleId: null,
      idempotencyKey: crypto.randomUUID(),
      receivedDate: today,
      receivedAmount: 8000,
    });
    await page.reload();
    await page.getByLabel('搜尋分期案件').fill(name);
    await expect(page.getByText('共 1 件', { exact: true })).toBeVisible();
    const current = await rpc('cases.detail', { id: created.id });
    await rpc('cases.edit', {
      id: created.id,
      expectedVersion: current.version,
      customerName: current.customerName,
      code: current.code,
      address: current.address,
      amountDue: current.amountDue,
      region: current.region,
      status: 'unresolved',
      revisitStatus: current.revisitStatus,
      revisitReason: current.revisitReason,
    });
    await page.reload();
    await page.getByLabel('搜尋分期案件').fill(name);
    await expect(
      page.getByText('目前沒有符合條件的分期案件。', { exact: true }),
    ).toBeVisible();
  });
});
