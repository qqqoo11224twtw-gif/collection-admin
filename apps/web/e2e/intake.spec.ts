import { expect, type Page, test } from '@playwright/test';
import { DEMO_IMAGES } from '../../../packages/db/src/demo-images';
import { isRemote, SERVER_URL, signIn } from './auth-helpers';

async function login(page: Page, email = 'phase5-admin@example.test') {
  await page.goto('/cases');
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, email);
  await expect(
    page.getByRole('link', { name: 'Intake inbox', exact: true }),
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
test.describe('Unified intake inbox', () => {
  test.skip(isRemote, 'Intake workflows are local and fictional');
  test('creates a draft, uploads private images, creates a case once and renders on mobile', async ({
    page,
  }, testInfo) => {
    await login(page);
    await page.getByRole('link', { name: 'Intake inbox', exact: true }).click();
    await page.getByRole('button', { name: 'New intake', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const suffix = String(Date.now());
    await dialog.getByLabel('Customer name').fill(`虛構接收測試 ${suffix}`);
    await dialog.getByLabel('Code', { exact: true }).fill(`INBOX-${suffix}`);
    await dialog
      .getByLabel('Address', { exact: true })
      .fill('虛構市接收路（非真實地址）');
    await dialog.getByLabel('Amount due (TWD)').fill('50000');
    await dialog.getByRole('button', { name: 'Save draft' }).click();
    await expect(dialog).toBeHidden();
    await page.getByLabel('Search intakes').fill(suffix);
    await page
      .getByRole('link', { name: `虛構接收測試 ${suffix}`, exact: true })
      .click();
    await expect(
      page.getByText('Not confirmed yet.', { exact: true }),
    ).toBeVisible();
    const intakeId = page.url().split('/').at(-1) ?? '';
    const file = {
      name: 'fictional-intake.png',
      mimeType: 'image/png',
      buffer: Buffer.from(DEMO_IMAGES[0].base64, 'base64'),
    };
    await page
      .getByLabel('PNG, JPEG or WebP · up to 5 images, 5 MiB each')
      .setInputFiles([file, { ...file, name: 'fictional-repeat.png' }]);
    await page.getByRole('button', { name: 'Upload images' }).click();
    await expect(
      page.getByText('fictional-intake.png', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Duplicate hash', { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole('img', { name: 'fictional-intake.png', exact: true }),
    ).toHaveAttribute('src', /^blob:/);
    await page
      .getByRole('button', { name: 'Create new case', exact: true })
      .click();
    await expect(page.getByText('created', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Promoted to case', { exact: true }),
    ).toHaveCount(2);
    await expect(page.getByText('Case created', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Images promoted', { exact: true }),
    ).toBeVisible();
    const detail = (await rpc(page, 'intake.detail', { id: intakeId })) as {
      matchedCaseId: string;
    };
    expect(
      (await rpc(page, 'intake.promote', { id: intakeId })).alreadyPromoted,
    ).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('intake-mobile.png'),
      fullPage: true,
    });
    await page.goto(`/cases/${detail.matchedCaseId}`);
    await page
      .getByRole('tab', { name: 'Outsourcing images', exact: true })
      .click();
    await expect(
      page.getByText('fictional-intake.png', { exact: true }),
    ).toBeVisible();
    await page.goto('/cases/intake');
    await page.getByLabel('Search intakes').fill(suffix);
    await page.getByLabel('Intake status').selectOption('created');
    await page.getByLabel('Intake source').selectOption('manual');
    await expect(
      page.getByRole('link', { name: `虛構接收測試 ${suffix}`, exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
  test('ambiguous intake chooses a stored candidate in review and does not overwrite case data', async ({
    page,
  }) => {
    await login(page);
    const suffix = String(Date.now());
    const base = {
      code: `AMB-${suffix}`,
      customerName: `虛構同名接收戶 ${suffix}`,
      address: '虛構同名地址',
      amountDue: 100,
      status: 'pending',
      source: 'manual',
      revisitStatus: 'pending',
      revisitReason: '',
    };
    await rpc(page, 'cases.create', base);
    const b = (await rpc(page, 'cases.create', base)) as {
      id: string;
      caseNo: string;
    };
    const item = (await rpc(page, 'intake.receive', {
      proposedData: {
        code: base.code,
        customer_name: base.customerName,
        address: base.address,
        amount_due: 99999,
      },
      source: 'api',
      externalId: `local-${suffix}`,
    })) as { id: string };
    await page.goto(`/cases/intake/${item.id}`);
    await expect(page.getByText(/^ambiguous · code/)).toBeVisible();
    await page
      .getByRole('button', { name: 'Analyze draft', exact: true })
      .click();
    await page
      .getByRole('link', { name: 'Human review · pending', exact: true })
      .click();
    await page.getByLabel('Candidate case').selectOption(b.id);
    await page
      .getByRole('button', { name: 'Approve proposal', exact: true })
      .click();
    await expect(page.getByText('approved', { exact: true })).toBeVisible();
    await page.goto(`/cases/intake/${item.id}`);
    await expect(page.getByText('matched', { exact: true })).toBeVisible();
    expect((await rpc(page, 'cases.detail', { id: b.id })).amountDue).toBe(100);
    expect(
      (await rpc(page, 'intake.detail', { id: item.id })).matchedCaseId,
    ).toBe(b.id);
  });
  test('collector saves an incomplete draft but cannot resolve, reject or impersonate an external source', async ({
    page,
  }) => {
    await login(page, 'phase5-collector@example.test');
    const item = (await rpc(page, 'intake.receive', {
      proposedData: {
        code: null,
        customer_name: '虛構外收草稿',
        address: null,
        amount_due: null,
      },
    })) as { id: string };
    await page.goto(`/cases/intake/${item.id}`);
    await expect(
      page.getByRole('button', { name: 'Analyze draft', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Reject intake', exact: true }),
    ).toHaveCount(0);
    const denied = await page.request.post(`${SERVER_URL}/rpc/intake/resolve`, {
      data: { json: { id: item.id, expectedVersion: 0, action: 'create' } },
    });
    expect(denied.status()).toBe(403);
    const external = await page.request.post(
      `${SERVER_URL}/rpc/intake/receive`,
      {
        data: {
          json: {
            source: 'telegram',
            proposedData: {
              code: null,
              customer_name: null,
              address: null,
              amount_due: null,
            },
          },
        },
      },
    );
    expect(external.status()).toBe(403);
  });
  test('incomplete extraction is corrected in review before a case is created', async ({
    page,
  }) => {
    await login(page);
    const item = (await rpc(page, 'intake.receive', {
      source: 'api',
      confidence: 0.2,
      proposedData: {
        code: null,
        customer_name: null,
        address: null,
        amount_due: null,
      },
    })) as { id: string };
    await page.goto(`/cases/intake/${item.id}`);
    await page
      .getByRole('button', { name: 'Analyze draft', exact: true })
      .click();
    await page
      .getByRole('link', { name: 'Human review · pending', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Approve proposal', exact: true }),
    ).toBeDisabled();
    const suffix = String(Date.now());
    await page.getByLabel('code', { exact: true }).fill(`CONFIRMED-${suffix}`);
    await page
      .getByLabel('customer name', { exact: true })
      .fill(`虛構補完整戶 ${suffix}`);
    await page
      .getByLabel('address', { exact: true })
      .fill('虛構市補完整路（非真實地址）');
    await page.getByLabel('amount due', { exact: true }).fill('4200');
    await page
      .getByRole('button', { name: 'Approve corrected values', exact: true })
      .click();
    await expect(page.getByText('corrected', { exact: true })).toBeVisible();
    expect((await rpc(page, 'intake.detail', { id: item.id })).status).toBe(
      'created',
    );
  });
});
