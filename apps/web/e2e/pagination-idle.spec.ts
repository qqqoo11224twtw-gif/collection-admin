import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { isRemote, signIn } from './auth-helpers';

function localSql(sql: string) {
  const cwd = fileURLToPath(new URL('../../server/', import.meta.url));
  writeFileSync(`${cwd}/.wrangler/pagination-audit.sql`, sql);
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
      '.wrangler/pagination-audit.sql',
    ],
    { cwd, stdio: 'pipe', windowsHide: true },
  );
}

test.describe('分頁與閒置安全', () => {
  test.skip(isRemote, 'Fictional local database fixtures only');
  test.setTimeout(180000);
  test('all sizes, filter preservation, refresh, next/previous and 500 cards at six widths', async ({
    page,
  }) => {
    await page.goto('/cases');
    await signIn(page, 'admin@example.test');
    const prefix = `PAGINATION-${Date.now()}-`;
    localSql(
      Array.from(
        { length: 510 },
        (_, i) =>
          `INSERT INTO cases(id,case_no,code,customer_name,address,amount_due,region,status,created_at,updated_at) VALUES('${prefix}${i}','${prefix}${i}','${prefix}${i}','虛構分頁案件','虛構地址',100,'桃園市','pending',${Date.now()},${Date.now()});`,
      ).join('\n'),
    );
    try {
      await page.goto(
        `/cases?query=${prefix}&region=桃園市&status=pending&assignmentStatus=unassigned&page=2&pageSize=20`,
      );
      await expect(page.getByText('510 筆案件 · 第 2 ／ 26')).toBeVisible();
      for (const size of [50, 200, 500, 20]) {
        const started = Date.now();
        await page
          .getByLabel('每頁顯示', { exact: true })
          .selectOption(String(size));
        await expect(
          page.getByText(`510 筆案件 · 第 1 ／ ${Math.ceil(510 / size)}`),
        ).toBeVisible();
        if (size === 500)
          console.info(
            JSON.stringify({
              event: 'CASE_PAGE_500_BROWSER_LOCAL',
              duration_ms: Date.now() - started,
            }),
          );
        await expect(page.getByLabel('搜尋案件')).toHaveValue(prefix);
        await expect(page.getByLabel('地區', { exact: true })).toHaveValue(
          '桃園市',
        );
        await expect(page.getByLabel('案件狀態', { exact: true })).toHaveValue(
          'pending',
        );
        await expect(page.getByLabel('委外狀態', { exact: true })).toHaveValue(
          'unassigned',
        );
      }
      await page.getByLabel('每頁顯示', { exact: true }).selectOption('500');
      await page.reload();
      await expect(page.getByLabel('每頁顯示', { exact: true })).toHaveValue(
        '500',
      );
      await page.getByRole('button', { name: '下一頁' }).click();
      await expect(page.getByText('510 筆案件 · 第 2 ／ 2')).toBeVisible();
      await page.getByRole('button', { name: '上一頁' }).click();
      await expect(page.getByText('510 筆案件 · 第 1 ／ 2')).toBeVisible();
      for (const width of [375, 390, 430, 1366, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(
          page.locator(width < 768 ? 'main article' : 'tbody tr'),
        ).toHaveCount(500);
        await expect(
          page.getByLabel('每頁顯示', { exact: true }),
        ).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
      expect(await page.locator('img[src*="/media/"]').count()).toBe(0);
      const collectorId = await page
        .getByLabel('外收人員', { exact: true })
        .locator('option')
        .nth(1)
        .getAttribute('value');
      expect(collectorId).toBeTruthy();
      await page
        .getByLabel('外收人員', { exact: true })
        .selectOption(collectorId as string);
      await page.getByLabel('每頁顯示', { exact: true }).selectOption('200');
      await expect(page.getByLabel('外收人員', { exact: true })).toHaveValue(
        collectorId as string,
      );
      await expect(page.getByLabel('搜尋案件')).toHaveValue(prefix);
      await expect(page).toHaveURL(/page=1/);
    } finally {
      localSql(`DELETE FROM cases WHERE code LIKE '${prefix}%';`);
    }
  });
  test('background checks do not revive an expired session and redirect with Chinese message', async ({
    page,
  }) => {
    await page.goto('/cases');
    await signIn(page, 'admin@example.test');
    localSql(
      `UPDATE managed_sessions SET last_activity_at=${Date.now() - 900000} WHERE user_id IN (SELECT id FROM user WHERE email='admin@example.test');`,
    );
    await expect(page).toHaveURL(/\/login\?idle=true/, { timeout: 20000 });
    await expect(
      page.getByText('已超過 15 分鐘未操作，請重新登入。', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('帳號', { exact: true })).toBeVisible();
  });
});
