import { expect, type Page, test } from '@playwright/test';
import { isRemote, SERVER_URL, signIn } from './auth-helpers';

async function rpc<T>(page: Page, path: string, input?: unknown): Promise<T> {
  const response = await page.request.post(
    `${SERVER_URL}/rpc/${path.replaceAll('.', '/')}`,
    { data: { json: input } },
  );
  expect(response.status()).toBe(200);
  return ((await response.json()) as { json: T }).json;
}
async function fixtures(page: Page, count: number) {
  const prefix = `BATCH-${Date.now()}`;
  const collector = await rpc<{ id: string }>(page, 'collectors.create', {
    displayName: `Fictional bulk ${prefix}`,
    code: prefix,
    isActive: true,
    userId: null,
  });
  await rpc(page, 'telegram.saveRoute', {
    collectorId: collector.id,
    chatId: `-${Date.now()}`,
    topicId: 62,
    routeType: 'collector',
    isActive: true,
  });
  const cases: { id: string; caseNo: string }[] = [];
  for (let i = 0; i < count; i++)
    cases.push(
      await rpc(page, 'cases.create', {
        customerName: `Fictional batch ${prefix} ${i}`,
        code: `${prefix}-${i}`,
        address: 'Fictional address',
        amountDue: 1000,
        status: 'pending',
        source: 'manual',
        region: '桃園市',
        revisitStatus: 'pending',
        revisitReason: '',
      }),
    );
  await rpc(page, 'cases.create', {
    customerName: `Outside ${prefix}`,
    code: `${prefix}-outside`,
    address: 'Fictional address',
    amountDue: 1000,
    status: 'pending',
    source: 'manual',
    region: '台北市',
    revisitStatus: 'pending',
    revisitReason: '',
  });
  return { prefix, collector, cases };
}
test.describe('Bulk regional assignment', () => {
  test.skip(isRemote, 'Fictional local data only');
  test('region + unassigned, multiple rows, current-page selection, concurrent conflict and individual jobs', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, 'phase8-admin@example.test');
    await expect(
      page.getByRole('heading', { name: '案件管理', exact: true }),
    ).toBeVisible();
    const { prefix, collector, cases } = await fixtures(page, 12);
    await page.goto('/cases/regions');
    await page
      .locator('article')
      .filter({
        has: page.getByRole('heading', { name: '桃園市', exact: true }),
      })
      .getByRole('link', { name: '未委外案件' })
      .click();
    await expect(page.getByLabel('地區')).toHaveValue('桃園市');
    await expect(page.getByLabel('委外狀態')).toHaveValue('unassigned');
    await page.getByLabel('搜尋案件').fill(prefix);
    await expect(page.locator('tbody tr')).toHaveCount(10);
    await expect(page.getByText(/12 筆案件 · 第 1 ／ 2/)).toBeVisible();
    const rows = page.locator('tbody tr');
    await rows.nth(0).getByRole('checkbox').check();
    await rows.nth(1).getByRole('checkbox').check();
    await expect(page.getByRole('status', { name: '已選案件' })).toContainText(
      '已選擇： 2 筆案件',
    );
    await page
      .getByRole('checkbox', { name: '全選目前頁面', exact: true })
      .check();
    await expect(page.getByRole('status', { name: '已選案件' })).toContainText(
      '已選擇： 10 筆案件',
    );
    const pageIds = await rows
      .locator('a')
      .evaluateAll((links) => [
        ...new Set(
          links
            .map((link) => link.getAttribute('href')?.split('/').at(-1))
            .filter(Boolean),
        ),
      ]);
    expect(pageIds).toHaveLength(10);
    await page.getByRole('button', { name: '下一頁' }).click();
    await expect(page.getByRole('status', { name: '已選案件' })).toContainText(
      '已選擇： 0 筆案件',
    );
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await page.getByRole('button', { name: '上一頁' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(10);
    await page
      .getByRole('checkbox', { name: '全選目前頁面', exact: true })
      .check();
    await page.getByRole('button', { name: '批量派單', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('已選擇： 10 筆案件');
    await dialog
      .getByLabel('外收人員', { exact: true })
      .selectOption(collector.id);
    await expect(dialog).toContainText(`外收人員： Fictional bulk ${prefix}`);
    const stolen = cases.find((c) => pageIds.includes(c.id));
    expect(stolen).toBeDefined();
    await rpc(page, 'cases.assign', {
      caseId: stolen?.id,
      collectorId: collector.id,
      expectedVersion: 0,
      note: 'Assigned concurrently by another manager',
    });
    const response = page.waitForResponse((r) =>
      r.url().endsWith('/rpc/cases/bulkAssign'),
    );
    await dialog.getByRole('button', { name: '確認派單', exact: true }).click();
    const output = (
      (await (await response).json()) as {
        json: {
          batchId: string;
          items: {
            caseId: string;
            status: string;
            assignmentId: string;
            outboundJobId: string;
          }[];
        };
      }
    ).json;
    await expect(
      dialog.getByRole('heading', { name: '批量派單完成' }),
    ).toBeVisible();
    await expect(dialog.getByText('成功： 9', { exact: true })).toBeVisible();
    await expect(dialog.getByText('略過： 1', { exact: true })).toBeVisible();
    await expect(dialog.getByText('已由其他管理員派單')).toBeVisible();
    await expect(
      dialog.getByRole('list', { name: '各案件派單結果' }).locator('li'),
    ).toHaveCount(10);
    const assigned = output.items.filter((item) => item.status === 'assigned');
    expect(new Set(assigned.map((i) => i.assignmentId)).size).toBe(9);
    expect(new Set(assigned.map((i) => i.outboundJobId)).size).toBe(9);
    for (const item of assigned) {
      const assignments = await rpc<
        { id: string; unassignedAt: string | null }[]
      >(page, 'cases.assignments', { id: item.caseId });
      expect(assignments.filter((a) => !a.unassignedAt)).toHaveLength(1);
      expect(assignments[0].id).toBe(item.assignmentId);
    }
    await rpc(page, 'telegram.process');
    await expect(
      dialog.getByText('Telegram 已傳送： 9', { exact: true }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(2);
  });
  test('mobile selection, cancel without writes, confirmation and result layout', async ({
    page,
  }, info) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, 'phase8-admin@example.test');
    await expect(
      page.getByRole('heading', { name: '案件管理', exact: true }),
    ).toBeVisible();
    const { prefix, collector } = await fixtures(page, 3);
    await page.getByLabel('地區').selectOption('桃園市');
    await page.getByLabel('委外狀態').selectOption('unassigned');
    await page.getByLabel('搜尋案件').fill(prefix);
    await expect(page.locator('tbody tr')).toHaveCount(3);
    await page
      .getByRole('checkbox', { name: '全選目前頁面', exact: true })
      .check();
    await expect(page.getByRole('status', { name: '已選案件' })).toContainText(
      '已選擇： 3 筆案件',
    );
    await page.getByRole('button', { name: '批量派單', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByLabel('外收人員', { exact: true })
      .selectOption(collector.id);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('tbody tr')).toHaveCount(3);
    await page.getByRole('button', { name: '批量派單', exact: true }).click();
    await dialog
      .getByLabel('外收人員', { exact: true })
      .selectOption(collector.id);
    await page.screenshot({
      path: info.outputPath('bulk-assignment-mobile-dialog.png'),
      fullPage: true,
    });
    await dialog.getByRole('button', { name: '確認派單', exact: true }).click();
    await expect(dialog.getByText('成功： 3', { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath('bulk-assignment-mobile-result.png'),
      fullPage: true,
    });
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '找不到案件', exact: true }),
    ).toBeVisible();
  });
  test('ordinary users have no selection controls and backend denies bulk assignment', async ({
    page,
  }) => {
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, `bulk-user-${Date.now()}@example.test`);
    await expect(
      page.getByRole('heading', { name: '案件管理', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '批量派單', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('checkbox', { name: '全選目前頁面', exact: true }),
    ).toHaveCount(0);
    const denied = await page.request.post(
      `${SERVER_URL}/rpc/cases/bulkAssign`,
      {
        data: {
          json: {
            batchId: crypto.randomUUID(),
            collectorId: 'unknown',
            caseIds: ['unknown'],
          },
        },
      },
    );
    expect(denied.status()).toBe(403);
  });
});
