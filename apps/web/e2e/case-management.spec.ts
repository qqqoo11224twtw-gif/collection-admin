import { expect, test } from '@playwright/test';
import { DEMO_IMAGES } from '../../../packages/db/src/demo-images';
import { isRemote, signIn } from './auth-helpers';

const adminEmail = 'phase2-admin@example.test';
async function login(page: import('@playwright/test').Page) {
  await page.goto('/cases');
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, adminEmail);
  await expect(
    page.getByRole('button', { name: 'New case', exact: true }),
  ).toBeVisible();
}
async function newCase(page: import('@playwright/test').Page, code: string) {
  await page.getByRole('button', { name: 'New case', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Region', { exact: true }).selectOption('台北市');
  await dialog.getByLabel('Customer name').fill('虛構二階段測試戶');
  await dialog.getByLabel('Code', { exact: true }).fill(code);
  await dialog
    .getByLabel('Address', { exact: true })
    .fill('虛構市二階段測試路（非真實地址）');
  await dialog.getByLabel('Amount due (TWD)').fill('3200');
  await dialog
    .getByRole('button', { name: 'Create case', exact: true })
    .click();
  await expect(page).toHaveURL(/\/cases\/[a-f0-9-]+$/);
  await expect(page.getByRole('button', { name: 'Edit case' })).toBeVisible();
}
test.describe('Local phase-two management', () => {
  test.skip(isRemote, 'Management workflows use local fictional data only');
  test('creates and edits a case, manages collectors, assigns/reassigns/unassigns and audits', async ({
    page,
  }, testInfo) => {
    await login(page);
    const suffix = String(Date.now());
    await newCase(page, `PHASE2-${suffix}`);
    const caseUrl = page.url();
    const caseNo = await page
      .getByText(/^CASE-\d{8}-/)
      .first()
      .textContent();
    await page.getByRole('button', { name: 'Edit case' }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Customer name').fill('虛構更新測試戶');
    await editor.getByLabel('Amount due (TWD)').fill('4500');
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      '虛構更新測試戶',
    );
    await expect(
      page.getByText(caseNo ?? '', { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Collectors', exact: true }).click();
    for (const code of [`FIELD-A-${suffix}`, `FIELD-B-${suffix}`]) {
      await page.getByRole('button', { name: 'New collector' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Display name').fill(code);
      await dialog.getByLabel('Collector code').fill(code);
      await dialog.getByRole('button', { name: 'Save collector' }).click();
      await expect(
        page.getByRole('heading', { name: code, exact: true }),
      ).toBeVisible();
    }
    const collector = page.locator('article').filter({
      has: page.getByRole('heading', {
        name: `FIELD-A-${suffix}`,
        exact: true,
      }),
    });
    await collector.getByRole('button', { name: 'Edit collector' }).click();
    await page
      .getByRole('dialog')
      .getByLabel('Display name')
      .fill(`Edited-A-${suffix}`);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Save collector' })
      .click();
    const edited = page.locator('article').filter({
      has: page.getByRole('heading', {
        name: `Edited-A-${suffix}`,
        exact: true,
      }),
    });
    await edited
      .getByRole('button', { name: 'Deactivate', exact: true })
      .click();
    await expect(edited.getByText('Inactive', { exact: true })).toBeVisible();
    await edited.getByRole('button', { name: 'Activate', exact: true }).click();
    await expect(edited.getByText('Active', { exact: true })).toBeVisible();
    await page.goto(caseUrl);
    await page
      .getByRole('tab', { name: 'Assignment history', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Assign case', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByLabel('Collector', { exact: true })
      .selectOption({ label: `Edited-A-${suffix} · FIELD-A-${suffix}` });
    await page
      .getByRole('dialog')
      .getByLabel('Note')
      .fill('Fictional first assignment');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Save assignment' })
      .click();
    await expect(
      page.getByRole('tabpanel').getByText('Current', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Change assignment', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByLabel('Collector', { exact: true })
      .selectOption({ label: `FIELD-B-${suffix} · FIELD-B-${suffix}` });
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Save assignment' })
      .click();
    await expect(
      page.getByRole('tabpanel').getByText('Ended', { exact: true }),
    ).toHaveCount(1);
    await page
      .getByRole('button', { name: 'Change assignment', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByLabel('Collector', { exact: true })
      .selectOption('');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Save assignment' })
      .click();
    await expect(
      page.getByRole('tabpanel').getByText('Ended', { exact: true }),
    ).toHaveCount(2);
    await page.getByRole('tab', { name: 'Activity log', exact: true }).click();
    for (const action of [
      'Case created',
      'Case edited',
      'Case assigned',
      'Case reassigned',
      'Assignment removed',
    ])
      await expect(
        page.getByRole('tabpanel').getByText(action, { exact: true }),
      ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('phase-two-audit.png'),
      fullPage: true,
    });
  });
  test('uploads multiple private images, reorders, deletes and records events', async ({
    page,
  }, testInfo) => {
    await login(page);
    await newCase(page, `PHASE2-MEDIA-${Date.now()}`);
    const caseId = page.url().split('/').at(-1);
    await page.getByRole('tab', { name: 'Outsourcing images' }).click();
    await page
      .getByLabel('Upload private images', { exact: true })
      .setInputFiles([
        {
          name: 'fictional-one.png',
          mimeType: 'image/png',
          buffer: Buffer.from(DEMO_IMAGES[0].base64, 'base64'),
        },
        {
          name: 'fictional-two.png',
          mimeType: 'image/png',
          buffer: Buffer.from(DEMO_IMAGES[1].base64, 'base64'),
        },
      ]);
    await page
      .getByRole('button', { name: 'Upload images', exact: true })
      .click();
    await expect(page.locator('figure img')).toHaveCount(2);
    for (const image of await page.locator('figure img').all())
      await expect(image).toHaveAttribute('src', /^blob:/);
    await page
      .getByRole('button', { name: 'Move up fictional-two.png', exact: true })
      .click();
    await expect(page.locator('figure').first()).toContainText(
      'fictional-two.png',
    );
    const metadata = await page.request.post(
      'http://localhost:4000/rpc/cases/media',
      { data: { json: { id: caseId } } },
    );
    const { json: rows } = (await metadata.json()) as {
      json: { id: string; originalFilename: string }[];
    };
    const deletedId = rows.find(
      (row) => row.originalFilename === 'fictional-one.png',
    )?.id;
    await page
      .locator('figure')
      .filter({ hasText: 'fictional-one.png' })
      .getByRole('button', { name: 'Delete image', exact: true })
      .click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Confirm delete' })
      .click();
    await expect(page.locator('figure img')).toHaveCount(1);
    expect(
      (
        await page.request.get(
          `http://localhost:4000/api/cases/${caseId}/media/${deletedId}/image`,
        )
      ).status(),
    ).toBe(404);
    await page.screenshot({
      path: testInfo.outputPath('phase-two-images.png'),
      fullPage: true,
    });
    await page.getByRole('tab', { name: 'Activity log', exact: true }).click();
    for (const action of [
      'Images uploaded',
      'Images reordered',
      'Image deleted',
    ])
      await expect(
        page.getByRole('tabpanel').getByText(action, { exact: true }),
      ).toBeVisible();
  });
  test('ordinary collector sees assignments but no management or upload controls', async ({
    page,
  }) => {
    await page.goto('/cases/demo-case-001');
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, 'agent@example.test');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit case' })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('link', { name: 'Collectors', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('tab', { name: 'Assignment history' }).click();
    await expect(page.getByText('Current', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Change assignment' }),
    ).toHaveCount(0);
    await page.getByRole('tab', { name: 'Outsourcing images' }).click();
    await expect(page.getByLabel('Upload private images')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Delete image', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Activity log' })).toHaveCount(
      0,
    );
    await page.goto('/cases/collectors');
    await expect(page.getByRole('alert')).toContainText(
      'permission to manage collectors',
    );
  });
});
