import { expect, test } from '@playwright/test';
import { isRemote, SERVER_URL, signIn } from './auth-helpers';

test('預繳回帳、作廢與手機版以有效 ledger 推導負數餘額', async ({ page }) => {
  test.skip(isRemote, 'Local fictional ledger only');
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
  const collector = await rpc('collectors.create', {
    displayName: `虛構預繳外收-${Date.now()}`,
    code: `CREDIT-${Date.now()}`,
    isActive: true,
    userId: null,
  });
  const date = new Date().toLocaleDateString('en-CA', {
    timeZone: 'Asia/Taipei',
  });
  await rpc('collectorFinance.createRemittance', {
    collectorId: collector.id,
    idempotencyKey: crypto.randomUUID(),
    amount: 20000,
    receivedDate: date,
    note: '虛構預繳驗收',
  });
  await page.goto('/cases/finance');
  await page.getByLabel('外收人員', { exact: true }).selectOption(collector.id);
  const summary = page.getByLabel('財報總結');
  await expect(summary).toContainText('20,000');
  const data = await rpc('collectorFinance.report', {
    collectorId: collector.id,
  });
  expect(data.summary).toMatchObject({
    actualReceived: 0,
    remitted: 20000,
    netReturnDue: -20000,
  });
  await page
    .getByRole('row')
    .filter({ hasText: '回帳' })
    .getByRole('button', { name: '作廢', exact: true })
    .click();
  await page.getByLabel('作廢原因', { exact: true }).fill('虛構預繳作廢');
  await page.getByRole('button', { name: '確認作廢', exact: true }).click();
  await expect(summary).not.toContainText('20,000');
  for (const width of [375, 390, 430, 1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  const result = await rpc('clearing.overview', { collectorId: collector.id });
  expect(result.summary.netReturnDue).toBe(0);
  expect(result.summary.actualReceived).toBe(0);
});
