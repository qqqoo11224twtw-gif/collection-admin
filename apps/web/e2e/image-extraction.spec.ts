import { expect, test } from '@playwright/test';
import { DEMO_IMAGES } from '../../../packages/db/src/demo-images';
import { isRemote, SERVER_URL, signIn } from './auth-helpers';

test('Telegram report remains pending in case history before manual status selection on mobile', async ({
  page,
}, info) => {
  test.skip(isRemote, 'Synthetic local Telegram only');
  await page.goto('/cases');
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, 'phase7-admin@example.test');
  await expect(
    page.getByRole('link', { name: '收件管理', exact: true }),
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
    customerName: 'Fictional pending report browser',
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
      text: `/回報 R-${suffix} Fictional report content`,
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

test('fake extraction preserves original draft, requires human review and renders private images on mobile', async ({
  page,
}, info) => {
  test.skip(isRemote, 'Synthetic local extraction only');
  await page.goto('/cases');
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, 'phase7-admin@example.test');
  await expect(
    page.getByRole('link', { name: '收件管理', exact: true }),
  ).toBeVisible();
  const receive = await page.request.post(`${SERVER_URL}/rpc/intake/receive`, {
    data: {
      json: {
        source: 'telegram',
        proposedData: {
          code: `FAKE-${Date.now()}`,
          customer_name: 'Fictional extraction browser',
          address: 'Fictional street',
          amount_due: 50000,
        },
      },
    },
  });
  expect(receive.status()).toBe(200);
  const id = (await receive.json()).json.id;
  await page.goto(`/cases/intake/${id}`);
  await page
    .getByLabel('支援 PNG、JPEG 或 WebP · 最多 5 張 · 每張上限 5 MiB')
    .setInputFiles({
      name: 'fictional-extraction.png',
      mimeType: 'image/png',
      buffer: Buffer.from(DEMO_IMAGES[0].base64, 'base64'),
    });
  await page.getByRole('button', { name: '上傳圖片' }).click();
  await expect(
    page.getByRole('img', { name: 'fictional-extraction.png', exact: true }),
  ).toHaveAttribute('src', /^blob:/);
  await page.getByRole('button', { name: '辨識圖片欄位' }).click();
  await expect(page.getByText('需要人工確認', { exact: false })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByText('信心值： 0%', { exact: false })).toBeVisible();
  const detail = await page.request.post(`${SERVER_URL}/rpc/intake/detail`, {
    data: { json: { id } },
  });
  const row = (await detail.json()).json;
  expect(row.status).toBe('needs_review');
  expect(row.matchedCaseId).toBeNull();
  expect(row.receivedData.customer_name).toBe('Fictional extraction browser');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('extraction-mobile.png'),
    fullPage: true,
  });
});
