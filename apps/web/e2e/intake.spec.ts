import { expect, test } from '@playwright/test';
import { isRemote, SERVER_URL, signIn } from './auth-helpers';

test('retired intake is absent from desktop/mobile navigation and rejects formal writes', async ({
  page,
}) => {
  test.skip(isRemote, 'Local fictional accounts only');
  await page.goto('/cases');
  await signIn(page, 'phase5-admin@example.test');
  await expect(
    page.getByRole('link', { name: '收件管理', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: '分期', exact: false }).first(),
  ).toBeVisible();
  await page.goto('/cases/intake');
  await expect(
    page.getByRole('heading', { name: '收件功能已停用' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '新增收件' })).toHaveCount(0);
  const receive = await page.request.post(`${SERVER_URL}/rpc/intake/receive`, {
    data: {
      json: {
        source: 'manual',
        proposedData: {
          code: 'RETIRED',
          customer_name: '虛構退役驗收戶',
          address: '虛構地址',
          amount_due: 0,
        },
      },
    },
  });
  expect(receive.status()).toBe(403);
  const extract = await page.request.post(
    `${SERVER_URL}/rpc/intake/extractImages`,
    { data: { json: { id: 'archived' } } },
  );
  expect(extract.status()).toBe(403);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/cases');
  await expect(
    page
      .getByRole('navigation', { name: '手機導覽' })
      .getByRole('link', { name: '收件' }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: '手機導覽' })
      .getByRole('link', { name: '分期' }),
  ).toBeVisible();
  await page.goto('/cases/telegram');
  await expect(
    page.getByRole('button', { name: '小幫手收件', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '外收派件群', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
