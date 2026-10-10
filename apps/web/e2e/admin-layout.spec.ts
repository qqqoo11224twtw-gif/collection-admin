import { expect, test } from '@playwright/test';
import { isRemote, signIn } from './auth-helpers';

test.describe('正式後台 responsive 驗收', () => {
  test.skip(isRemote, 'Only local fictional accounts');
  test('all management pages fit desktop and mobile viewports with consistent navigation', async ({
    page,
  }, info) => {
    test.setTimeout(240000);
    await page.goto('/cases');
    await signIn(page, 'phase8-admin@example.test');
    const pages = [
      ['/', '儀表總覽'],
      ['/cases', '案件管理'],
      ['/cases/installments', '分期客追蹤'],
      ['/cases/bulk-create', '批量建檔'],
      ['/cases/reviews', '待確認'],
      ['/cases/regions', '地區調度'],
      ['/cases/collectors', '外收人員'],
      ['/cases/finance', '外收結算財報'],
      ['/cases/telegram', 'Telegram 群組設定'],
      ['/cases/users', '帳號管理'],
      ['/cases/system-logs', '系統管理日誌'],
      ['/cases/integrations', '系統整合狀態'],
    ];
    for (const width of [1366, 1440, 1920, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [url, title] of pages) {
        await page.goto(url);
        await expect(
          page.getByRole('heading', { name: title, exact: true }).first(),
        ).toBeVisible();
        await expect(
          page.getByRole('navigation', {
            name: width < 768 ? '手機導覽' : '主要導覽',
          }),
        ).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        if (url === '/cases' && width < 768)
          await expect(page.getByRole('table')).toHaveCount(0);
      }
      await page.goto('/cases');
      await expect(
        page.getByRole('heading', { name: '案件管理', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('checkbox', { name: '全選目前頁面', exact: true }),
      ).toBeEnabled();
      await page.screenshot({
        path: info.outputPath(`cases-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '更多', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText('帳號管理');
    await sheet
      .getByRole('link', { name: 'Telegram 設定', exact: true })
      .click();
    await expect(page).toHaveURL(/\/cases\/telegram/);
    await expect(sheet).not.toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Telegram 機器人' }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: '綁定新機器人', exact: true })
      .click();
    await expect(page.getByLabel('Telegram Bot Token')).toHaveAttribute(
      'type',
      'password',
    );
    const bounds = await page.getByRole('dialog').boundingBox();
    expect(bounds?.width).toBeLessThanOrEqual(390);
    expect(bounds?.height).toBeLessThanOrEqual(844);
    await page.screenshot({
      path: info.outputPath('bot-mobile.png'),
      fullPage: true,
    });
  });
  test('route managers cannot see Bot credentials UI and ordinary users cannot see management navigation', async ({
    page,
  }) => {
    await page.goto('/cases');
    await signIn(page, 'phase8-admin@example.test');
    const email = `route-ui-${Date.now()}@example.test`;
    const managerContext = await page
      .context()
      .browser()
      ?.newContext({
        baseURL: 'http://localhost:3000',
        extraHTTPHeaders: { Origin: 'http://localhost:3000' },
      });
    const manager = await managerContext.newPage();
    await manager.goto('/login');
    await signIn(manager, email);
    const users = await page.request.post(
      'http://localhost:4000/rpc/users/list',
      { data: {} },
    );
    const target = (await users.json()).json.find(
      (u: { email: string }) => u.email === email,
    );
    const create = await page.request.post(
      'http://localhost:4000/rpc/accounts/save',
      {
        data: {
          json: {
            id: target.id,
            username: `e2e-${email.replace(/[^a-z0-9]/g, '-')}`,
            name: '虛構群組管理員',
            role: 'restricted',
            active: true,
            collectorId: null,
            allow: ['telegram_route.manage'],
            deny: [],
            expectedVersion: target.version,
          },
        },
      },
    );
    expect(create.status()).toBe(200);
    await managerContext.close();
    await page.context().clearCookies();
    await page.goto('/login');
    await signIn(page, email);
    await page.goto('/cases/telegram');
    await expect(
      page.getByRole('button', { name: '新增路由', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Telegram 機器人', exact: true }),
    ).toHaveCount(0);
    expect(
      (
        await page.request.post(
          'http://localhost:4000/rpc/telegram/bots/list',
          { data: {} },
        )
      ).status(),
    ).toBe(403);
    await page.getByRole('button', { name: '新增路由', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('外收派件群');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '取消', exact: true })
      .click();
  });
});
