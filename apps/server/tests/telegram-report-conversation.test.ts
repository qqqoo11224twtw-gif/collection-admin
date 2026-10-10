import { env } from 'cloudflare:workers';
import type { Context } from '@saasflare-dev/api/context';
import { listTracking } from '@saasflare-dev/api/installment-tracking';
import { FakeTelegramClient } from '@saasflare-dev/api/telegram-client';
import type { TelegramUpdate } from '@saasflare-dev/api/telegram-contract';
import {
  processOutbound,
  queueReportDestination,
  queueTelegramMessage,
} from '@saasflare-dev/api/telegram-outbound';
import { processTelegramPayment } from '@saasflare-dev/api/telegram-payments';
import { telegramPrincipal } from '@saasflare-dev/api/telegram-principal';
import {
  processTelegramUpdates,
  receiveTelegramUpdate,
  telegramWebhook,
} from '@saasflare-dev/api/telegram-processing';
import { processReportStatusCallback } from '@saasflare-dev/api/telegram-report-status';
import {
  normalizeReportName,
  parseReportCommand,
  processReportCaseCallback,
  processReportCommand,
  processReportContent,
} from '@saasflare-dev/api/telegram-reports';
import { telegramRoutes } from '@saasflare-dev/db';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminCookie, rpc, userCookie } from './helpers';

let admin: string, _uid: string;
let sequence = 9700000;
async function immediate(update: TelegramUpdate, client: FakeTelegramClient) {
  return telegramWebhook(
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
}

describe('webhook interactive fast path', () => {
  it('retains route-manager permission denial and sends a safe immediate error', async () => {
    const s = await setup(),
      client = new FakeTelegramClient();
    const manager = s.route.managedByUserId;
    const prior = await env.DB.prepare(
      'SELECT permission_deny FROM user WHERE id=?',
    )
      .bind(manager)
      .first<{ permission_deny: string }>();
    await env.DB.prepare('UPDATE user SET permission_deny=? WHERE id=?')
      .bind(JSON.stringify(['telegram_route.manage']), manager)
      .run();
    try {
      const u = message(s.route, `/回報 ${s.name}`);
      await immediate(u, client);
      expect(client.sent).toHaveLength(1);
      expect(client.sent[0].text).toContain('操作權限');
      expect(client.sent[0].text).not.toContain(s.cases[0].code);
      expect(
        await env.DB.prepare(
          'SELECT last_error_code FROM telegram_updates WHERE id=?',
        )
          .bind(String(u.update_id))
          .first(),
      ).toMatchObject({ last_error_code: 'PERMISSION_DENIED' });
    } finally {
      await env.DB.prepare('UPDATE user SET permission_deny=? WHERE id=?')
        .bind(prior?.permission_deny ?? '[]', manager)
        .run();
    }
  });
  it('uncertain immediate delivery is never automatically resent', async () => {
    const s = await setup(),
      client = new FakeTelegramClient();
    client.uncertainSend = true;
    const u = message(s.route, `/回報 ${s.name}`);
    await immediate(u, client);
    await immediate(u, client);
    expect(client.sent).toHaveLength(1);
    expect(
      await env.DB.prepare(
        'SELECT status,last_error_code,attempts FROM telegram_outbound_jobs WHERE dedupe_key=?',
      )
        .bind(`command-reply:${u.update_id}`)
        .first(),
    ).toMatchObject({
      status: 'failed',
      last_error_code: 'DELIVERY_UNKNOWN',
      attempts: 1,
    });
  });
  it('unique name replies and persists conversation before webhook returns without scheduler; replay sends nothing', async () => {
    const s = await setup(),
      client = new FakeTelegramClient();
    const u = message(s.route, `/回報 ${s.name}`);
    expect((await immediate(u, client)).status).toBe(200);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0].text).toContain(s.cases[0].code);
    expect((await conversation(s.route))?.stage).toBe('content');
    await immediate(u, client);
    expect(client.sent).toHaveLength(1);
    const content = message(s.route, '虛構回報內容');
    await immediate(content, client);
    expect(client.sent.at(-1)?.replyMarkup?.inline_keyboard.flat().length).toBe(
      5,
    );
  });
  it('no-match and duplicate-name keyboard are sent immediately', async () => {
    const s = await setup(2),
      client = new FakeTelegramClient();
    await immediate(message(s.route, '/回報 不存在的虛構姓名'), client);
    expect(client.sent[0].text).toContain('找不到');
    await immediate(message(s.route, `/回報 ${s.name}`), client);
    const data =
      client.sent.at(-1)?.replyMarkup?.inline_keyboard[0][0].callback_data;
    expect(data).toBeTruthy();
    await immediate(callback(s.route, data ?? ''), client);
    expect(client.answered[0].text).toBe('');
    expect(client.sent.at(-1)?.text).toContain('請輸入回報內容');
  });
  it('name cache invalidates on edit and indexed lookup preserves Unicode normalization', async () => {
    const s = await setup(),
      client = new FakeTelegramClient();
    await env.DB.prepare(
      'UPDATE cases SET customer_name=?,report_name=NULL WHERE id=?',
    )
      .bind('  Ａ王小明  ', s.cases[0].id)
      .run();
    await immediate(message(s.route, '/回報 A王小明'), client);
    expect(client.sent.at(-1)?.text).toContain('找到案件：');
    await env.DB.prepare(
      'UPDATE cases SET customer_name=?,report_name=NULL WHERE id=?',
    )
      .bind('新虛構姓名', s.cases[0].id)
      .run();
    await immediate(message(s.route, '/回報 A王小明'), client);
    expect(client.sent.at(-1)?.text).toContain('找不到');
    const plan = await env.DB.prepare(
      'EXPLAIN QUERY PLAN SELECT id FROM cases WHERE report_name=? AND voided_at IS NULL',
    )
      .bind('新虛構姓名')
      .all<{ detail: string }>();
    expect(
      plan.results.some((r) =>
        r.detail.includes('cases_report_name_active_idx'),
      ),
    ).toBe(true);
  });
});
const base = {
  env,
  DB: drizzle(env.DB),
  headers: new Headers(),
  user: null,
  session: null,
  isAdmin: false,
} as Context;
beforeAll(async () => {
  admin = await adminCookie();
  await userCookie();
  _uid =
    (
      await env.DB.prepare(
        "SELECT id FROM user WHERE email='customer@test.dev'",
      ).first<{ id: string }>()
    )?.id ?? '';
});
async function setup(count = 1) {
  const collector = await rpc(
    'collectors.create',
    {
      displayName: '虛構測試外收',
      code: crypto.randomUUID(),
      userId: null,
      isActive: true,
    },
    { cookie: admin },
  );
  expect(collector.status).toBe(200);
  const collectorId = (collector.body as { id: string }).id;
  const chatId = -++sequence,
    topicId = 2;
  const rr = await rpc(
    'telegram.saveRoute',
    {
      chatId: String(chatId),
      topicId,
      routeType: 'collector_report',
      collectorId,
      isActive: true,
    },
    { cookie: admin },
  );
  expect(rr.status).toBe(200);
  const [route] = await base.DB.select()
    .from(telegramRoutes)
    .where(eq(telegramRoutes.id, (rr.body as { id: string }).id));
  const name = `虛構同名 ${crypto.randomUUID()}`;
  const cases = [] as { id: string; assignment: string; code: string }[];
  for (let i = 0; i < count; i++) {
    const c = await makeCase(name);
    await rpc(
      'cases.assign',
      { caseId: c.id, collectorId, expectedVersion: 0, note: '' },
      { cookie: admin },
    );
    const a = await env.DB.prepare(
      'SELECT id FROM assignments WHERE case_id=? AND unassigned_at IS NULL',
    )
      .bind(c.id)
      .first<{ id: string }>();
    cases.push({ ...c, assignment: a?.id ?? '' });
  }
  return { route, name, cases, collectorId };
}
async function makeCase(name: string) {
  const code = `TEST-${crypto.randomUUID().slice(0, 8)}`;
  const c = await rpc(
    'cases.create',
    {
      customerName: name,
      code,
      address: '虛構地址（測試）',
      region: '桃園市',
      amountDue: 50000,
      status: 'pending',
      source: 'manual',
      revisitStatus: 'pending',
      revisitReason: '',
    },
    { cookie: admin },
  );
  expect(c.status).toBe(200);
  return { id: (c.body as { id: string }).id, code };
}
function message(
  route: typeof telegramRoutes.$inferSelect,
  text: string,
): TelegramUpdate {
  return {
    update_id: ++sequence,
    message: {
      message_id: sequence,
      date: 1,
      chat: { id: Number(route.chatId), type: 'supergroup' },
      message_thread_id: route.topicId ?? undefined,
      from: { id: 900001 },
      text,
    },
  };
}
function callback(
  route: typeof telegramRoutes.$inferSelect,
  data: string,
  sender = 900001,
): TelegramUpdate {
  return {
    update_id: ++sequence,
    callback_query: {
      id: String(sequence),
      from: { id: sender },
      data,
      message: {
        message_id: sequence,
        date: 1,
        chat: { id: Number(route.chatId), type: 'supergroup' },
        message_thread_id: route.topicId ?? undefined,
      },
    },
  };
}
async function conversation(route: typeof telegramRoutes.$inferSelect) {
  return env.DB.prepare(
    'SELECT * FROM telegram_report_conversations WHERE route_id=? ORDER BY created_at DESC LIMIT 1',
  )
    .bind(route.id)
    .first<{ id: string; stage: string; case_id: string; report_id: string }>();
}

describe('visible report expiry feedback', () => {
  const expiredText = '回報已逾時失敗，請重新輸入 /回報。';
  async function expire(route: typeof telegramRoutes.$inferSelect) {
    const conv = await conversation(route);
    const created = Date.now() - 120001;
    await env.DB.prepare(
      'UPDATE telegram_report_conversations SET created_at=?,expires_at=? WHERE id=?',
    )
      .bind(created, created + 120000, conv?.id)
      .run();
    return conv;
  }
  it.each([
    'installment',
    'unresolved',
    'follow_up',
    'settled',
    'offset',
  ])('%s expiry sends one visible reply after fast ACK and callback replay never posts again', async (status) => {
    const s = await setup(),
      client = new FakeTelegramClient();
    await immediate(message(s.route, `/回報 ${s.name} 逾時回報測試`), client);
    const conv = await expire(s.route);
    const report = await env.DB.prepare(
      'SELECT callback_token FROM reports WHERE id=?',
    )
      .bind(conv?.report_id)
      .first<{ callback_token: string }>();
    const update = callback(
      s.route,
      `report_status:${report?.callback_token}:${status}`,
    );
    expect((await immediate(update, client)).status).toBe(200);
    expect(
      client.answered.filter((a) => a.id === update.callback_query?.id),
    ).toEqual([{ id: update.callback_query?.id, text: '' }]);
    expect(client.sent.filter((m) => m.text === expiredText)).toHaveLength(1);
    expect(client.sent.at(-1)).toMatchObject({
      chatId: s.route.chatId,
      topicId: s.route.topicId,
    });
    await immediate(update, client);
    await immediate({ ...update, update_id: ++sequence }, client);
    expect(client.sent.filter((m) => m.text === expiredText)).toHaveLength(1);
    expect(
      await env.DB.prepare('SELECT id FROM payments WHERE case_id=?')
        .bind(s.cases[0].id)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare('SELECT status FROM cases WHERE id=?')
        .bind(s.cases[0].id)
        .first(),
    ).toEqual({ status: 'pending' });
  });
  it('expired same-name selection replies visibly without selecting a case', async () => {
    const s = await setup(2),
      client = new FakeTelegramClient();
    await immediate(message(s.route, `/回報 ${s.name}`), client);
    const data =
      client.sent.at(-1)?.replyMarkup?.inline_keyboard[0][0].callback_data;
    await expire(s.route);
    const update = callback(s.route, data ?? '');
    await immediate(update, client);
    await immediate(update, client);
    expect(client.sent.filter((m) => m.text === expiredText)).toHaveLength(1);
    expect(await conversation(s.route)).toMatchObject({
      stage: 'expired',
      case_id: null,
    });
  });
  it.each([
    'settled',
    'offset',
  ])('expired %s amount input replies immediately and creates no financial event', async (status) => {
    const s = await setup(),
      client = new FakeTelegramClient();
    await immediate(message(s.route, `/回報 ${s.name} 金額逾時測試`), client);
    const conv = await conversation(s.route);
    const report = await env.DB.prepare(
      'SELECT callback_token FROM reports WHERE id=?',
    )
      .bind(conv?.report_id)
      .first<{ callback_token: string }>();
    await immediate(
      callback(s.route, `report_status:${report?.callback_token}:${status}`),
      client,
    );
    expect(client.sent.at(-1)?.text).toContain('金額');
    await expire(s.route);
    const update = message(s.route, '5000');
    await immediate(update, client);
    await immediate(update, client);
    expect(client.sent.filter((m) => m.text === expiredText)).toHaveLength(1);
    expect(
      await env.DB.prepare('SELECT id FROM payments WHERE idempotency_key=?')
        .bind(conv?.report_id)
        .first(),
    ).toBeNull();
    expect(await conversation(s.route)).toMatchObject({ stage: 'expired' });
    await immediate(message(s.route, '補充回報文字'), client);
    expect(client.sent.at(-1)?.text).toBe(expiredText);
  });
  it('cron-style scans never retry failed DELIVERY_UNKNOWN even when next_attempt_at is overdue', async () => {
    const s = await setup(),
      client = new FakeTelegramClient(),
      key = `uncertain-expiry-test:${crypto.randomUUID()}`;
    await queueTelegramMessage(base, s.route, key, key);
    await env.DB.prepare(
      "UPDATE telegram_outbound_jobs SET status='failed',last_error_code='DELIVERY_UNKNOWN',attempts=1,next_attempt_at=?,lease_until=NULL WHERE dedupe_key=?",
    )
      .bind(Date.now() - 60000, key)
      .run();
    const snapshot = () =>
      env.DB.prepare(
        'SELECT status,last_error_code,attempts,telegram_message_id,sent_at FROM telegram_outbound_jobs WHERE dedupe_key=?',
      )
        .bind(key)
        .first();
    const before = await snapshot();
    await processOutbound(base, client);
    await processOutbound(base, client, Date.now() + 3600000);
    expect(await snapshot()).toEqual(before);
    expect(client.sent.some((message) => message.text === key)).toBe(false);
    expect(
      await env.DB.prepare('SELECT unassigned_at FROM assignments WHERE id=?')
        .bind(s.cases[0].assignment)
        .first(),
    ).toEqual({ unassigned_at: null });
  });
  it('an expired Telegram callback query does not suppress the durable visible hint', async () => {
    class OldCallbackClient extends FakeTelegramClient {
      override async answerCallbackQuery() {
        throw new Error('query expired');
      }
    }
    const s = await setup(),
      client = new OldCallbackClient();
    await immediate(message(s.route, `/回報 ${s.name} 舊按鈕測試`), client);
    const conv = await expire(s.route);
    const report = await env.DB.prepare(
      'SELECT callback_token FROM reports WHERE id=?',
    )
      .bind(conv?.report_id)
      .first<{ callback_token: string }>();
    await immediate(
      callback(s.route, `report_status:${report?.callback_token}:unresolved`),
      client,
    );
    expect(client.sent.filter((m) => m.text === expiredText)).toHaveLength(1);
  });
});

describe('Simplified manual report states', () => {
  it('fixed two-minute lifetime survives case selection and content; expiry audits once and blocks every status', async () => {
    const s = await setup(2),
      client = new FakeTelegramClient();
    const start = message(s.route, `/回報 ${s.name}`);
    await processReportCommand(base, start, s.route);
    const conv = await conversation(s.route);
    const deadline = () =>
      env.DB.prepare(
        'SELECT created_at,expires_at FROM telegram_report_conversations WHERE id=?',
      )
        .bind(conv?.id)
        .first<{ created_at: number; expires_at: number }>();
    const initial = await deadline();
    expect((initial?.expires_at ?? 0) - (initial?.created_at ?? 0)).toBe(
      120000,
    );
    const prompt = await payload(`command-reply:${start.update_id}`);
    await processReportCaseCallback(
      base,
      callback(s.route, prompt.replyMarkup.inline_keyboard[0][0].callback_data),
      s.route,
      client,
    );
    expect(await deadline()).toEqual(initial);
    const result = await processReportContent(
      base,
      message(s.route, '虛構回報內容'),
      s.route,
    );
    expect(await deadline()).toEqual(initial);
    const report = await env.DB.prepare(
      'SELECT callback_token FROM reports WHERE id=?',
    )
      .bind(result?.reportId)
      .first<{ callback_token: string }>();
    await env.DB.prepare(
      'UPDATE telegram_report_conversations SET expires_at=? WHERE id=?',
    )
      .bind(Date.now() - 1, conv?.id)
      .run();
    for (const status of [
      'settled',
      'installment',
      'unresolved',
      'offset',
      'follow_up',
    ]) {
      expect(
        await processReportStatusCallback(
          base,
          callback(
            s.route,
            `report_status:${report?.callback_token}:${status}`,
          ),
          s.route,
          client,
        ),
      ).toMatchObject({ code: 'CALLBACK_DENIED' });
    }
    expect((await conversation(s.route))?.stage).toBe('expired');
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_logs WHERE entity_id=? AND action='TELEGRAM_REPORT_EXPIRED'",
      )
        .bind(conv?.id)
        .first(),
    ).toEqual({ n: 1 });
    expect(
      await env.DB.prepare('SELECT id FROM payments WHERE idempotency_key=?')
        .bind(result?.reportId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare('SELECT workflow_status FROM reports WHERE id=?')
        .bind(result?.reportId)
        .first(),
    ).toEqual({ workflow_status: 'awaiting_status' });
  });
  it.each([
    'unresolved',
    'follow_up',
    'installment',
  ])('%s completes with original content, no questionnaire or schedules, and replay is safe', async (status) => {
    const s = await setup(),
      client = new FakeTelegramClient();
    await env.DB.prepare("UPDATE cases SET status='installment' WHERE id=?")
      .bind(s.cases[0].id)
      .run();
    await immediate(
      message(s.route, `/回報 ${s.name} 家人說每月10號會處理`),
      client,
    );
    const conv = await conversation(s.route);
    const token = await env.DB.prepare(
      'SELECT callback_token FROM reports WHERE id=?',
    )
      .bind(conv?.report_id)
      .first<{ callback_token: string }>();
    const action = callback(
      s.route,
      `report_status:${token?.callback_token}:${status}`,
      900002,
    );
    await immediate(action, client);
    await immediate(action, client);
    await immediate(
      callback(s.route, action.callback_query?.data ?? '', 900003),
      client,
    );
    expect(
      await env.DB.prepare('SELECT status FROM cases WHERE id=?')
        .bind(s.cases[0].id)
        .first(),
    ).toMatchObject({ status });
    expect(
      await env.DB.prepare(
        'SELECT content,status,workflow_status FROM reports WHERE id=?',
      )
        .bind(conv?.report_id)
        .first(),
    ).toMatchObject({
      content: '家人說每月10號會處理',
      status,
      workflow_status: 'completed',
    });
    expect((await conversation(s.route))?.stage).toBe('completed');
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS n FROM installment_plans WHERE case_id=?',
      )
        .bind(s.cases[0].id)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS n FROM installment_workflows WHERE report_id=?',
      )
        .bind(conv?.report_id)
        .first(),
    ).toEqual({ n: 0 });
    expect(client.sent.at(-1)?.text).toContain('已完成回報');
    expect(client.sent.map((m) => m.text).join('\n')).not.toMatch(
      /本次收款|首次付款|固定每週|固定每月|分期期數|下次付款/,
    );
    expect(
      await listTracking(
        await telegramPrincipal(base, s.route.managedByUserId),
        { query: s.name },
      ),
    ).toMatchObject({ total: status === 'installment' ? 1 : 0 });
  });
  it('repeated installment reports update latest content without a duplicate tracker; follow-up leaves the list', async () => {
    const s = await setup(),
      client = new FakeTelegramClient();
    for (const [content, status] of [
      ['月底再聯絡', 'installment'],
      ['家人說十號處理', 'installment'],
      ['安排二訪', 'follow_up'],
    ]) {
      await immediate(message(s.route, `/回報 ${s.name} ${content}`), client);
      const conv = await conversation(s.route),
        token = await env.DB.prepare(
          'SELECT callback_token FROM reports WHERE id=?',
        )
          .bind(conv?.report_id)
          .first<{ callback_token: string }>();
      await immediate(
        callback(s.route, `report_status:${token?.callback_token}:${status}`),
        client,
      );
      const list = await rpc(
        'installments.trackingList',
        { query: s.name },
        { cookie: admin },
      );
      expect(list.body).toMatchObject({
        total: status === 'installment' ? 1 : 0,
      });
      if (status === 'installment')
        expect(list.body).toMatchObject({ items: [{ latestReport: content }] });
    }
    expect(
      await env.DB.prepare('SELECT count(*) AS n FROM reports WHERE case_id=?')
        .bind(s.cases[0].id)
        .first(),
    ).toEqual({ n: 3 });
  });
  it.each([
    'settled',
    'offset',
  ])('%s asks only amount and commits payment/status/conversation using original report day', async (status) => {
    const s = await setup(),
      client = new FakeTelegramClient();
    await env.DB.prepare("UPDATE cases SET status='installment' WHERE id=?")
      .bind(s.cases[0].id)
      .run();
    const settings = await rpc('collectorFinance.settings', undefined, {
      cookie: admin,
    });
    expect(
      (
        await rpc(
          'collectorFinance.setRate',
          {
            collectorId: s.collectorId,
            kind: 'return',
            rate: 0.5,
            expectedVersion: (settings.body as { version: number }).version,
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    const start = message(s.route, `/回報 ${s.name} 已處理的原始內容`);
    if (start.message)
      start.message.date = Math.floor((Date.now() - 86400000) / 1000);
    await immediate(start, client);
    const conv = await conversation(s.route),
      token = await env.DB.prepare(
        'SELECT callback_token FROM reports WHERE id=?',
      )
        .bind(conv?.report_id)
        .first<{ callback_token: string }>();
    await immediate(
      callback(s.route, `report_status:${token?.callback_token}:${status}`),
      client,
    );
    expect(client.sent.at(-1)?.text).toContain(
      status === 'settled'
        ? '請輸入本次實際收款金額'
        : '請輸入客戶本次直接匯給案主的金額',
    );
    const amount = message(s.route, '15000');
    await immediate(amount, client);
    await immediate(amount, client);
    const date = new Date((start.message?.date ?? 0) * 1000).toLocaleDateString(
      'en-CA',
      { timeZone: 'Asia/Taipei' },
    );
    expect(
      await env.DB.prepare(
        'SELECT received_amount,received_date,channel FROM payments WHERE idempotency_key=?',
      )
        .bind(conv?.report_id)
        .first(),
    ).toMatchObject({
      received_amount: 15000,
      received_date: date,
      channel:
        status === 'offset' ? 'direct_to_principal' : 'collector_received',
    });
    expect(
      await env.DB.prepare(
        'SELECT content,workflow_status FROM reports WHERE id=?',
      )
        .bind(conv?.report_id)
        .first(),
    ).toMatchObject({
      content: '已處理的原始內容',
      workflow_status: 'completed',
    });
    expect((await conversation(s.route))?.stage).toBe('completed');
    expect(
      (
        await rpc(
          'installments.trackingList',
          { query: s.name },
          { cookie: admin },
        )
      ).body,
    ).toMatchObject({ total: 0 });
    expect(
      (await rpc('cases.detail', { id: s.cases[0].id }, { cookie: admin }))
        .body,
    ).toMatchObject({
      status: status === 'offset' ? 'direct_to_principal' : 'settled',
    });
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS n FROM payments WHERE idempotency_key=?',
      )
        .bind(conv?.report_id)
        .first(),
    ).toEqual({ n: 1 });
    if (status === 'offset')
      expect(
        await env.DB.prepare(
          'SELECT collector_received_amount,principal_return_due_from_collector,collector_entitlement FROM settlements WHERE case_id=?',
        )
          .bind(s.cases[0].id)
          .first(),
      ).toMatchObject({
        collector_received_amount: 0,
        principal_return_due_from_collector: 0,
        collector_entitlement: 7500,
      });
  });
  it('report status transaction rolls back case, report and conversation together on failure', async () => {
    const s = await setup(),
      client = new FakeTelegramClient();
    await immediate(message(s.route, `/回報 ${s.name} 原始測試內容`), client);
    const conv = await conversation(s.route),
      row = await env.DB.prepare(
        'SELECT callback_token FROM reports WHERE id=?',
      )
        .bind(conv?.report_id)
        .first<{ callback_token: string }>();
    await env.DB.exec(
      "CREATE TRIGGER test_report_status_abort BEFORE UPDATE OF status ON reports WHEN NEW.status='installment' BEGIN SELECT RAISE(ABORT,'TEST_STATUS_ROLLBACK'); END;",
    );
    try {
      await expect(
        processReportStatusCallback(
          base,
          callback(s.route, `report_status:${row?.callback_token}:installment`),
          s.route,
          client,
        ),
      ).rejects.toThrow();
      expect(
        await env.DB.prepare('SELECT status FROM cases WHERE id=?')
          .bind(s.cases[0].id)
          .first(),
      ).toMatchObject({ status: 'pending' });
      expect(
        await env.DB.prepare('SELECT workflow_status FROM reports WHERE id=?')
          .bind(conv?.report_id)
          .first(),
      ).toMatchObject({ workflow_status: 'awaiting_status' });
      expect((await conversation(s.route))?.stage).toBe('status');
    } finally {
      await env.DB.exec('DROP TRIGGER test_report_status_abort;');
    }
  });
  it('tracking enforces own collector scope, active assignment and void checks', async () => {
    const a = await setup(),
      b = await setup(),
      client = new FakeTelegramClient();
    for (const s of [a, b]) {
      await immediate(message(s.route, `/回報 ${s.name} 分期追蹤`), client);
      const conv = await conversation(s.route),
        token = await env.DB.prepare(
          'SELECT callback_token FROM reports WHERE id=?',
        )
          .bind(conv?.report_id)
          .first<{ callback_token: string }>();
      await immediate(
        callback(s.route, `report_status:${token?.callback_token}:installment`),
        client,
      );
    }
    await env.DB.prepare('UPDATE collectors SET user_id=? WHERE id=?')
      .bind(_uid, a.collectorId)
      .run();
    const ordinary = await userCookie();
    expect(
      (
        await rpc(
          'installments.trackingList',
          { query: b.name },
          { cookie: ordinary },
        )
      ).body,
    ).toMatchObject({ total: 0 });
    expect(
      (
        await rpc(
          'installments.trackingList',
          { query: a.name },
          { cookie: ordinary },
        )
      ).body,
    ).toMatchObject({ total: 1 });
    expect(
      (
        await rpc(
          'installments.trackingList',
          { collectorId: b.collectorId },
          { cookie: ordinary },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await rpc(
          'installments.trackingList',
          { collectorId: b.collectorId },
          { cookie: admin },
        )
      ).body,
    ).toMatchObject({ total: 1 });
    await env.DB.prepare('UPDATE cases SET voided_at=? WHERE id=?')
      .bind(Date.now(), a.cases[0].id)
      .run();
    expect(
      (
        await rpc(
          'installments.trackingList',
          { query: a.name },
          { cookie: ordinary },
        )
      ).body,
    ).toMatchObject({ total: 0 });
  });
});
async function payload(key: string) {
  const j = await env.DB.prepare(
    'SELECT payload FROM telegram_outbound_jobs WHERE dedupe_key=?',
  )
    .bind(key)
    .first<{ payload: string }>();
  return JSON.parse(j?.payload ?? '{}');
}
describe('Name-only Telegram report conversation', () => {
  it('normalizes exact names without code guessing', () => {
    expect(normalizeReportName('  王小明　 ')).toBe('王小明');
    expect(parseReportCommand('/回報 王小明')).toEqual({ name: '王小明' });
    expect(parseReportCommand('/回報@abctest888_bot 王小明')).toEqual({
      name: '王小明',
    });
    expect(parseReportCommand('  /回報 王小明  ')).toEqual({ name: '王小明' });
    expect(parseReportCommand('/回報')).toBeNull();
  });
  it('unique name prompts for content and preserves manual status workflow without AI', async () => {
    const t = await setup();
    const other = await makeCase(t.name);
    const start = message(t.route, `/回報 ${t.name}`);
    expect(await processReportCommand(base, start, t.route)).toMatchObject({
      code: 'AWAITING_REPORT_CONTENT',
    });
    const prompt = await payload(`command-reply:${start.update_id}`);
    expect(prompt.text).toContain(`${t.cases[0].code}｜${t.name}｜桃園市`);
    expect(prompt.text).not.toContain(other.code);
    const next = message(t.route, '今天有找到本人，說15號會處理');
    const result = await processReportContent(base, next, t.route);
    expect(result?.code).toBe('REPORT_PENDING');
    const report = await env.DB.prepare(
      'SELECT content,status,workflow_status,callback_token FROM reports WHERE id=?',
    )
      .bind(result?.reportId)
      .first<{
        content: string;
        status: string;
        workflow_status: string;
        callback_token: string;
      }>();
    expect(report).toMatchObject({
      content: '今天有找到本人，說15號會處理',
      status: 'needs_review',
      workflow_status: 'awaiting_status',
    });
    const keyboard = await payload(`report-status-prompt:${result?.reportId}`);
    expect(
      keyboard.replyMarkup.inline_keyboard.map(
        (r: { text: string }[]) => r[0].text,
      ),
    ).toEqual(['✅ 結清', '💰 分期', '🏦 後結', '❌ 無解', '🔁 安排二訪']);
    expect(
      (
        await env.DB.prepare('SELECT status FROM cases WHERE id=?')
          .bind(t.cases[0].id)
          .first()
      )?.status,
    ).toBe('pending');
    expect(
      await env.DB.prepare('SELECT id FROM ai_image_jobs WHERE intake_id=?')
        .bind(t.cases[0].id)
        .first(),
    ).toBeNull();
    const client = new FakeTelegramClient();
    expect(
      await processReportStatusCallback(
        base,
        callback(t.route, `report_status:${report?.callback_token}:follow_up`),
        t.route,
        client,
      ),
    ).toMatchObject({ code: 'REPORT_COMPLETED' });
    expect(
      (
        await env.DB.prepare('SELECT status FROM cases WHERE id=?')
          .bind(t.cases[0].id)
          .first()
      )?.status,
    ).toBe('follow_up');
  });
  it('duplicate names show safe inline choices; chosen case receives content; repeated callback is idempotent', async () => {
    const t = await setup(2);
    const start = message(t.route, `/回報 ${t.name}`);
    expect(await processReportCommand(base, start, t.route)).toMatchObject({
      code: 'AMBIGUOUS',
    });
    const p = await payload(`command-reply:${start.update_id}`);
    expect(p.text).toContain('找到多筆同名案件');
    expect(p.replyMarkup.inline_keyboard).toHaveLength(2);
    const data = p.replyMarkup.inline_keyboard[1][0].callback_data;
    expect(data.length).toBeLessThanOrEqual(64);
    expect(data).not.toContain(t.name);
    const client = new FakeTelegramClient();
    const cb = callback(t.route, data, 900002);
    expect(
      await processReportCaseCallback(base, cb, t.route, client),
    ).toMatchObject({ code: 'AWAITING_REPORT_CONTENT' });
    expect(
      await processReportCaseCallback(
        base,
        callback(t.route, data),
        t.route,
        client,
      ),
    ).toMatchObject({ code: 'CASE_ALREADY_SELECTED' });
    const state = await conversation(t.route);
    const continuation = message(t.route, '第二案內容');
    if (continuation.message?.from) continuation.message.from.id = 900003;
    const result = await processReportContent(base, continuation, t.route);
    expect(
      await env.DB.prepare('SELECT case_id,content FROM reports WHERE id=?')
        .bind(result?.reportId)
        .first(),
    ).toMatchObject({ case_id: state?.case_id, content: '第二案內容' });
  });
  for (const kind of [
    'other route',
    'unassigned',
    'voided',
    'expired',
  ] as const)
    it(`rejects selection after ${kind}`, async () => {
      const t = await setup(2);
      const start = message(t.route, `/回報 ${t.name}`);
      await processReportCommand(base, start, t.route);
      const p = await payload(`command-reply:${start.update_id}`);
      const data = p.replyMarkup.inline_keyboard[0][0].callback_data;
      const state = await conversation(t.route);
      const candidates = JSON.parse(
        (
          await env.DB.prepare(
            'SELECT candidates FROM telegram_report_conversations WHERE id=?',
          )
            .bind(state?.id)
            .first<{ candidates: string }>()
        )?.candidates ?? '[]',
      );
      if (kind === 'unassigned')
        await env.DB.prepare(
          'UPDATE assignments SET unassigned_at=? WHERE id=?',
        )
          .bind(Date.now(), candidates[0].assignment_id)
          .run();
      if (kind === 'voided')
        await env.DB.prepare('UPDATE cases SET voided_at=? WHERE id=?')
          .bind(Date.now(), candidates[0].id)
          .run();
      if (kind === 'expired')
        await env.DB.prepare(
          'UPDATE telegram_report_conversations SET expires_at=0 WHERE id=?',
        )
          .bind(state?.id)
          .run();
      const target = kind === 'other route' ? (await setup()).route : t.route;
      expect(
        await processReportCaseCallback(
          base,
          callback(target, data, 900001),
          target,
          new FakeTelegramClient(),
        ),
      ).toMatchObject({ code: 'CALLBACK_DENIED' });
      expect((await conversation(t.route))?.stage).toBe(
        kind === 'expired' ? 'expired' : 'selecting',
      );
    });
  it('unknown name returns Chinese response and code is not treated as name', async () => {
    const t = await setup();
    for (const name of ['沒有此虛構姓名', t.cases[0].code]) {
      const u = message(t.route, `/回報 ${name}`);
      expect(await processReportCommand(base, u, t.route)).toMatchObject({
        code: 'CASE_DENIED',
      });
      expect((await payload(`command-reply:${u.update_id}`)).text).toBe(
        `找不到「${name}」的可回報案件。\n請確認姓名是否正確。`,
      );
    }
  });
  it('inactive collector denies and logs; missing collector is safe', async () => {
    const t = await setup();
    await env.DB.prepare('UPDATE collectors SET is_active=0 WHERE id=?')
      .bind(t.collectorId)
      .run();
    expect(
      await processReportCommand(
        base,
        message(t.route, `/回報 ${t.name}`),
        t.route,
      ),
    ).toMatchObject({ code: 'ROUTE_DENIED' });
    expect(
      await env.DB.prepare(
        "SELECT id FROM system_logs WHERE event='REPORT_ROUTE_DENIED' AND related_route_id=?",
      )
        .bind(t.route.id)
        .first(),
    ).toBeTruthy();
    expect(
      await processReportCommand(base, message(t.route, `/回報 ${t.name}`), {
        ...t.route,
        collectorId: null,
      }),
    ).toMatchObject({ code: 'ROUTE_DENIED' });
  });
  it('new command cancels old draft and old callbacks', async () => {
    const t = await setup(2);
    const first = message(t.route, `/回報 ${t.name}`);
    await processReportCommand(base, first, t.route);
    const data = (await payload(`command-reply:${first.update_id}`)).replyMarkup
      .inline_keyboard[0][0].callback_data;
    const old = await conversation(t.route);
    await processReportCommand(
      base,
      message(t.route, '/回報 沒有此虛構姓名'),
      t.route,
    );
    expect(
      (
        await env.DB.prepare(
          'SELECT stage FROM telegram_report_conversations WHERE id=?',
        )
          .bind(old?.id)
          .first()
      )?.stage,
    ).toBe('cancelled');
    expect(
      await processReportCaseCallback(
        base,
        callback(t.route, data),
        t.route,
        new FakeTelegramClient(),
      ),
    ).toMatchObject({ code: 'CALLBACK_DENIED' });
  });
  it('content timeout requires new command', async () => {
    const t = await setup();
    await processReportCommand(
      base,
      message(t.route, `/回報 ${t.name}`),
      t.route,
    );
    await env.DB.prepare(
      'UPDATE telegram_report_conversations SET expires_at=0 WHERE route_id=?',
    )
      .bind(t.route.id)
      .run();
    const u = message(t.route, '過期內容');
    expect(await processReportContent(base, u, t.route)).toMatchObject({
      code: 'REPORT_DRAFT_EXPIRED',
    });
    expect((await payload(`command-reply:${u.update_id}`)).text).toContain(
      '回報已逾時失敗，請重新輸入 /回報。',
    );
  });
  it('assignment revoke and void reject content', async () => {
    for (const kind of ['unassigned', 'void']) {
      const t = await setup();
      await processReportCommand(
        base,
        message(t.route, `/回報 ${t.name}`),
        t.route,
      );
      if (kind === 'unassigned')
        await env.DB.prepare(
          'UPDATE assignments SET unassigned_at=? WHERE id=?',
        )
          .bind(Date.now(), t.cases[0].assignment)
          .run();
      else
        await env.DB.prepare('UPDATE cases SET voided_at=? WHERE id=?')
          .bind(Date.now(), t.cases[0].id)
          .run();
      expect(
        await processReportContent(base, message(t.route, '不能建立'), t.route),
      ).toMatchObject({ code: 'CASE_DENIED' });
    }
  });
  it('retry content creates one report', async () => {
    const t = await setup();
    await processReportCommand(
      base,
      message(t.route, `/回報 ${t.name}`),
      t.route,
    );
    const content = message(t.route, '重送內容');
    const a = await processReportContent(base, content, t.route);
    const b = await processReportContent(base, content, t.route);
    expect(b?.reportId).toBe(a?.reportId);
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM reports WHERE origin_key=?',
        )
          .bind(`telegram-update:${content.update_id}`)
          .first()
      )?.n,
    ).toBe(1);
  });
  it('route not configured replies and logs instead of silently ignoring', async () => {
    const t = await setup();
    const u = message(
      { ...t.route, chatId: String(-++sequence) },
      `/回報 ${t.name}`,
    );
    await receiveTelegramUpdate(base, u);
    const client = new FakeTelegramClient();
    await processTelegramUpdates(base, client, Date.now() + 1000);
    expect(
      client.sent.some((m) => m.text.includes('尚未設定有效回報群組')),
    ).toBe(true);
  });
  it('more than six candidates are paged without discarding matches', async () => {
    const t = await setup(9);
    const start = message(t.route, `/回報 ${t.name}`);
    await processReportCommand(base, start, t.route);
    const p = await payload(`command-reply:${start.update_id}`);
    expect(p.replyMarkup.inline_keyboard).toHaveLength(7);
    const data = p.replyMarkup.inline_keyboard[6][0].callback_data;
    const cb = callback(t.route, data);
    expect(
      await processReportCaseCallback(
        base,
        cb,
        t.route,
        new FakeTelegramClient(),
      ),
    ).toMatchObject({ code: 'AMBIGUOUS' });
    const page = await payload(`report-candidate-page:${cb.update_id}`);
    expect(page.replyMarkup.inline_keyboard).toHaveLength(4);
  });
  it('cancelled settlement draft cannot accept payment or old status callback', async () => {
    const t = await setup();
    await processReportCommand(
      base,
      message(t.route, `/回報 ${t.name}`),
      t.route,
    );
    const r = await processReportContent(
      base,
      message(t.route, '已說明但尚未收款'),
      t.route,
    );
    const report = await env.DB.prepare(
      'SELECT callback_token FROM reports WHERE id=?',
    )
      .bind(r?.reportId)
      .first<{ callback_token: string }>();
    const data = `report_status:${report?.callback_token}:settled`;
    const client = new FakeTelegramClient();
    expect(
      await processReportStatusCallback(
        base,
        callback(t.route, data),
        t.route,
        client,
      ),
    ).toMatchObject({ code: 'PAYMENT_AMOUNT_REQUIRED' });
    await processReportCommand(
      base,
      message(t.route, '/回報 未存在測試姓名'),
      t.route,
    );
    expect(
      await processTelegramPayment(
        base,
        message(t.route, '15000'),
        t.route,
        client,
      ),
    ).toBeNull();
    expect(
      await processReportStatusCallback(
        base,
        callback(t.route, data),
        t.route,
        client,
      ),
    ).toMatchObject({ code: 'CALLBACK_DENIED' });
    expect(
      await env.DB.prepare('SELECT id FROM payments WHERE idempotency_key=?')
        .bind(r?.reportId)
        .first(),
    ).toBeNull();
  });
  it('status timeout denies old buttons', async () => {
    const t = await setup();
    await processReportCommand(
      base,
      message(t.route, `/回報 ${t.name}`),
      t.route,
    );
    const r = await processReportContent(
      base,
      message(t.route, '測試內容'),
      t.route,
    );
    const report = await env.DB.prepare(
      'SELECT callback_token FROM reports WHERE id=?',
    )
      .bind(r?.reportId)
      .first<{ callback_token: string }>();
    await env.DB.prepare(
      'UPDATE telegram_report_conversations SET expires_at=0 WHERE report_id=?',
    )
      .bind(r?.reportId)
      .run();
    expect(
      await processReportStatusCallback(
        base,
        callback(t.route, `report_status:${report?.callback_token}:unresolved`),
        t.route,
        new FakeTelegramClient(),
      ),
    ).toMatchObject({ code: 'CALLBACK_DENIED' });
  });
  it('explicit report permission denial rejects route principal', async () => {
    const t = await setup();
    await env.DB.prepare('UPDATE user SET permission_deny=? WHERE email=?')
      .bind(JSON.stringify(['report.create']), 'boss@test.dev')
      .run();
    try {
      expect(
        await processReportCommand(
          base,
          message(t.route, `/回報 ${t.name}`),
          t.route,
        ),
      ).toMatchObject({ code: 'ROUTE_DENIED' });
    } finally {
      await env.DB.prepare('UPDATE user SET permission_deny=? WHERE email=?')
        .bind('[]', 'boss@test.dev')
        .run();
    }
  });
  it('report images remain ignored without intake or extraction jobs', async () => {
    const t = await setup();
    const before = (
      await env.DB.prepare('SELECT count(*) AS n FROM ai_image_jobs').first()
    )?.n;
    const u = message(t.route, '');
    if (u.message) {
      delete u.message.text;
      u.message.photo = [{ file_id: 'fictional-ignore-id', file_size: 100 }];
    }
    await receiveTelegramUpdate(base, u);
    await processTelegramUpdates(
      base,
      new FakeTelegramClient(),
      Date.now() + 1000,
      String(u.update_id),
    );
    expect(
      await env.DB.prepare(
        'SELECT result_code,intake_id FROM telegram_updates WHERE id=?',
      )
        .bind(String(u.update_id))
        .first(),
    ).toMatchObject({
      result_code: 'REPORT_MEDIA_NO_ACTIVE_DRAFT',
      intake_id: null,
    });
    expect(
      (await env.DB.prepare('SELECT count(*) AS n FROM ai_image_jobs').first())
        ?.n,
    ).toBe(before);
  });
});

function photo(
  route: typeof telegramRoutes.$inferSelect,
  caption?: string,
  group?: string,
) {
  const u = message(route, '');
  if (u.message) {
    delete u.message.text;
    u.message.photo = [{ file_id: 'fictional-report-photo-reference' }];
    u.message.caption = caption;
    u.message.media_group_id = group;
  }
  return u;
}
async function completedMediaFixture(count: number) {
  const s = await setup(),
    client = new FakeTelegramClient();
  await immediate(message(s.route, `/回報 ${s.name} 家裡沒人電話沒接`), client);
  const conv = await conversation(s.route);
  for (let i = 0; i < count; i++)
    await immediate(
      photo(
        s.route,
        undefined,
        `fictional-album-${conv?.id}-${Math.floor(i / 10)}`,
      ),
      client,
    );
  await env.DB.prepare(
    'UPDATE telegram_report_media SET received_at=? WHERE conversation_id=?',
  )
    .bind(Date.now() - 5000, conv?.id)
    .run();
  const report = await env.DB.prepare(
    'SELECT callback_token FROM reports WHERE id=?',
  )
    .bind(conv?.report_id)
    .first<{ callback_token: string }>();
  await immediate(
    callback(s.route, `report_status:${report?.callback_token}:follow_up`),
    client,
  );
  const rr = await rpc(
    'telegram.saveRoute',
    {
      chatId: String(-++sequence),
      topicId: 3,
      routeType: 'business_report',
      collectorId: s.collectorId,
      isActive: true,
    },
    { cookie: admin },
  );
  const routeId = (rr.body as { id: string }).id;
  await queueReportDestination(base, conv?.report_id ?? '');
  // Isolate this fixture's destination from unrelated pending replies and
  // business routes left by earlier tests in the same D1 test database.
  await env.DB.prepare(
    "UPDATE telegram_outbound_jobs SET next_attempt_at=? WHERE status='pending' AND route_id<>?",
  )
    .bind(Date.now() + 1000000000, routeId)
    .run();
  return { s, client, conv, routeId };
}
describe('Telegram report pictures without storage or AI', () => {
  it('serializes concurrent text and image deliveries and holds later jobs during a media retry', async () => {
    const f = await completedMediaFixture(2);
    const first = await env.DB.prepare(
      'SELECT id,payload FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
    )
      .bind(f.conv?.report_id, f.routeId)
      .first<{ id: string; payload: string }>();
    const secondId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO telegram_outbound_jobs(id,dedupe_key,message_type,report_id,route_id,payload,status,attempts,next_attempt_at,created_at) VALUES(?,?,'report_destination',?,?,?,'pending',0,?,?)",
    )
      .bind(
        secondId,
        crypto.randomUUID(),
        f.conv?.report_id,
        f.routeId,
        first?.payload,
        Date.now(),
        Date.now() + 1,
      )
      .run();
    const events: string[] = [];
    const send = f.client.sendMessage.bind(f.client),
      copy = f.client.copyReportMedia.bind(f.client);
    f.client.sendMessage = async (input) => {
      events.push('text');
      return await send(input);
    };
    f.client.copyReportMedia = async (input) => {
      events.push('pictures');
      return await copy(input);
    };
    await Promise.all([
      processOutbound(base, f.client, Date.now() + 10000),
      processOutbound(base, f.client, Date.now() + 10000),
    ]);
    // A competing processor may defer the second job until the next pass.
    await processOutbound(base, f.client, Date.now() + 10000);
    expect(events).toEqual(['pictures', 'pictures']);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM telegram_outbound_jobs WHERE id IN (?,?) AND status='sent'",
        )
          .bind(first?.id, secondId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);

    const retry = await completedMediaFixture(2);
    const job = await env.DB.prepare(
      'SELECT id,payload FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
    )
      .bind(retry.conv?.report_id, retry.routeId)
      .first<{ id: string; payload: string }>();
    retry.client.captionFailures = 1;
    await processOutbound(base, retry.client, Date.now() + 10000);
    const laterId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO telegram_outbound_jobs(id,dedupe_key,message_type,report_id,route_id,payload,status,attempts,next_attempt_at,created_at) VALUES(?,?,'report_destination',?,?,?,'pending',0,?,?)",
    )
      .bind(
        laterId,
        crypto.randomUUID(),
        retry.conv?.report_id,
        retry.routeId,
        job?.payload,
        Date.now(),
        Date.now(),
      )
      .run();
    const sent = retry.client.sent.length;
    await env.DB.prepare(
      'UPDATE telegram_outbound_jobs SET next_attempt_at=? WHERE id=?',
    )
      .bind(Date.now() + 1000000, job?.id)
      .run();
    await processOutbound(base, retry.client, Date.now() + 10000);
    expect(retry.client.sent).toHaveLength(sent);
    const [destination] = await base.DB.select()
      .from(telegramRoutes)
      .where(eq(telegramRoutes.id, retry.routeId));
    const replyKey = `serialized-reply:${crypto.randomUUID()}`;
    await queueTelegramMessage(
      base,
      destination,
      replyKey,
      '安全測試提示',
      null,
      {
        commandReply: true,
      },
    );
    await processOutbound(
      base,
      retry.client,
      Date.now() + 10000,
      replyKey,
      destination,
    );
    expect(retry.client.sent).toHaveLength(sent);
    expect(
      (
        await env.DB.prepare(
          'SELECT status FROM telegram_outbound_jobs WHERE id=?',
        )
          .bind(laterId)
          .first()
      )?.status,
    ).toBe('pending');
    await processOutbound(base, retry.client, Date.now() + 2000000);
    await processOutbound(base, retry.client, Date.now() + 2000000);
    expect(retry.client.copiedMedia).toHaveLength(2);
  });
  it.each([
    0, 1, 2,
  ])('forwards text plus %i pictures without creating private media', async (count) => {
    const f = await completedMediaFixture(count);
    await processOutbound(base, f.client, Date.now() + 100000);
    expect(f.client.copiedMedia.flatMap((m) => m.messageIds)).toHaveLength(
      count,
    );
    if (count) {
      const caption = f.client.copiedMedia[0].caption ?? '';
      expect(caption.split('\n').map((line) => line.split('：')[0])).toEqual([
        '代號',
        '客戶姓名',
        '回報內容',
        '日期',
      ]);
      expect(
        f.client.sent.some((m) => m.chatId === f.client.copiedMedia[0].chatId),
      ).toBe(false);
      expect(f.client.editedCaptions).toHaveLength(count > 1 ? 1 : 0);
    }
    expect(
      (
        await env.DB.prepare(
          'SELECT status FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
        )
          .bind(f.conv?.report_id, f.routeId)
          .first()
      )?.status,
    ).toBe('sent');
    expect(f.client.downloads).toHaveLength(0);
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM case_media WHERE case_id=?',
        )
          .bind(f.s.cases[0].id)
          .first()
      )?.n,
    ).toBe(0);
  });
  it('inline text creates the manual status prompt immediately', async () => {
    const s = await setup(),
      client = new FakeTelegramClient();
    await immediate(
      message(s.route, `/回報 ${s.name} 家裡沒人電話沒接`),
      client,
    );
    expect(client.sent.at(-1)?.text).toContain('回報內容：家裡沒人電話沒接');
    expect(client.sent.at(-1)?.text).toContain('圖片張數：0');
    expect(client.sent.at(-1)?.replyMarkup?.inline_keyboard).toHaveLength(5);
  });
  it('caption album preserves order, dedupes receipts and uses no downloads', async () => {
    const s = await setup(),
      client = new FakeTelegramClient(),
      group = crypto.randomUUID();
    const first = photo(s.route, `/回報 ${s.name} 虛構照片回報`, group);
    const second = photo(s.route, undefined, group);
    await immediate(first, client);
    await immediate(second, client);
    await immediate(second, client);
    const conv = await conversation(s.route);
    const media = await env.DB.prepare(
      'SELECT message_id FROM telegram_report_media WHERE conversation_id=? ORDER BY message_id',
    )
      .bind(conv?.id)
      .all<{ message_id: number }>();
    expect(media.results.map((r) => r.message_id)).toEqual([
      first.message?.message_id,
      second.message?.message_id,
    ]);
    expect(client.downloads).toHaveLength(0);
    expect(client.editedPrompts.at(-1)?.input.text).toContain('圖片張數：2');
    const receipt = await env.DB.prepare(
      'SELECT intake_id,result_code,payload FROM telegram_updates WHERE id=?',
    )
      .bind(String(second.update_id))
      .first();
    expect(receipt).toMatchObject({
      intake_id: null,
      result_code: 'REPORT_MEDIA_RECEIVED',
      payload: '{}',
    });
  });
  it('same names retain inline content until a candidate is chosen', async () => {
    const s = await setup(2),
      client = new FakeTelegramClient();
    await immediate(
      photo(s.route, `/回報 ${s.name} 虛構同名圖片`, crypto.randomUUID()),
      client,
    );
    const keyboard = client.sent.at(-1)?.replyMarkup?.inline_keyboard;
    expect(keyboard).toHaveLength(2);
    const choice = keyboard
      ?.flat()
      .find((b) => b.text.includes(s.cases[1].code));
    await immediate(callback(s.route, choice?.callback_data ?? ''), client);
    expect((await conversation(s.route))?.case_id).toBe(s.cases[1].id);
    expect(client.sent.at(-1)?.text).toContain('回報內容：虛構同名圖片');
  });
  it('replacing a draft never moves the previous pictures', async () => {
    const s = await setup(),
      client = new FakeTelegramClient();
    await immediate(message(s.route, `/回報 ${s.name} 第一筆`), client);
    await immediate(photo(s.route), client);
    const prior = await conversation(s.route);
    await immediate(message(s.route, `/回報 ${s.name} 第二筆`), client);
    const current = await conversation(s.route);
    expect(prior?.id).not.toBe(current?.id);
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM telegram_report_media WHERE conversation_id=?',
        )
          .bind(current?.id)
          .first()
      )?.n,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM telegram_report_media WHERE conversation_id=?',
        )
          .bind(prior?.id)
          .first()
      )?.n,
    ).toBe(1);
  });
  it('11 pictures forward in 10+1 chunks with a single caption and no standalone text', async () => {
    const f = await completedMediaFixture(11);
    f.client.mediaFailures = 1;
    const sentBefore = f.client.sent.length;
    await processOutbound(base, f.client, Date.now() + 100000);
    let job = await env.DB.prepare(
      'SELECT status,dispatch_state FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
    )
      .bind(f.conv?.report_id, f.routeId)
      .first<{ status: string; dispatch_state: string }>();
    expect(job?.status).toBe('pending');
    expect(JSON.parse(job?.dispatch_state ?? '{}').textId).toBeNull();
    const textsAfter = f.client.sent.length;
    expect(textsAfter).toBe(sentBefore);
    await processOutbound(base, f.client, Date.now() + 200000);
    expect(f.client.sent.length).toBe(textsAfter);
    expect(f.client.copiedMedia.map((m) => m.messageIds.length)).toEqual([
      10, 1,
    ]);
    job = await env.DB.prepare(
      'SELECT status,dispatch_state FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
    )
      .bind(f.conv?.report_id, f.routeId)
      .first();
    expect(job?.status).toBe('sent');
    expect(f.client.downloads).toHaveLength(0);
    expect(f.client.copiedMedia[0].caption).toContain('代號：');
    expect(f.client.copiedMedia[1].caption).toBe('');
  });
  it('uncertain media delivery is terminal and never repeats report or media', async () => {
    const f = await completedMediaFixture(1);
    f.client.uncertainMedia = true;
    await processOutbound(base, f.client, Date.now() + 100000);
    await processOutbound(base, f.client, Date.now() + 200000);
    expect(f.client.copiedMedia).toHaveLength(1);
    expect(
      (
        await env.DB.prepare(
          'SELECT last_error_code FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
        )
          .bind(f.conv?.report_id, f.routeId)
          .first()
      )?.last_error_code,
    ).toBe('DELIVERY_UNKNOWN');
    expect(
      (
        await env.DB.prepare('SELECT count(*) AS n FROM reports WHERE id=?')
          .bind(f.conv?.report_id)
          .first()
      )?.n,
    ).toBe(1);
  });
  it('retry after the first 10-picture checkpoint sends only the final picture', async () => {
    const f = await completedMediaFixture(11);
    const copy = f.client.copyReportMedia.bind(f.client);
    let calls = 0;
    f.client.copyReportMedia = async (input) => {
      if (++calls === 2) {
        f.client.mediaFailures = 1;
      }
      return await copy(input);
    };
    await processOutbound(base, f.client, Date.now() + 100000);
    expect(f.client.copiedMedia.map((m) => m.messageIds.length)).toEqual([10]);
    const sent = f.client.sent.length;
    await processOutbound(base, f.client, Date.now() + 200000);
    expect(f.client.copiedMedia.map((m) => m.messageIds.length)).toEqual([
      10, 1,
    ]);
    expect(f.client.sent.length).toBe(sent);
  });
  it('caption edit retry never copies the album twice or repeats report/payment', async () => {
    const f = await completedMediaFixture(2);
    f.client.captionFailures = 1;
    await processOutbound(base, f.client, Date.now() + 10000);
    expect(f.client.copiedMedia).toHaveLength(1);
    await processOutbound(base, f.client, Date.now() + 100000);
    expect(f.client.copiedMedia).toHaveLength(1);
    expect(f.client.editedCaptions).toHaveLength(1);
    expect(
      (
        await env.DB.prepare('SELECT count(*) AS n FROM reports WHERE id=?')
          .bind(f.conv?.report_id)
          .first()
      )?.n,
    ).toBe(1);
  });
  it('an oversized picture caption fails explicitly without falling back to a separate text message', async () => {
    const f = await completedMediaFixture(1);
    await env.DB.prepare(
      "UPDATE telegram_outbound_jobs SET payload=json_set(payload,'$.text',?) WHERE report_id=? AND route_id=?",
    )
      .bind('虛'.repeat(1025), f.conv?.report_id, f.routeId)
      .run();
    const sent = f.client.sent.length;
    await processOutbound(base, f.client, Date.now() + 10000);
    expect(f.client.sent).toHaveLength(sent);
    expect(f.client.copiedMedia).toHaveLength(0);
    expect(
      (
        await env.DB.prepare(
          'SELECT last_error_code FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
        )
          .bind(f.conv?.report_id, f.routeId)
          .first()
      )?.last_error_code,
    ).toBe('REPORT_CAPTION_TOO_LONG');
  });
  it('a picture received before replacement remains in the cancelled draft even when processing is delayed', async () => {
    const s = await setup(),
      client = new FakeTelegramClient();
    await immediate(message(s.route, `/回報 ${s.name} 舊回報`), client);
    const old = await conversation(s.route),
      picture = photo(s.route, undefined, crypto.randomUUID());
    await receiveTelegramUpdate(base, picture);
    await immediate(message(s.route, `/回報 ${s.name} 新回報`), client);
    await processTelegramUpdates(
      base,
      client,
      Date.now(),
      String(picture.update_id),
    );
    expect(
      (
        await env.DB.prepare(
          'SELECT conversation_id FROM telegram_report_media WHERE id=?',
        )
          .bind(String(picture.update_id))
          .first()
      )?.conversation_id,
    ).toBe(old?.id);
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM telegram_report_media WHERE conversation_id=?',
        )
          .bind((await conversation(s.route))?.id)
          .first()
      )?.n,
    ).toBe(0);
  });
  it('out-of-order caption adopts only its own album and preserves the original report content', async () => {
    const s = await setup(),
      client = new FakeTelegramClient(),
      group = crypto.randomUUID();
    await immediate(message(s.route, `/回報 ${s.name} 先前回報`), client);
    const first = photo(s.route, `/回報 ${s.name} 電話  沒接１５號`, group),
      second = photo(s.route, undefined, group);
    await immediate(second, client);
    await immediate(first, client);
    const conv = await conversation(s.route);
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM telegram_report_media WHERE conversation_id=?',
        )
          .bind(conv?.id)
          .first()
      )?.n,
    ).toBe(2);
    expect(client.sent.at(-1)?.text).toContain('電話  沒接１５號');
  });
});
