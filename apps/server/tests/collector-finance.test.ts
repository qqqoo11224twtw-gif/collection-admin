import { env } from 'cloudflare:workers';
import type { Context } from '@saasflare-dev/api/context';
import { renderPaymentBusinessReport } from '@saasflare-dev/api/customer-payments';
import { businessToday } from '@saasflare-dev/api/finance-contract';
import { FakeTelegramClient } from '@saasflare-dev/api/telegram-client';
import type { TelegramUpdate } from '@saasflare-dev/api/telegram-contract';
import { telegramWebhook } from '@saasflare-dev/api/telegram-processing';
import { parseCollectionCommand } from '@saasflare-dev/api/telegram-quick-collection';
import { drizzle } from 'drizzle-orm/d1';
import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, expect, it } from 'vitest';
import {
  adminCookie,
  historicalInstallmentFixture,
  rpc,
  signIn,
  userCookie,
} from './helpers';

const base = {
  env,
  DB: drizzle(env.DB),
  headers: new Headers(),
  user: null,
  session: null,
  isAdmin: false,
} as Context;
let admin: string, own: string, other: string;
let sequence = 12800000;

async function directReceipt(
  s: Awaited<ReturnType<typeof setup>>,
  amount: number,
) {
  const client = new FakeTelegramClient();
  await webhook(message(s, `/回報 ${s.name} 客戶直接匯案主`), client);
  const data = client.sent
    .at(-1)
    ?.replyMarkup?.inline_keyboard.flat()
    .find((button) => button.text === '🏦 後結')?.callback_data;
  expect(data).toBeTruthy();
  await webhook(callback(s, data ?? ''), client);
  const update = message(s, String(amount));
  await webhook(update, client);
  await webhook(update, client);
  return client;
}
async function remit(collectorId: string, amount: number) {
  const input = {
    collectorId,
    amount,
    idempotencyKey: crypto.randomUUID(),
    receivedDate: businessToday(),
    note: '虛構銀行轉帳',
  };
  const first = await rpc('collectorFinance.createRemittance', input, {
    cookie: admin,
  });
  expect(first.status).toBe(200);
  expect(
    (await rpc('collectorFinance.createRemittance', input, { cookie: admin }))
      .body,
  ).toMatchObject({ duplicate: true });
  return first.body as { id: string };
}
it('simple ledger: 5000 actual, 2500 due, 1000 offset and 1500 remittance gives zero', async () => {
  const s = await setup();
  expect((await receipt(s.cases[0].id, 5000)).status).toBe(200);
  await directReceipt(s, 2000);
  await remit(s.collectorId, 1500);
  const report = await summary(s.collectorId);
  expect(report.status).toBe(200);
  expect(report.body).toMatchObject({
    summary: {
      actualReceived: 5000,
      returnDue: 2500,
      offset: 1000,
      remitted: 1500,
      netReturnDue: 0,
    },
    total: 3,
  });
  const rows = (report.body as { items: Record<string, unknown>[] }).items;
  expect(rows.map((r) => [r.actual_received, r.return_due, r.marker])).toEqual([
    [5000, 2500, '0'],
    [0, -1000, '後結'],
    [0, -1500, '已回帳'],
  ]);
  expect(rows.reduce((sum, r) => sum + Number(r.returned_amount), 0)).toBe(
    1500,
  );
  expect((await counts(s.cases[0].id))?.total).toBe(7000);
  expect(JSON.stringify(report.body)).not.toMatch(
    /commission|system_fee|payout|credit|entitlement/,
  );
  const raw = await env.DB.prepare(
    'SELECT sum(admin_commission_amount) fees,max(admin_commission_rate_snapshot) rate FROM settlements WHERE collector_id=?',
  )
    .bind(s.collectorId)
    .first();
  expect(raw).toEqual({ fees: 0, rate: 0 });
  expect(
    await env.DB.prepare(
      'SELECT sum(admin_commission_amount) fees FROM collector_offsets WHERE collector_id=?',
    )
      .bind(s.collectorId)
      .first(),
  ).toEqual({ fees: 0 });
  const legacy = await rpc('finance.settlements', {}, { cookie: admin });
  expect(JSON.stringify(legacy.body)).not.toMatch(/commission|Commission/);
});
it('advance remittance is allowed and signed net is consistent in report and overview', async () => {
  const s = await setup();
  await receipt(s.cases[0].id, 2000);
  await remit(s.collectorId, 1500);
  expect((await summary(s.collectorId)).body).toMatchObject({
    summary: {
      actualReceived: 2000,
      returnDue: 1000,
      remitted: 1500,
      netReturnDue: -500,
    },
  });
  const overview = await rpc(
    'clearing.overview',
    { collectorId: s.collectorId },
    { cookie: admin },
  );
  expect(overview.body).toMatchObject({ summary: { netReturnDue: -500 } });
  expect(JSON.stringify(overview.body)).not.toMatch(/commission|Commission/);
});
it('A/B have separate rates and independent remittances, offsets and balances', async () => {
  const a = await setup(),
    b = await setup();
  await setCollectorRate(b.collectorId, 'return', 0.6);
  await receipt(a.cases[0].id, 5000);
  await receipt(b.cases[0].id, 5000);
  await remit(a.collectorId, 1500);
  await directReceipt(a, 2000);
  expect((await summary(a.collectorId)).body).toMatchObject({
    summary: { returnDue: 2500, netReturnDue: 0 },
  });
  expect((await summary(b.collectorId)).body).toMatchObject({
    summary: { returnDue: 3000, offset: 0, remitted: 0, netReturnDue: 3000 },
  });
});
it('changing/removing return rate preserves old immutable transactions and blocks new receipts only when missing', async () => {
  const s = await setup();
  await receipt(s.cases[0].id, 5000);
  await setCollectorRate(s.collectorId, 'return', 0.6);
  await receipt(s.cases[0].id, 5000);
  expect((await summary(s.collectorId)).body).toMatchObject({
    summary: { returnDue: 5500 },
  });
  const revision = (
    await rpc('collectorFinance.settings', {}, { cookie: admin })
  ).body as { version: number };
  expect(
    (
      await rpc(
        'collectorFinance.deleteRate',
        {
          collectorId: s.collectorId,
          kind: 'return',
          expectedVersion: revision.version,
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  expect((await receipt(s.cases[0].id, 5000)).status).toBe(400);
  expect((await summary(s.collectorId)).body).toMatchObject({
    summary: { returnDue: 5500 },
  });
  expect(
    await env.DB.prepare(
      'SELECT count(*) n FROM collector_finance_settings WHERE collector_id=?',
    )
      .bind(s.collectorId)
      .first(),
  ).toEqual({ n: 2 });
});
it('retired fee settings/endpoints/grants cannot be used and no fee configuration is required', async () => {
  const s = await setup();
  const revision = (
    await rpc('collectorFinance.settings', {}, { cookie: admin })
  ).body as { version: number };
  expect(
    (
      await rpc(
        'collectorFinance.setRate',
        {
          collectorId: s.collectorId,
          kind: 'commission',
          rate: 0.2,
          expectedVersion: revision.version,
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(400);
  for (const method of [
    'collectorFinance.commissionSettings',
    'collectorFinance.adminSummary',
    'clearing.payout',
    'clearing.payouts',
  ])
    expect((await rpc(method, {}, { cookie: admin })).status).toBe(404);
  expect(
    JSON.stringify(
      (await rpc('cases.permissions', undefined, { cookie: admin })).body,
    ),
  ).not.toContain('commission');
  expect((await receipt(s.cases[0].id, 15000)).status).toBe(200);
  expect((await summary(s.collectorId)).body).toMatchObject({
    summary: { returnDue: 7500, netReturnDue: 7500 },
  });
});
it('void payment excludes actual receipts and obligations without deleting remittance history', async () => {
  const s = await setup();
  const p = await receipt(s.cases[0].id, 5000);
  await remit(s.collectorId, 1500);
  const input = { id: (p.body as { id: string }).id, expectedVersion: 0 };
  expect(
    (await rpc('finance.voidPayment', input, { cookie: admin })).status,
  ).toBe(200);
  expect(
    (await rpc('finance.voidPayment', input, { cookie: admin })).body,
  ).toMatchObject({ duplicate: true });
  expect((await summary(s.collectorId)).body).toMatchObject({
    summary: {
      actualReceived: 0,
      returnDue: 0,
      remitted: 1500,
      netReturnDue: -1500,
    },
    total: 1,
  });
});
it('void offset removes only the offset and keeps the direct customer payment', async () => {
  const s = await setup();
  await directReceipt(s, 2000);
  const row = await env.DB.prepare(
    'SELECT id FROM collector_offsets WHERE collector_id=?',
  )
    .bind(s.collectorId)
    .first<{ id: string }>();
  expect(
    (
      await rpc(
        'collectorFinance.voidOffset',
        { id: row?.id, reason: '虛構作廢後結' },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  expect((await counts(s.cases[0].id))?.total).toBe(2000);
  expect((await summary(s.collectorId)).body).toMatchObject({
    summary: { actualReceived: 0, returnDue: 0, offset: 0, netReturnDue: 0 },
    total: 0,
  });
});
it('void direct source payment also removes offset from derived totals without hard deletion', async () => {
  const s = await setup();
  await directReceipt(s, 2000);
  const row = await env.DB.prepare('SELECT id FROM payments WHERE case_id=?')
    .bind(s.cases[0].id)
    .first<{ id: string }>();
  expect(
    (
      await rpc(
        'finance.voidPayment',
        { id: row?.id, expectedVersion: 0 },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  expect((await summary(s.collectorId)).body).toMatchObject({
    summary: { offset: 0, netReturnDue: 0 },
  });
  expect((await counts(s.cases[0].id))?.total).toBe(0);
  expect(
    await env.DB.prepare(
      'SELECT count(*) n FROM collector_offsets WHERE collector_id=?',
    )
      .bind(s.collectorId)
      .first(),
  ).toEqual({ n: 1 });
});
it('void remittance restores net and is idempotent', async () => {
  const s = await setup();
  await receipt(s.cases[0].id, 5000);
  const r = await remit(s.collectorId, 1500);
  const input = { id: r.id, reason: '虛構回帳作廢' };
  expect(
    (await rpc('collectorFinance.voidRemittance', input, { cookie: admin }))
      .status,
  ).toBe(200);
  expect(
    (await rpc('collectorFinance.voidRemittance', input, { cookie: admin }))
      .body,
  ).toMatchObject({ duplicate: true });
  expect((await summary(s.collectorId)).body).toMatchObject({
    summary: { remitted: 0, netReturnDue: 2500 },
  });
});
it('historical fees remain stored but never enter current financial totals or API', async () => {
  const s = await setup();
  const p = await receipt(s.cases[0].id, 5000);
  await env.DB.prepare(
    'UPDATE settlements SET admin_commission_rate=0.2,admin_commission_amount=500,admin_commission_rate_snapshot=0.2 WHERE payment_id=?',
  )
    .bind((p.body as { id: string }).id)
    .run();
  expect((await summary(s.collectorId)).body).toMatchObject({
    summary: { netReturnDue: 2500 },
  });
  expect(JSON.stringify((await summary(s.collectorId)).body)).not.toMatch(
    /commission/i,
  );
  expect((await receipt(s.cases[0].id, 1000)).status).toBe(200);
  expect(
    await env.DB.prepare(
      'SELECT admin_commission_amount old FROM settlements WHERE payment_id=?',
    )
      .bind((p.body as { id: string }).id)
      .first(),
  ).toEqual({ old: 500 });
});
it('collector scope is enforced for report/export/remittance/void/rate operations', async () => {
  const s = await setup(1, 50000, 'customer@test.dev'),
    otherFixture = await setup();
  expect((await summary(s.collectorId, own)).status).toBe(200);
  expect((await summary(otherFixture.collectorId, own)).status).toBe(403);
  expect(
    (
      await rpc(
        'collectorFinance.createRemittance',
        {
          collectorId: s.collectorId,
          amount: 1000,
          receivedDate: businessToday(),
          idempotencyKey: crypto.randomUUID(),
          note: '',
        },
        { cookie: own },
      )
    ).status,
  ).toBe(403);
  expect(
    (await rpc('collectorFinance.settings', {}, { cookie: own })).status,
  ).toBe(403);
  expect(
    (
      await rpc(
        'collectorFinance.export',
        { collectorId: s.collectorId },
        { cookie: own },
      )
    ).status,
  ).toBe(403);
  expect((await summary(s.collectorId, other)).status).toBe(403);
});
it('finance role can manage return rates and remittances but not users/routes/dispatch', async () => {
  const cookie = await signIn('simple-finance@test.dev');
  await env.DB.prepare(
    "UPDATE user SET role='finance' WHERE email='simple-finance@test.dev'",
  ).run();
  const s = await setup();
  await receipt(s.cases[0].id, 5000);
  expect((await summary(s.collectorId, cookie)).status).toBe(200);
  const revision = (await rpc('collectorFinance.settings', {}, { cookie }))
    .body as { version: number };
  expect(
    (
      await rpc(
        'collectorFinance.setRate',
        {
          collectorId: s.collectorId,
          kind: 'return',
          rate: 0.6,
          expectedVersion: revision.version,
        },
        { cookie },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await rpc(
        'collectorFinance.createRemittance',
        {
          collectorId: s.collectorId,
          amount: 1500,
          receivedDate: businessToday(),
          idempotencyKey: crypto.randomUUID(),
          note: '',
        },
        { cookie },
      )
    ).status,
  ).toBe(200);
  const permissions = (await rpc('cases.permissions', undefined, { cookie }))
    .body as string[];
  expect(permissions).not.toContain('assignment.create');
  expect(permissions).not.toContain('telegram_route.manage');
  expect(permissions).not.toContain('user_permission.manage');
  expect(permissions).not.toContain('commission.view');
});
it('export includes all three kinds, simple headers and five totals with no fee fields', async () => {
  const s = await setup();
  await receipt(s.cases[0].id, 5000);
  await directReceipt(s, 2000);
  await remit(s.collectorId, 1500);
  const result = await rpc(
    'collectorFinance.export',
    { collectorId: s.collectorId },
    { cookie: admin },
  );
  expect(result.status).toBe(200);
  const xml = strFromU8(
    unzipSync(new Uint8Array((result.body as { bytes: number[] }).bytes))[
      'xl/worksheets/sheet1.xml'
    ],
  );
  for (const text of [
    '日期',
    '代理',
    '會員名稱',
    '實際收款',
    '應回帳',
    '已回帳',
    '備註',
    '後結',
    '總實際收款',
    '實際應回款',
  ])
    expect(xml).toContain(text);
  expect(xml).not.toMatch(/傭金|佣金|commission|credit|可領/);
  expect(xml).toContain('<v>-1000</v>');
  expect(xml).toContain('<v>-1500</v>');
});
it('date/name/status filters apply before pagination and summaries include all matching pages', async () => {
  const s = await setup();
  await receipt(s.cases[0].id, 5000, { receivedDate: '2026-09-10' });
  await receipt(s.cases[0].id, 2000, { receivedDate: '2026-09-11' });
  const result = await rpc(
    'collectorFinance.report',
    {
      collectorId: s.collectorId,
      pageSize: 1,
      page: 2,
      query: s.name,
      dateFrom: '2026-09-10',
      dateTo: '2026-09-11',
    },
    { cookie: admin },
  );
  expect(result.body).toMatchObject({
    total: 2,
    summary: { actualReceived: 7000, returnDue: 3500 },
  });
  expect((result.body as { items: unknown[] }).items).toHaveLength(1);
  expect(
    (
      await rpc(
        'collectorFinance.report',
        { collectorId: s.collectorId, query: '不存在虛構姓名' },
        { cookie: admin },
      )
    ).body,
  ).toMatchObject({ total: 0 });
});
it('receipt retry/concurrent writes cannot duplicate financial events and FK/audit remain valid', async () => {
  const s = await setup();
  const input = {
    caseId: s.cases[0].id,
    idempotencyKey: crypto.randomUUID(),
    receivedAmount: 5000,
    receivedDate: businessToday(),
  };
  const results = await Promise.all([
    rpc('finance.createPayment', input, { cookie: admin }),
    rpc('finance.createPayment', input, { cookie: admin }),
  ]);
  expect(results.some((r) => r.status === 200)).toBe(true);
  expect((await counts(s.cases[0].id))?.payments).toBe(1);
  expect(
    (await rpc('finance.createPayment', input, { cookie: admin })).body,
  ).toMatchObject({ duplicate: true });
  expect(
    (await env.DB.prepare('PRAGMA foreign_key_check').all()).results,
  ).toHaveLength(0);
  expect(
    (
      await env.DB.prepare(
        "SELECT count(*) n FROM audit_logs WHERE entity_id=? AND action='payment.received'",
      )
        .bind(s.cases[0].id)
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
});
beforeAll(async () => {
  admin = await adminCookie();
  own = await userCookie();
  other = await signIn('finance-other@test.dev');
});
async function setCollectorRate(
  collectorId: string,
  kind: 'return',
  rate: number,
) {
  const current = await rpc('collectorFinance.settings', undefined, {
    cookie: admin,
  });
  const result = await rpc(
    'collectorFinance.setRate',
    {
      collectorId,
      kind,
      rate,
      expectedVersion: (current.body as { version: number }).version,
    },
    { cookie: admin },
  );
  expect(result.status).toBe(200);
}
async function setup(count = 1, amount = 50000, email?: string) {
  const uid = email
    ? (
        await env.DB.prepare('SELECT id FROM user WHERE email=?')
          .bind(email)
          .first<{ id: string }>()
      )?.id
    : null;
  const collector = await rpc(
    'collectors.create',
    {
      displayName: '虛構收款外收',
      code: crypto.randomUUID(),
      userId: uid ?? null,
      isActive: true,
    },
    { cookie: admin },
  );
  expect(collector.status).toBe(200);
  const collectorId = (collector.body as { id: string }).id,
    chatId = String(-++sequence),
    topicId = 2;
  await setCollectorRate(collectorId, 'return', 0.5);
  const r = await rpc(
    'telegram.saveRoute',
    {
      chatId,
      topicId,
      routeType: 'collector_report',
      collectorId,
      isActive: true,
    },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  const routeId = (r.body as { id: string }).id;
  const destination = await rpc(
    'telegram.saveRoute',
    {
      chatId: String(-++sequence),
      topicId: null,
      routeType: 'business_report',
      collectorId,
      isActive: true,
    },
    { cookie: admin },
  );
  expect(destination.status).toBe(200);
  const name = `虛構姓名${crypto.randomUUID().slice(0, 8)}`;
  const cases: { id: string; code: string; assignment: string }[] = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomUUID();
    const c = await rpc(
      'cases.create',
      {
        customerName: name,
        code,
        address: '虛構測試地址',
        region: i ? '新北市' : '桃園市',
        amountDue: amount,
        status: 'pending',
        source: 'manual',
        revisitStatus: 'pending',
        revisitReason: '',
      },
      { cookie: admin },
    );
    expect(c.status).toBe(200);
    const id = (c.body as { id: string }).id;
    await rpc(
      'cases.assign',
      { caseId: id, collectorId, expectedVersion: 0, note: '' },
      { cookie: admin },
    );
    const a = await env.DB.prepare(
      'SELECT id FROM assignments WHERE case_id=? AND unassigned_at IS NULL',
    )
      .bind(id)
      .first<{ id: string }>();
    cases.push({ id, code, assignment: a?.id ?? '' });
  }
  return {
    collectorId,
    chatId,
    topicId,
    routeId,
    name,
    cases,
    destinationId: (destination.body as { id: string }).id,
  };
}
function message(
  s: { chatId: string; topicId: number },
  text: string,
  media?: { group?: string },
): TelegramUpdate {
  const id = ++sequence;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(s.chatId), type: 'supergroup' },
      message_thread_id: s.topicId,
      from: { id: 901 },
      ...(media
        ? {
            caption: text,
            photo: [{ file_id: 'fake-native-photo', width: 10, height: 10 }],
            media_group_id: media.group,
          }
        : { text }),
    },
  };
}
function callback(
  s: { chatId: string; topicId: number },
  data: string,
): TelegramUpdate {
  const id = ++sequence;
  return {
    update_id: id,
    callback_query: {
      id: String(id),
      from: { id: 902 },
      data,
      message: {
        message_id: id,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(s.chatId), type: 'supergroup' },
        message_thread_id: s.topicId,
      },
    },
  };
}
async function webhook(
  update: TelegramUpdate,
  client = new FakeTelegramClient(),
) {
  const response = await telegramWebhook(
    base,
    new Request('http://localhost/api/telegram/webhook', {
      method: 'POST',
      headers: {
        'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-placeholder',
      },
      body: JSON.stringify(update),
    }),
    client,
  );
  expect(response.status).toBe(200);
  const outcome = await env.DB.prepare(
    'SELECT result_code,last_error_code FROM telegram_updates WHERE id=?',
  )
    .bind(String(update.update_id))
    .first<{ result_code: string | null; last_error_code: string | null }>();
  if (outcome?.last_error_code)
    expect(outcome.last_error_code).not.toBe('PROCESSING_RETRY');
  return client;
}
async function summary(id: string, cookie = admin) {
  const r = await rpc(
    'collectorFinance.report',
    { collectorId: id },
    { cookie },
  );
  return r;
}
async function receipt(
  caseId: string,
  amount: number,
  extra: Record<string, unknown> = {},
) {
  return rpc(
    'finance.createPayment',
    {
      caseId,
      idempotencyKey: crypto.randomUUID(),
      receivedAmount: amount,
      receivedDate: businessToday(),
      installmentScheduleId: null,
      ...extra,
    },
    { cookie: admin },
  );
}
async function counts(caseId: string) {
  return env.DB.prepare(
    "SELECT count(*) AS payments,coalesce(sum(received_amount),0) AS total FROM payments WHERE case_id=? AND status='received'",
  )
    .bind(caseId)
    .first<{ payments: number; total: number }>();
}

it('parses only numeric positive amounts and Chinese commands with bot suffix without AI guesses', () => {
  expect(parseCollectionCommand('/收款@abctest888_bot 王小明 5000')).toEqual({
    name: '王小明',
    amount: 5000,
  });
  expect(parseCollectionCommand(' /收款 Ａ王 005000 ')).toEqual({
    name: 'A王',
    amount: 5000,
  });
  for (const bad of [
    '五千',
    '大概5000',
    '5000左右',
    '-1',
    '0',
    '1.5',
    '1e4',
    '5000\n另一行',
    '1000000000001',
  ])
    expect(parseCollectionCommand(`/收款 王小明 ${bad}`)).toBeNull();
});
it('unique name creates one payment/settlement/report atomically and immediately; replay does not duplicate', async () => {
  const s = await setup(),
    client = new FakeTelegramClient(),
    u = message(s, `/收款 ${s.name} 5000`);
  await webhook(u, client);
  expect(
    await env.DB.prepare(
      "SELECT expires_at-created_at AS ttl FROM telegram_report_conversations WHERE origin_update_id=? AND kind='payment'",
    )
      .bind(String(u.update_id))
      .first(),
  ).toEqual({ ttl: 1200000 });
  await webhook(u, client);
  expect(await counts(s.cases[0].id)).toEqual({ payments: 1, total: 5000 });
  expect(client.sent).toHaveLength(1);
  expect(client.sent[0].text).toContain('已完成收款');
  expect(client.sent[0].replyMarkup).toBeUndefined();
  expect(
    await env.DB.prepare(
      'SELECT count(*) AS n FROM settlements WHERE case_id=?',
    )
      .bind(s.cases[0].id)
      .first(),
  ).toEqual({ n: 1 });
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM reports WHERE case_id=? AND finance_event='payment' AND workflow_status='completed'",
    )
      .bind(s.cases[0].id)
      .first(),
  ).toEqual({ n: 1 });
});
it('no match and invalid amount return safe Chinese messages and create no payments', async () => {
  const s = await setup(),
    client = new FakeTelegramClient();
  await webhook(message(s, '/收款 不存在姓名 5000'), client);
  expect(client.sent.at(-1)?.text).toContain('可收款案件');
  await webhook(message(s, `/收款 ${s.name} 五千`), client);
  expect(client.sent.at(-1)?.text).toContain('格式錯誤');
  expect((await counts(s.cases[0].id))?.payments).toBe(0);
});
it.each([
  0, 1,
])('duplicate names require an inline selection, member B can select case %i and callback replay is safe', async (index) => {
  const s = await setup(2),
    client = new FakeTelegramClient();
  await webhook(message(s, `/收款 ${s.name} 5000`), client);
  const buttons = client.sent.at(-1)?.replyMarkup?.inline_keyboard;
  expect(buttons).toHaveLength(2);
  expect(buttons?.[0][0].text).toContain('｜');
  expect((await counts(s.cases[0].id))?.payments).toBe(0);
  const label = buttons?.find((b) =>
    b[0].text.includes(s.cases[index].code.slice(0, 22)),
  )?.[0];
  expect(label).toBeTruthy();
  await webhook(callback(s, label?.callback_data ?? ''), client);
  await webhook(callback(s, label?.callback_data ?? ''), client);
  expect((await counts(s.cases[index].id))?.payments).toBe(1);
  expect((await counts(s.cases[1 - index].id))?.payments).toBe(0);
});
it('candidate selection does not include unassigned, other collectors or voided/inactive cases', async () => {
  const s = await setup(3),
    otherScope = await setup();
  await env.DB.prepare(
    'UPDATE cases SET customer_name=?,report_name=NULL WHERE id=?',
  )
    .bind(s.name, otherScope.cases[0].id)
    .run();
  await env.DB.prepare('UPDATE assignments SET unassigned_at=? WHERE id=?')
    .bind(Date.now(), s.cases[1].assignment)
    .run();
  await env.DB.prepare('UPDATE cases SET voided_at=? WHERE id=?')
    .bind(Date.now(), s.cases[2].id)
    .run();
  const client = await webhook(message(s, `/收款 ${s.name} 5000`));
  expect(client.sent.at(-1)?.text).toContain('已完成收款');
  expect((await counts(s.cases[0].id))?.payments).toBe(1);
  expect((await counts(otherScope.cases[0].id))?.payments).toBe(0);
});
it.each([
  'assignment',
  'void',
  'collector',
  'route',
  'expired',
  'other-topic',
])('revalidates selection guard: %s', async (kind) => {
  const s = await setup(2),
    client = new FakeTelegramClient();
  await webhook(message(s, `/收款 ${s.name} 5000`), client);
  const data =
    client.sent.at(-1)?.replyMarkup?.inline_keyboard[0][0].callback_data ?? '';
  if (kind === 'assignment')
    await env.DB.prepare(
      'UPDATE assignments SET unassigned_at=? WHERE collector_id=?',
    )
      .bind(Date.now(), s.collectorId)
      .run();
  if (kind === 'void')
    await env.DB.prepare('UPDATE cases SET voided_at=? WHERE id IN (?,?)')
      .bind(Date.now(), s.cases[0].id, s.cases[1].id)
      .run();
  if (kind === 'collector')
    await env.DB.prepare('UPDATE collectors SET is_active=0 WHERE id=?')
      .bind(s.collectorId)
      .run();
  if (kind === 'route')
    await env.DB.prepare('UPDATE telegram_routes SET is_active=0 WHERE id=?')
      .bind(s.routeId)
      .run();
  if (kind === 'expired')
    await env.DB.prepare(
      "UPDATE telegram_report_conversations SET expires_at=1 WHERE route_id=? AND kind='payment'",
    )
      .bind(s.routeId)
      .run();
  await webhook(
    callback(kind === 'other-topic' ? { ...s, topicId: 3 } : s, data),
    client,
  );
  for (const c of s.cases) expect((await counts(c.id))?.payments).toBe(0);
});
it('new collection replaces an old selection without mixing amount or case', async () => {
  const s = await setup(2),
    client = new FakeTelegramClient();
  await webhook(message(s, `/收款 ${s.name} 5000`), client);
  const old =
    client.sent.at(-1)?.replyMarkup?.inline_keyboard[0][0].callback_data ?? '';
  await webhook(message(s, `/收款 ${s.name} 7000`), client);
  const next =
    client.sent.at(-1)?.replyMarkup?.inline_keyboard[0][0].callback_data ?? '';
  await webhook(callback(s, old), client);
  expect((await counts(s.cases[0].id))?.payments).toBe(0);
  await webhook(callback(s, next), client);
  expect(
    ((await counts(s.cases[0].id))?.total ?? 0) +
      ((await counts(s.cases[1].id))?.total ?? 0),
  ).toBe(7000);
});
it('actual receipts and void do not allocate or modify a historical schedule', async () => {
  const s = await setup(),
    c = s.cases[0],
    legacy = await historicalInstallmentFixture(c.id);
  const before = await env.DB.prepare(
    'SELECT * FROM installment_schedules WHERE id=?',
  )
    .bind(legacy.scheduleId)
    .first();
  const p = await receipt(c.id, 8000);
  expect(p.status).toBe(200);
  expect(
    await env.DB.prepare(
      'SELECT count(*) n FROM payment_allocations WHERE payment_id=?',
    )
      .bind((p.body as { id: string }).id)
      .first(),
  ).toEqual({ n: 0 });
  expect(
    await env.DB.prepare('SELECT * FROM installment_schedules WHERE id=?')
      .bind(legacy.scheduleId)
      .first(),
  ).toEqual(before);
  expect(
    (
      await rpc(
        'finance.voidPayment',
        { id: (p.body as { id: string }).id, expectedVersion: 0 },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  expect(
    await env.DB.prepare('SELECT * FROM installment_schedules WHERE id=?')
      .bind(legacy.scheduleId)
      .first(),
  ).toEqual(before);
});
it('actual customer receipts exceed reference amounts without truncation', async () => {
  const s = await setup(1, 5000),
    client = await webhook(message(s, `/收款 ${s.name} 10000`));
  expect((await counts(s.cases[0].id))?.payments).toBe(1);
  expect((await counts(s.cases[0].id))?.total).toBe(10000);
  expect(client.sent.at(-1)?.text).toContain('10000');
  expect(client.sent.at(-1)?.text).not.toContain('剩餘');
});
it('D1 batch rolls back payment, allocations, case/plan and finance revision if an insert fails', async () => {
  const s = await setup(),
    c = s.cases[0];
  const before = await env.DB.prepare(
    "SELECT version FROM finance_settings WHERE id='global'",
  ).first();
  const caseBefore = await env.DB.prepare(
    'SELECT version FROM cases WHERE id=?',
  )
    .bind(c.id)
    .first();
  await env.DB.exec(
    `CREATE TRIGGER finance_test_rollback BEFORE INSERT ON settlements WHEN NEW.case_id='${c.id}' BEGIN SELECT RAISE(ABORT,'fictional financial insert failure'); END;`,
  );
  try {
    expect((await receipt(c.id, 5000)).status).toBe(409);
    expect((await counts(c.id))?.payments).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT version FROM finance_settings WHERE id='global'",
      ).first(),
    ).toEqual(before);
    expect(
      await env.DB.prepare('SELECT version FROM cases WHERE id=?')
        .bind(c.id)
        .first(),
    ).toEqual(caseBefore);
  } finally {
    await env.DB.exec('DROP TRIGGER finance_test_rollback;');
  }
});
it('payment business messages show receipt history and actual cumulative total without debt estimates', async () => {
  const s = await setup(),
    client = new FakeTelegramClient();
  await receipt(s.cases[0].id, 3000, { receivedDate: '2026-09-22' });
  await rpc(
    'installments.create',
    {
      caseId: s.cases[0].id,
      planType: 'deadline',
      totalAmount: 10000,
      deadlineDate: '2026-12-20',
    },
    { cookie: admin },
  );
  await webhook(message(s, `/收款 ${s.name} 5000`), client);
  const job = await env.DB.prepare(
    "SELECT j.payload FROM telegram_outbound_jobs j JOIN reports r ON r.id=j.report_id WHERE r.case_id=? AND j.message_type='report_destination'",
  )
    .bind(s.cases[0].id)
    .first<{ payload: string }>();
  const payload = JSON.parse(job?.payload ?? '{}') as { text: string };
  expect(
    payload.text
      .split('\n')
      .slice(0, 4)
      .map((line) => line.split('：')[0]),
  ).toEqual(['代理', '客戶姓名', '回報內容', '收款紀錄']);
  expect(payload.text).toContain('回報內容：已收款 5000');
  expect(payload.text).not.toMatch(/日期：|本次收款：|實際收款 5000/);
  expect(payload.text).toContain('累計已收：8000');
  expect(payload.text).toContain('收款紀錄');
  expect(payload.text).not.toMatch(/剩餘未收|管理傭金|後結抵扣/);
  expect(payload.text).not.toContain('12/20');
  expect((await summary(s.collectorId)).body).toMatchObject({
    summary: { actualReceived: 8000 },
  });
  expect(
    await env.DB.prepare(
      'SELECT received_date FROM payments WHERE case_id=? AND received_amount=3000',
    )
      .bind(s.cases[0].id)
      .first(),
  ).toMatchObject({ received_date: '2026-09-22' });
});
it('formal payment report retains same-day receipts separately and excludes voids from history and total', async () => {
  const s = await setup();
  const first = await receipt(s.cases[0].id, 15000, {
    receivedDate: '2026-10-10',
  });
  expect(first.status).toBe(200);
  const firstId = (first.body as { id: string }).id;
  const input = {
    caseId: s.cases[0].id,
    paymentId: firstId,
    code: 'T001',
    customerName: '王小明',
    content: '實際收款 15000',
    date: '2026/10/10',
  };
  expect(await renderPaymentBusinessReport(base, input)).toBe(
    '代理：T001\n客戶姓名：王小明\n回報內容：已收款 15000\n收款紀錄：\n10/10 15000\n累計已收：15000',
  );
  const second = await receipt(s.cases[0].id, 5000, {
    receivedDate: '2026-10-10',
  });
  expect(second.status).toBe(200);
  const secondId = (second.body as { id: string }).id;
  expect(
    await renderPaymentBusinessReport(base, {
      ...input,
      paymentId: secondId,
      content: '實際收款 5000',
    }),
  ).toBe(
    '代理：T001\n客戶姓名：王小明\n回報內容：已收款 5000\n收款紀錄：\n10/10 15000\n10/10 5000\n累計已收：20000',
  );
  expect(
    (
      await rpc(
        'finance.voidPayment',
        { id: secondId, expectedVersion: 0 },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  const third = await receipt(s.cases[0].id, 1000, {
    receivedDate: '2026-10-10',
  });
  expect(
    await renderPaymentBusinessReport(base, {
      ...input,
      paymentId: (third.body as { id: string }).id,
    }),
  ).toBe(
    '代理：T001\n客戶姓名：王小明\n回報內容：已收款 1000\n收款紀錄：\n10/10 15000\n10/10 1000\n累計已收：16000',
  );
});
