import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isRemote, SERVER_URL, signIn } from './auth-helpers';

test('簡化財報：5000 實收、1000 後結、1500 回帳得到零，含 mobile 與匯出', async ({
  page,
}, info) => {
  test.skip(isRemote, 'Only local fictional SQL fixtures');
  test.setTimeout(90000);
  await page.goto('/cases');
  await signIn(page, 'phase8-admin@example.test');
  async function rpc(method: string, input: unknown) {
    const r = await page.request.post(
      `${SERVER_URL}/rpc/${method.replaceAll('.', '/')}`,
      { data: { json: input } },
    );
    expect(r.status()).toBe(200);
    return (await r.json()).json;
  }
  const session = await page.request.get(`${SERVER_URL}/api/auth/get-session`);
  const actor = (await session.json()).user.id;
  const collector = await rpc('collectors.create', {
    displayName: '虛構後結畫面外收',
    code: `DIRECT-${Date.now()}`,
    isActive: true,
    userId: null,
  });
  const code = `D-${Date.now()}`;
  const row = await rpc('cases.create', {
    code,
    customerName: '虛構後結畫面客戶',
    region: '桃園市',
    address: '虛構地址',
    amountDue: 50000,
    status: 'pending',
    source: 'manual',
    revisitStatus: 'pending',
    revisitReason: '',
  });
  await rpc('cases.assign', {
    caseId: row.id,
    collectorId: collector.id,
    expectedVersion: 0,
    note: '',
  });
  const settings = await rpc('collectorFinance.settings', {});
  await rpc('collectorFinance.setRate', {
    collectorId: collector.id,
    kind: 'return',
    rate: 0.5,
    expectedVersion: settings.version,
  });
  await rpc('finance.createPayment', {
    caseId: row.id,
    idempotencyKey: randomUUID(),
    receivedAmount: 5000,
    receivedDate: '2026-09-10',
  });
  const payment = randomUUID(),
    settlement = randomUUID(),
    offset = randomUUID(),
    now = Date.now();
  for (const id of [actor, collector.id, row.id])
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  const file = new URL(
    '../../server/.wrangler/direct-ledger-fixture.sql',
    import.meta.url,
  );
  writeFileSync(
    file,
    `INSERT INTO payments(id,idempotency_key,case_id,collector_id,received_date,received_amount,status,source,created_by_user_id,created_at,updated_at,channel) VALUES('${payment}','${randomUUID()}','${row.id}','${collector.id}','2026-10-10',2000,'received','admin','${actor}',${now},${now},'direct_to_principal');
  INSERT INTO settlements(id,payment_id,case_id,collector_id,received_date,agent_code_snapshot,customer_name_snapshot,received_amount,commission_rate,commission_amount,return_amount,created_at,updated_at,admin_commission_rate,admin_commission_amount,collector_return_rate_snapshot,admin_commission_rate_snapshot) VALUES('${settlement}','${payment}','${row.id}','${collector.id}','2026-10-10','${code}','虛構後結畫面客戶',2000,0.5,1000,1000,${now},${now},0.2,200,0.5,0.2);
  INSERT INTO collector_offsets(id,source_payment_id,collector_id,amount,admin_commission_rate,admin_commission_amount,created_by_user_id,created_at) VALUES('${offset}','${payment}','${collector.id}',1000,0.2,200,'${actor}',${now});`,
  );
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          '../../../node_modules/wrangler/bin/wrangler.js',
          import.meta.url,
        ),
      ),
      'd1',
      'execute',
      'starter-local-db',
      '--local',
      '--config',
      'wrangler.local.jsonc',
      '--file',
      fileURLToPath(file),
    ],
    {
      cwd: fileURLToPath(new URL('../../server/', import.meta.url)),
      stdio: 'pipe',
      windowsHide: true,
    },
  );
  await page.goto('/cases/finance');
  await page.getByRole('button', { name: '外收帳務', exact: true }).click();
  const panel = page.getByRole('region', { name: '外收結算財報', exact: true });
  await panel
    .getByLabel('外收人員', { exact: true })
    .first()
    .selectOption(collector.id);
  const rowElement = panel
    .getByRole('row')
    .filter({ hasText: code })
    .filter({ has: page.getByRole('button', { name: '作廢', exact: true }) });
  await expect(rowElement).toContainText('後結');
  await expect(rowElement).toContainText('1,000');
  await panel.getByLabel('回帳金額', { exact: true }).fill('1500');
  await panel.getByLabel('回帳日期', { exact: true }).fill('2026-10-10');
  await panel.getByLabel('備註', { exact: true }).fill('虛構銀行轉帳');
  await panel.getByRole('button', { name: '新增回帳', exact: true }).click();
  await expect(panel.getByText('回帳已建立。', { exact: true })).toBeVisible();
  const response = await rpc('collectorFinance.report', {
    collectorId: collector.id,
  });
  expect(response.summary).toMatchObject({
    actualReceived: 5000,
    returnDue: 2500,
    offset: 1000,
    remitted: 1500,
    netReturnDue: 0,
  });
  expect(
    response.items.find((item: { type: string }) => item.type === 'offset'),
  ).toMatchObject({
    actual_received: 0,
    return_due: -1000,
    marker: '後結',
  });
  expect(JSON.stringify(response)).not.toMatch(/commission|credit/);
  await expect(panel).not.toContainText('我的傭金');
  await expect(panel).not.toContainText('可領餘額');
  await expect(panel.getByRole('columnheader')).toHaveCount(6);
  await page.screenshot({
    path: info.outputPath('simple-finance-desktop.png'),
    fullPage: true,
  });
  const download = page.waitForEvent('download');
  await panel
    .getByRole('button', { name: '匯出外收結算明細', exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe(
    'collector-settlements.xlsx',
  );
  for (const width of [375, 390, 430, 1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: info.outputPath('direct-ledger-mobile.png'),
    fullPage: true,
  });
  const customer = await rpc('finance.payments', { id: row.id });
  expect(
    customer.find(
      (item: { channel: string }) => item.channel === 'direct_to_principal',
    ),
  ).toMatchObject({
    channel: 'direct_to_principal',
    receivedAmount: 2000,
  });
});
