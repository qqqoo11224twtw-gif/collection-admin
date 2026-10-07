import { expect, type Page, test } from '@playwright/test';
import { isRemote, SERVER_URL, signIn } from './auth-helpers';

async function login(page: Page) {
  await page.goto('/cases');
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, 'phase4-admin@example.test');
  await expect(
    page.getByRole('button', { name: 'New case', exact: true }),
  ).toBeVisible();
}
async function rpc(page: Page, path: string, input: unknown) {
  const r = await page.request.post(
    `${SERVER_URL}/rpc/${path.replaceAll('.', '/')}`,
    { data: { json: input } },
  );
  expect(r.status()).toBe(200);
  return (await r.json()).json;
}
async function pending(page: Page, suffix: string) {
  const c = (await rpc(page, 'cases.create', {
    customerName: `虛構確認戶 ${suffix}`,
    code: `REVIEW-${suffix}`,
    address: '虛構確認路（非真實地址）',
    amountDue: 5000,
    status: 'pending',
    source: 'manual',
    revisitStatus: 'pending',
    revisitReason: '',
  })) as { id: string };
  await rpc(page, 'reports.create', {
    caseId: c.id,
    expectedCaseVersion: 0,
    content: `完全虛構的確認回報 ${suffix}`,
    status: 'needs_review',
    revisitStatus: 'observe',
    revisitReason: '虛構二訪',
    paymentDetected: false,
    paymentAmount: null,
  });
  return c.id;
}
const classification = {
  status: 'settled',
  revisit_status: 'not_needed',
  revisit_reason: null,
  payment_detected: true,
  payment_amount: 5000,
  confidence: 0.8,
};
test.describe('Unified review center', () => {
  test.skip(isRemote, 'Review workflows use local demo data only');
  test('filters pending items, corrects classification, updates the case and shows audit on mobile', async ({
    page,
  }, testInfo) => {
    await login(page);
    const suffix = String(Date.now());
    const caseId = await pending(page, suffix);
    await page.getByRole('link', { name: /Pending review/ }).click();
    await expect(
      page.getByRole('heading', { name: 'Review center', exact: true }),
    ).toBeVisible();
    await page.getByLabel('Search reviews').fill(suffix);
    await page.getByLabel('Review type').selectOption('report_classification');
    await page
      .getByRole('link', { name: 'Report classification', exact: true })
      .click();
    await expect(
      page.getByText(`完全虛構的確認回報 ${suffix}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Approve proposal', exact: true }),
    ).toBeDisabled();
    await page.getByLabel('Confirmed status').selectOption('installment');
    await page.getByLabel('Revisit recommendation').selectOption('recommended');
    await page
      .getByRole('button', { name: 'Approve corrected values', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Final confirmation' }),
    ).toBeVisible();
    await expect(page.getByText('corrected', { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('review-confirmed.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('review-mobile.png'),
      fullPage: true,
    });
    await page.goto(`/cases/${caseId}`);
    await expect(
      page.getByRole('tabpanel').getByText('Installment', { exact: true }),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Activity log', exact: true }).click();
    await expect(
      page.getByRole('tabpanel').getByText('Review corrected', { exact: true }),
    ).toBeVisible();
    await page.goto('/cases/reviews');
    await page.getByLabel('Review status').selectOption('corrected');
    await page.getByLabel('Search reviews').fill(suffix);
    await expect(
      page.getByRole('link', { name: 'Report classification', exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
  test('approves a proposal, rejects another, and edits image fields before confirmation', async ({
    page,
  }) => {
    await login(page);
    const suffix = String(Date.now());
    const caseId = await pending(page, suffix);
    const rows = (await rpc(page, 'reports.list', { id: caseId })) as {
      id: string;
    }[];
    const r = (await rpc(page, 'reviews.create', {
      reviewType: 'report_classification',
      reportId: rows[0].id,
      classification,
      reason: '完全虛構的分類提案',
      confidence: 0.8,
    })) as { id: string };
    await page.goto(`/cases/reviews/${r.id}`);
    await page
      .getByRole('button', { name: 'Approve proposal', exact: true })
      .click();
    await expect(page.getByText('approved', { exact: true })).toBeVisible();
    const rejectedCase = await pending(page, `${suffix}-reject`);
    const pendingRows = (await rpc(page, 'reviews.list', {
      query: `${suffix}-reject`,
    })) as { items: { id: string }[] };
    await page.goto(`/cases/reviews/${pendingRows.items[0].id}`);
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(
      page.getByText('Rejected. Case data was not changed.', { exact: true }),
    ).toBeVisible();
    expect((await rpc(page, 'cases.detail', { id: rejectedCase })).status).toBe(
      'pending',
    );
    const image = (await rpc(page, 'reviews.create', {
      reviewType: 'image_extraction',
      caseId,
      extraction: {
        code: 'VIRTUAL-IMAGE',
        customer_name: '虛構圖片戶',
        address: '非真實圖片地址',
        amount_due: 50000,
      },
      reason: '完全虛構的圖片欄位提案',
    })) as { id: string };
    await page.goto(`/cases/reviews/${image.id}`);
    await page.getByLabel('amount due', { exact: true }).fill('40000');
    await page
      .getByRole('button', { name: 'Approve corrected values', exact: true })
      .click();
    await expect(page.getByText('40000', { exact: true })).toBeVisible();
    await expect(page.getByText('50000', { exact: true })).toBeVisible();
    expect((await rpc(page, 'cases.detail', { id: caseId })).amountDue).toBe(
      40000,
    );
  });
  test('ordinary users cannot access or resolve reviews', async ({ page }) => {
    await page.goto('/cases');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, 'phase4-user@example.test');
    await expect(
      page.getByRole('link', { name: 'API keys', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: /Pending review/ }),
    ).toHaveCount(0);
    await page.goto('/cases/reviews');
    await expect(
      page.getByText('You do not have access to the review center.', {
        exact: true,
      }),
    ).toBeVisible();
    const response = await page.request.post(
      `${SERVER_URL}/rpc/reviews/resolve`,
      { data: { json: { id: 'forged-review', decision: 'approved' } } },
    );
    expect(response.status()).toBe(403);
  });
});
