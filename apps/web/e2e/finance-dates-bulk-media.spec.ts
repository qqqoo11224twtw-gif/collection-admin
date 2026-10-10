import { expect, test } from '@playwright/test';
import { financePeriod } from '@saasflare-dev/api/business-dates';
import { DEMO_IMAGES } from '../../../packages/db/src/demo-images';
import { isRemote, SERVER_URL, signIn } from './auth-helpers';

test.describe('財務日期與批量獨立圖片', () => {
  test.skip(isRemote, 'Local fictional fixtures only');
  test.setTimeout(180000);
  test('date presets immediately update queries and custom range remains available on mobile', async ({
    page,
  }) => {
    await page.goto('/cases');
    await signIn(page, 'phase8-admin@example.test');
    await page.goto('/cases/finance');
    await page.getByRole('button', { name: '外收帳務', exact: true }).click();
    const response = await page.request.post(
      `${SERVER_URL}/rpc/clearing/overview`,
      { data: { json: {} } },
    );
    const today = (await response.json()).json.businessDate;
    for (const [label, period] of [
      ['今天', 'today'],
      ['本月', 'month'],
      ['上個月', 'previous'],
    ] as const) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const range = financePeriod(period, today);
      await expect(
        page.getByText(`目前期間：${range.dateFrom} ～ ${range.dateTo}`),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: label, exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
    }
    await page.getByRole('button', { name: '自訂', exact: true }).click();
    await page.getByLabel('開始日期').fill('2026-01-01');
    await page.getByLabel('結束日期').fill('2026-12-31');
    await expect(
      page.getByText('目前期間：2026-01-01 ～ 2026-12-31'),
    ).toBeVisible();
    for (const width of [375, 390, 430, 1366, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  });
  test('three cards keep different media private and retry only a failed image without recreating cases', async ({
    page,
  }) => {
    await page.goto('/cases');
    await signIn(page, 'phase8-admin@example.test');
    await page.goto('/cases/bulk-create');
    await page
      .getByRole('button', { name: '新案件批量建檔', exact: true })
      .click();
    const prefix = `MEDIA-${Date.now()}`;
    await page
      .getByLabel('貼上 Excel／Google Sheet 資料')
      .fill(
        [0, 1, 2]
          .map((i) => `${prefix}-${i}\t虛構附圖${i}\t桃園市\t虛構地址`)
          .join('\n'),
      );
    await page.getByRole('button', { name: '解析並填入表格' }).click();
    for (const [index, count] of [1, 5, 2].entries()) {
      const files = Array.from({ length: count }, (_, n) => ({
        name: `row-${index}-${n}.png`,
        mimeType: 'image/png',
        buffer: Buffer.from(
          DEMO_IMAGES[index % DEMO_IMAGES.length].base64,
          'base64',
        ),
      }));
      await page
        .getByLabel(`第 ${index + 1} 筆選擇圖片`, { exact: true })
        .setInputFiles(files);
    }
    const first = page.getByRole('region', {
      name: '第 1 筆案件圖片',
      exact: true,
    });
    await first.getByRole('button', { name: '移除', exact: true }).click();
    await page.getByLabel('第 1 筆選擇圖片', { exact: true }).setInputFiles({
      name: 'row-0-restored.png',
      mimeType: 'image/png',
      buffer: Buffer.from(DEMO_IMAGES[0].base64, 'base64'),
    });
    let failed = false;
    await page.route('**/api/cases/*/media', async (route) => {
      if (
        !failed &&
        route.request().postDataBuffer()?.includes(Buffer.from('row-1-1.png'))
      ) {
        failed = true;
        await route.abort();
      } else await route.continue();
    });
    await page.getByRole('button', { name: '預覽並驗證' }).click();
    await page.getByRole('button', { name: '確認批量建立' }).click();
    await expect(
      page.getByText('成功：3 · 失敗：0；每列結果顯示於上方。', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('部分圖片失敗；保留案件，不正式派件，可重試失敗圖片', {
        exact: true,
      }),
    ).toBeVisible();
    const links = await page
      .getByRole('link', { name: '查看案件' })
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLAnchorElement).pathname),
      );
    await page
      .getByRole('button', { name: '重試失敗圖片', exact: true })
      .click();
    await expect(
      page.getByText('圖片完成；未建立 Telegram 派件', { exact: true }),
    ).toHaveCount(3);
    for (const [index, path] of links.entries()) {
      const id = path.split('/').at(-1);
      const response = await page.request.post(
        `${SERVER_URL}/rpc/cases/media`,
        { data: { json: { id } } },
      );
      const media = (await response.json()).json as {
        originalFilename: string;
        id: string;
      }[];
      expect(media).toHaveLength([1, 5, 2][index]);
      expect(
        media.every((image) =>
          image.originalFilename.startsWith(`row-${index}-`),
        ),
      ).toBe(true);
      const forbidden = await page.request.get(
        `${SERVER_URL}/api/cases/${id}/media/${media[0].id}/image`,
        { headers: { Cookie: '' } },
      );
      expect(forbidden.status()).toBe(401);
    }
    await page
      .getByRole('region', { name: '第 3 筆案件圖片', exact: true })
      .getByRole('button', { name: '移除', exact: true })
      .first()
      .click();
    await expect(
      page
        .getByRole('region', { name: '第 3 筆案件圖片', exact: true })
        .getByText('1 張 · 完成 1 張', { exact: true }),
    ).toBeVisible();
    const afterRemove = await page.request.post(
      `${SERVER_URL}/rpc/cases/media`,
      { data: { json: { id: links[2].split('/').at(-1) } } },
    );
    expect((await afterRemove.json()).json).toHaveLength(1);
    for (const width of [375, 390, 430, 1366]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  });
});
