import { expect, test } from '@playwright/test';
import { DEMO_IMAGES } from '../../../packages/db/src/demo-images';
import { isRemote, signIn } from './auth-helpers';

const adminEmail = 'phase2-admin@example.test';
async function login(page: import('@playwright/test').Page) {
  await page.goto('/cases');
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, adminEmail);
  await expect(
    page.getByRole('button', { name: '新增案件', exact: true }),
  ).toBeVisible();
}
async function newCase(page: import('@playwright/test').Page, code: string) {
  await page.getByRole('button', { name: '新增案件', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('地區', { exact: true }).selectOption('台北市');
  await dialog.getByLabel('客戶姓名').fill('虛構二階段測試戶');
  await dialog.getByLabel('代號', { exact: true }).fill(code);
  await dialog
    .getByLabel('地址', { exact: true })
    .fill('虛構市二階段測試路（非真實地址）');
  await dialog.getByLabel('應收款項（新臺幣）').fill('3200');
  await dialog.getByRole('button', { name: '新增案件', exact: true }).click();
  await expect(page).toHaveURL(/\/cases\/[a-f0-9-]+$/);
  await expect(page.getByRole('button', { name: '編輯案件' })).toBeVisible();
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
    await page.getByRole('button', { name: '編輯案件' }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('客戶姓名').fill('虛構更新測試戶');
    await editor.getByLabel('應收款項（新臺幣）').fill('4500');
    await editor.getByRole('button', { name: '儲存變更' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      '虛構更新測試戶',
    );
    await expect(
      page.getByText(caseNo ?? '', { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole('link', { name: '外收人員', exact: true }).click();
    for (const code of [`FIELD-A-${suffix}`, `FIELD-B-${suffix}`]) {
      await page.getByRole('button', { name: '新增外收人員' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('顯示名稱').fill(code);
      await dialog.getByLabel('外收人員代號').fill(code);
      await dialog.getByRole('button', { name: '儲存外收人員' }).click();
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
    await collector.getByRole('button', { name: '編輯外收人員' }).click();
    await page
      .getByRole('dialog')
      .getByLabel('顯示名稱')
      .fill(`Edited-A-${suffix}`);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '儲存外收人員' })
      .click();
    const edited = page.locator('article').filter({
      has: page.getByRole('heading', {
        name: `Edited-A-${suffix}`,
        exact: true,
      }),
    });
    await edited.getByRole('button', { name: '停用', exact: true }).click();
    await expect(edited.getByText('已停用', { exact: true })).toBeVisible();
    await edited.getByRole('button', { name: '啟用', exact: true }).click();
    await expect(edited.getByText('啟用中', { exact: true })).toBeVisible();
    await page.goto(caseUrl);
    await page.getByRole('tab', { name: '派單紀錄', exact: true }).click();
    await page.getByRole('button', { name: '指派案件', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('外收人員', { exact: true })
      .selectOption({ label: `Edited-A-${suffix} · FIELD-A-${suffix}` });
    await page
      .getByRole('dialog')
      .getByLabel('備註')
      .fill('Fictional first assignment');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '儲存派單' })
      .click();
    await expect(
      page.getByRole('tabpanel').getByText('目前有效', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '改派案件', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('外收人員', { exact: true })
      .selectOption({ label: `FIELD-B-${suffix} · FIELD-B-${suffix}` });
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '儲存派單' })
      .click();
    await expect(
      page.getByRole('tabpanel').getByText('已解除', { exact: true }),
    ).toHaveCount(1);
    await page.getByRole('button', { name: '改派案件', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('外收人員', { exact: true })
      .selectOption('');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '儲存派單' })
      .click();
    await expect(
      page.getByRole('tabpanel').getByText('已解除', { exact: true }),
    ).toHaveCount(2);
    await page.getByRole('tab', { name: '操作紀錄', exact: true }).click();
    for (const action of [
      '已建立案件',
      '已編輯案件',
      '已指派案件',
      '已改派案件',
      '已解除指派',
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
    await page.getByRole('tab', { name: '委外圖片' }).click();
    await page.getByLabel('上傳私人圖片', { exact: true }).setInputFiles([
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
    await page.getByRole('button', { name: '上傳圖片', exact: true }).click();
    await expect(page.locator('figure img')).toHaveCount(2);
    for (const image of await page.locator('figure img').all())
      await expect(image).toHaveAttribute('src', /^blob:/);
    await page
      .getByRole('button', { name: '向上移動 fictional-two.png', exact: true })
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
      .getByRole('button', { name: '刪除圖片', exact: true })
      .click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: '確認刪除' })
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
    await page.getByRole('tab', { name: '操作紀錄', exact: true }).click();
    for (const action of ['已上傳圖片', '已調整圖片排序', '已刪除圖片'])
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
    await expect(page.getByRole('button', { name: '編輯案件' })).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: '外收人員', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('tab', { name: '派單紀錄' }).click();
    await expect(page.getByText('目前有效', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '改派案件' })).toHaveCount(0);
    await page.getByRole('tab', { name: '委外圖片' }).click();
    await expect(page.getByLabel('上傳私人圖片')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '刪除圖片', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('tab', { name: '操作紀錄' })).toHaveCount(0);
    await page.goto('/cases/collectors');
    await expect(page.getByRole('alert')).toContainText('外收人員管理權限');
  });
});
