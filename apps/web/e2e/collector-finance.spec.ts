import { expect, test } from '@playwright/test';
import { isRemote, SERVER_URL, signIn } from './auth-helpers';

test.describe('外收結算：虛構資料', () => {
  test.skip(isRemote, 'Local fictional data only');
  test.setTimeout(90000);
  test('回帳 snapshot、部分回帳、作廢、匯出與六種 responsive 尺寸', async ({
    page,
  }, info) => {
    await page.goto('/cases');
    await signIn(page, 'phase8-admin@example.test');
    async function rpc(method: string, input: unknown) {
      const response = await page.request.post(
        `${SERVER_URL}/rpc/${method.replaceAll('.', '/')}`,
        { data: { json: input } },
      );
      expect(response.status()).toBe(200);
      return (await response.json()).json;
    }
    try {
      const collector = await rpc('collectors.create', {
        displayName: '虛構財務驗收外收',
        code: `LEDGER-${Date.now()}`,
        isActive: true,
        userId: null,
      });
      for (const [kind, rate] of [['return', 0.5]] as const) {
        const settings = await rpc('collectorFinance.settings', {});
        await rpc('collectorFinance.setRate', {
          collectorId: collector.id,
          kind,
          rate,
          expectedVersion: settings.version,
        });
      }
      const code = `PAY-${Date.now()}`;
      const c = await rpc('cases.create', {
        customerName: '虛構財務驗收戶',
        code,
        address: '虛構地址',
        region: '桃園市',
        amountDue: 30000,
        status: 'pending',
        source: 'manual',
        revisitStatus: 'pending',
        revisitReason: '',
      });
      await rpc('cases.assign', {
        caseId: c.id,
        collectorId: collector.id,
        expectedVersion: 0,
        note: '',
      });
      await rpc('finance.createPayment', {
        caseId: c.id,
        idempotencyKey: crypto.randomUUID(),
        receivedAmount: 15000,
        receivedDate: '2026-09-22',
      });
      await page.goto('/cases/finance');
      await page.getByRole('button', { name: '外收帳務', exact: true }).click();
      const panel = page.getByRole('region', {
        name: '外收結算財報',
        exact: true,
      });
      await panel
        .getByLabel('外收人員', { exact: true })
        .first()
        .selectOption(collector.id);
      const payment = panel.getByRole('row').filter({ hasText: code });
      await expect(payment).toContainText('7,500');
      await expect(panel).not.toContainText('我的傭金');
      await panel.getByLabel('回帳金額', { exact: true }).fill('5000');
      await panel.getByLabel('回帳日期', { exact: true }).fill('2026-09-23');
      await panel.getByLabel('備註', { exact: true }).fill('虛構部分回帳');
      await panel
        .getByRole('button', { name: '新增回帳', exact: true })
        .click();
      await expect(
        panel.getByText('回帳已建立。', { exact: true }),
      ).toBeVisible();
      await expect(
        panel
          .getByLabel('財報總結')
          .locator('div')
          .filter({ hasText: '實際應回款' }),
      ).toContainText('2,500');
      await panel.getByRole('button', { name: '作廢', exact: true }).click();
      await panel.getByLabel('作廢原因', { exact: true }).fill('虛構驗收更正');
      await panel
        .getByRole('button', { name: '確認作廢', exact: true })
        .click();
      await expect(payment).toContainText('7,500');
      const downloadPromise = page.waitForEvent('download');
      await panel
        .getByRole('button', { name: '匯出外收結算明細', exact: true })
        .click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe('collector-settlements.xlsx');
      await download.saveAs(info.outputPath('collector-settlements.xlsx'));
      for (const width of [375, 390, 430, 1366, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(panel).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: info.outputPath('collector-finance-mobile.png'),
        fullPage: true,
      });
    } finally {
      // Test collectors and their versioned settings remain fictional fixtures.
    }
  });
  test('外收只看本人 financial snapshot，不能查他人、回帳或設定', async ({
    page,
    browser,
  }) => {
    await page.goto('/cases');
    await signIn(page, 'phase8-admin@example.test');
    const ownContext = await browser.newContext();
    try {
      const ownPage = await ownContext.newPage();
      const email = `finance-own-${Date.now()}@test.dev`;
      await ownPage.goto('http://localhost:3000/cases');
      await signIn(ownPage, email);
      const usersResponse = await page.request.post(
        `${SERVER_URL}/rpc/users/list`,
        { data: { json: {} } },
      );
      expect(usersResponse.status()).toBe(200);
      const users = (await usersResponse.json()).json as {
        id: string;
        email: string;
      }[];
      const userId = users.find((u) => u.email === email)?.id;
      expect(userId).toBeTruthy();
      async function rpc(method: string, input: unknown) {
        const r = await page.request.post(
          `${SERVER_URL}/rpc/${method.replaceAll('.', '/')}`,
          { data: { json: input } },
        );
        expect(r.status()).toBe(200);
        return (await r.json()).json;
      }
      const fixtures: { collectorId: string; code: string }[] = [];
      for (const index of [0, 1]) {
        const collector = await rpc('collectors.create', {
          displayName: `虛構財務外收${index}`,
          code: `OWN-${index}-${Date.now()}`,
          userId: index === 0 ? userId : null,
          isActive: true,
        });
        for (const [kind, rate] of [['return', 0.5]] as const) {
          const settings = await rpc('collectorFinance.settings', {});
          await rpc('collectorFinance.setRate', {
            collectorId: collector.id,
            kind,
            rate,
            expectedVersion: settings.version,
          });
        }
        const code = `SCOPE-${index}-${Date.now()}`;
        const c = await rpc('cases.create', {
          code,
          customerName: `虛構財務戶${index}`,
          address: '虛構測試地址',
          region: '桃園市',
          amountDue: 30000,
          status: 'pending',
          source: 'manual',
          revisitStatus: 'pending',
          revisitReason: '',
        });
        await rpc('cases.assign', {
          caseId: c.id,
          collectorId: collector.id,
          expectedVersion: 0,
          note: '',
        });
        await rpc('finance.createPayment', {
          caseId: c.id,
          idempotencyKey: crypto.randomUUID(),
          receivedAmount: 5000,
          receivedDate: '2026-09-22',
        });
        fixtures.push({ collectorId: collector.id, code });
      }
      await ownPage.goto('http://localhost:3000/cases/finance');
      await ownPage
        .getByRole('button', { name: '外收帳務', exact: true })
        .click();
      const panel = ownPage.getByRole('region', {
        name: '我的財務',
        exact: true,
      });
      await expect(panel).toContainText(fixtures[0].code);
      await expect(panel).not.toContainText(fixtures[1].code);
      await expect(
        panel.getByLabel('外收人員', { exact: true }).locator('option'),
      ).toHaveCount(2);
      await expect(
        panel.getByRole('button', { name: '新增回帳', exact: true }),
      ).toHaveCount(0);
      await expect(
        panel.getByRole('button', { name: '儲存傭金比例', exact: true }),
      ).toHaveCount(0);
      const denied = await ownPage.request.post(
        `${SERVER_URL}/rpc/collectorFinance/report`,
        { data: { json: { collectorId: fixtures[1].collectorId } } },
      );
      expect(denied.status()).toBe(403);
      await ownPage.setViewportSize({ width: 375, height: 812 });
      expect(
        await ownPage.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await ownContext.close();
    }
  });
});

test('外收獨立回帳設定新增、修改、停用確認與手機操作', async ({ page }) => {
  test.skip(isRemote, 'Local fictional data only');
  await page.goto('/cases');
  await signIn(page, 'phase8-admin@example.test');
  const displayName = `虛構比例設定${Date.now()}`;
  const response = await page.request.post(
    `${SERVER_URL}/rpc/collectors/create`,
    {
      data: {
        json: {
          displayName,
          code: `RATE-${Date.now()}`,
          isActive: true,
          userId: null,
        },
      },
    },
  );
  expect(response.status()).toBe(200);
  const collector = (await response.json()).json;
  await page.goto('/cases/finance');
  await page.getByRole('button', { name: '財務設定', exact: true }).click();
  const section = page.getByRole('region', { name: '財務設定', exact: true });
  await section
    .getByLabel('外收人員', { exact: true })
    .selectOption(collector.id);
  await section.getByLabel('回帳比例（%）').fill('60');
  await section.getByRole('button', { name: '儲存變更', exact: true }).click();
  const row = section
    .locator('div.rounded-lg')
    .filter({ hasText: displayName });
  await expect(row).toContainText('60.00%');
  await row.getByRole('button', { name: '修改', exact: true }).click();
  await section.getByLabel('回帳比例（%）').fill('50');
  await section.getByRole('button', { name: '儲存變更', exact: true }).click();
  await expect(row).toContainText('50.00%');
  await expect(section).not.toContainText('傭金');
  await page.setViewportSize({ width: 375, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await row.getByRole('button', { name: '刪除', exact: true }).click();
  const dialog = section.getByRole('alertdialog');
  await expect(dialog).toContainText('歷史財務紀錄不受影響');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '刪除', exact: true }).click();
  await dialog.getByRole('button', { name: '確認刪除', exact: true }).click();
  await expect(row).toHaveCount(0);
});
