import { expect, test } from '@playwright/test';
import { isRemote, SERVER_URL, signIn } from './auth-helpers';

test('Telegram report remains pending in case history before manual status selection on mobile', async ({
  page,
}, info) => {
  test.skip(isRemote, 'Synthetic local Telegram only');
  await page.goto('/cases');
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, 'phase7-admin@example.test');
  await expect(
    page.getByRole('heading', { name: '案件管理', exact: true }),
  ).toBeVisible();
  const call = async (path: string, input: unknown) => {
    const r = await page.request.post(
      `${SERVER_URL}/rpc/${path.replaceAll('.', '/')}`,
      { data: { json: input } },
    );
    expect(r.status()).toBe(200);
    return (await r.json()).json;
  };
  const session = await page.request.get(`${SERVER_URL}/api/auth/get-session`);
  const userId = (await session.json()).user.id;
  const suffix = Date.now();
  const telegramId = String(suffix);
  const chatId = String(-suffix);
  const existingCollectors = await call('collectors.list', {});
  const collector =
    existingCollectors.find(
      (entry: { userId: string; isActive: boolean }) =>
        entry.userId === userId && entry.isActive,
    ) ??
    (await call('collectors.create', {
      displayName: 'Fictional phase seven collector',
      code: `C-${suffix}`,
      userId,
      isActive: true,
    }));
  const routes = await call('telegram.routes', {});
  const existingReportRoute = routes.find(
    (route: {
      id: string;
      collectorId: string;
      routeType: string;
      isActive: boolean;
    }) =>
      route.collectorId === collector.id &&
      route.routeType === 'collector_report' &&
      route.isActive,
  );
  await call('telegram.saveRoute', {
    id: existingReportRoute?.id,
    chatId,
    routeType: 'collector_report',
    collectorId: collector.id,
    topicId: null,
    isActive: true,
  });
  const row = await call('cases.create', {
    customerName: `Fictional pending report browser ${suffix}`,
    code: `R-${suffix}`,
    address: 'Fictional street',
    amountDue: 123,
    status: 'pending',
    source: 'manual',
    revisitStatus: 'pending',
    revisitReason: '',
  });
  const detail = await call('cases.detail', { id: row.id });
  await call('cases.assign', {
    caseId: row.id,
    collectorId: collector.id,
    expectedVersion: detail.version,
    note: 'Fictional test assignment',
  });
  await call('telegram.simulate', {
    update_id: suffix,
    message: {
      message_id: suffix,
      date: 1791400000,
      chat: { id: Number(chatId) },
      from: { id: Number(telegramId), is_bot: false },
      text: `/回報 Fictional pending report browser ${suffix}`,
    },
  });
  await call('telegram.process', {});
  await call('telegram.simulate', {
    update_id: suffix + 1,
    message: {
      message_id: suffix + 1,
      date: 1791400000,
      chat: { id: Number(chatId) },
      from: { id: Number(telegramId), is_bot: false },
      text: 'Fictional report content',
    },
  });
  await call('telegram.process', {});
  await page.goto(`/cases/${row.id}`);
  await page.getByRole('tab', { name: '回報紀錄', exact: true }).click();
  await expect(
    page.getByText('等待外收人員確認', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '編輯回報', exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('pending-report-mobile.png'),
    fullPage: true,
  });
});
