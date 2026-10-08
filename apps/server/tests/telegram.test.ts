import { env } from 'cloudflare:workers';
import { CaseMatchingService } from '@saasflare-dev/api/case-matching';
import type { Context } from '@saasflare-dev/api/context';
import { FakeTelegramClient } from '@saasflare-dev/api/telegram-client';
import {
  callbackFixture,
  photoFixture,
  reportFixture,
} from '@saasflare-dev/api/telegram-fixtures';
import {
  businessDate,
  processOutbound,
  renderBusinessReport,
} from '@saasflare-dev/api/telegram-outbound';
import { telegramPrincipal } from '@saasflare-dev/api/telegram-principal';
import {
  finalizeAlbums,
  processTelegramUpdates,
  receiveTelegramUpdate,
} from '@saasflare-dev/api/telegram-processing';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { adminCookie, rpc, userCookie } from './helpers';

let admin: string;
let ordinary: string;
let base: Context;
let adminId: string;
let userId: string;
let collectorId: string;
let intakeChat: number;
let collectorChat: number;
let destinationId: string;
const tick = () => Date.now() + 10000;
async function route(
  chatId: number,
  routeType: string,
  collector: string | null = null,
  topicId: number | null = null,
) {
  const r = await rpc(
    'telegram.saveRoute',
    {
      chatId: String(chatId),
      routeType,
      collectorId: collector,
      topicId,
      isActive: true,
    },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  return (r.body as { id: string }).id;
}
async function createCase(name: string, code: string, address = '虛構地址甲') {
  const r = await rpc(
    'cases.create',
    {
      customerName: name,
      code,
      address,
      amountDue: 50000,
      status: 'pending',
      source: 'manual',
      revisitStatus: 'pending',
      revisitReason: '',
    },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  return r.body as { id: string; caseNo: string };
}
async function assign(id: string) {
  const detail = await rpc('cases.detail', { id }, { cookie: admin });
  const r = await rpc(
    'cases.assign',
    {
      caseId: id,
      collectorId,
      expectedVersion: (detail.body as { version: number }).version,
      note: 'fictional',
    },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
}
async function updateRow(id: number) {
  return env.DB.prepare('SELECT * FROM telegram_updates WHERE id=?')
    .bind(String(id))
    .first<{
      id: string;
      status: string;
      intake_id: string;
      report_id: string;
      result_code: string;
      last_error_code: string;
    }>();
}
async function receive(raw: unknown) {
  return receiveTelegramUpdate(base, raw);
}
async function run(client = new FakeTelegramClient(), now = tick()) {
  await processTelegramUpdates(base, client, now);
  // Phase-six transport fixtures now explicitly simulate the phase-seven human button.
  const waiting = await env.DB.prepare(
    "SELECT r.callback_token FROM reports r JOIN assignments a ON a.id=r.assignment_id JOIN telegram_identities ti ON ti.collector_id=r.collector_id WHERE r.workflow_status='awaiting_status' AND a.unassigned_at IS NULL AND ti.is_active=1",
  ).all<{ callback_token: string }>();
  for (const row of waiting.results)
    await receive(
      callbackFixture(
        ++legacyCallbackId,
        collectorChat,
        900001,
        row.callback_token,
        'settled',
      ),
    );
  if (waiting.results.length) await processTelegramUpdates(base, client, now);
  return client;
}
let legacyCallbackId = 9000000;
async function assignedCase() {
  const name = `虛構外收-${crypto.randomUUID()}`;
  const code = `T-${crypto.randomUUID().slice(0, 8)}`;
  const c = await createCase(name, code);
  await assign(c.id);
  return { ...c, name, code };
}
beforeAll(async () => {
  admin = await adminCookie();
  ordinary = await userCookie();
  adminId =
    (
      await env.DB.prepare('SELECT id FROM user WHERE email=?')
        .bind('boss@test.dev')
        .first<{ id: string }>()
    )?.id ?? '';
  userId =
    (
      await env.DB.prepare('SELECT id FROM user WHERE email=?')
        .bind('customer@test.dev')
        .first<{ id: string }>()
    )?.id ?? '';
  base = {
    env,
    DB: drizzle(env.DB),
    headers: new Headers(),
    session: null,
    user: null,
    isAdmin: false,
  };
  const c = await rpc(
    'collectors.create',
    {
      displayName: 'Fictional Telegram collector',
      code: crypto.randomUUID(),
      userId,
      isActive: true,
    },
    { cookie: admin },
  );
  expect(c.status).toBe(200);
  collectorId = (c.body as { id: string }).id;
  intakeChat = -100900001;
  collectorChat = -100900002;
  await route(intakeChat, 'intake_source');
  await route(collectorChat, 'collector', collectorId);
  destinationId = await route(-100900003, 'report_destination', null, 77);
  const i = await rpc(
    'telegram.saveIdentity',
    {
      telegramUserId: '900001',
      collectorId,
      userId,
      displayName: 'Fictional identity',
      isActive: true,
    },
    { cookie: admin },
  );
  expect(i.status).toBe(200);
});
describe('Telegram manual report confirmation', () => {
  let sequence = 9100000;
  async function pending() {
    const c = await assignedCase();
    const id = ++sequence;
    const client = new FakeTelegramClient();
    await receive(reportFixture(id, collectorChat, 900001, c.code));
    await processTelegramUpdates(base, client, tick());
    const update = await updateRow(id);
    const row = await env.DB.prepare('SELECT * FROM reports WHERE id=?')
      .bind(update?.report_id)
      .first<{
        id: string;
        callback_token: string;
        workflow_status: string;
        assignment_id: string;
      }>();
    expect(row?.workflow_status).toBe('awaiting_status');
    return { c, row: row as NonNullable<typeof row>, client };
  }
  it('pending report leaves case status unchanged, creates no classification review or business job and sends four opaque buttons', async () => {
    const { c, row, client } = await pending();
    expect(
      (
        await env.DB.prepare('SELECT status FROM cases WHERE id=?')
          .bind(c.id)
          .first()
      )?.status,
    ).toBe('pending');
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM review_items WHERE entity_id=?',
        )
          .bind(row.id)
          .first()
      )?.n,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM telegram_outbound_jobs WHERE report_id=? AND message_type='report_destination'",
        )
          .bind(row.id)
          .first()
      )?.n,
    ).toBe(0);
    await processOutbound(base, client, tick());
    const buttons =
      client.sent
        .find((x) => x.replyMarkup)
        ?.replyMarkup?.inline_keyboard.flat() ?? [];
    expect(buttons.map((x) => x.text)).toEqual([
      '✅ 結清',
      '💰 分期',
      '❌ 無解',
      '🔁 安排二訪',
    ]);
    expect(
      buttons.every(
        (x) =>
          x.callback_data.length <= 64 && !x.callback_data.includes(c.code),
      ),
    ).toBe(true);
  });
  it.each([
    'settled',
    'installment',
    'unresolved',
    'follow_up',
  ] as const)('manual %s completes and forwards once, even with a different repeated selection', async (status) => {
    const { c, row, client } = await pending();
    await receive(
      callbackFixture(
        ++sequence,
        collectorChat,
        900001,
        row.callback_token,
        status,
      ),
    );
    await processTelegramUpdates(base, client, tick());
    await receive(
      callbackFixture(
        ++sequence,
        collectorChat,
        900001,
        row.callback_token,
        status === 'settled' ? 'unresolved' : 'settled',
      ),
    );
    await processTelegramUpdates(base, client, tick());
    expect(
      await env.DB.prepare(
        'SELECT status,workflow_status,selected_status,completed_by_user_id FROM reports WHERE id=?',
      )
        .bind(row.id)
        .first(),
    ).toMatchObject({
      status,
      workflow_status: 'completed',
      selected_status: status,
      completed_by_user_id: userId,
    });
    expect(
      (
        await env.DB.prepare('SELECT status FROM cases WHERE id=?')
          .bind(c.id)
          .first()
      )?.status,
    ).toBe(status);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM audit_logs WHERE entity_id=? AND action='report.completed'",
        )
          .bind(c.id)
          .first()
      )?.n,
    ).toBe(1);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM telegram_outbound_jobs WHERE report_id=? AND message_type='report_destination'",
        )
          .bind(row.id)
          .first()
      )?.n,
    ).toBe(1);
    expect(client.answered.at(-1)?.text).toContain('已完成');
  });
  it('completion rollback leaves the report pending and repairs one business job on retry', async () => {
    const { c, row, client } = await pending();
    const id = ++sequence;
    await receive(
      callbackFixture(id, collectorChat, 900001, row.callback_token, 'settled'),
    );
    await env.DB.exec(
      "CREATE TRIGGER fail_manual_completion BEFORE UPDATE OF workflow_status ON reports WHEN NEW.workflow_status='completed' BEGIN SELECT RAISE(ABORT,'synthetic completion rollback'); END",
    );
    try {
      await processTelegramUpdates(base, client, tick());
    } finally {
      await env.DB.exec('DROP TRIGGER fail_manual_completion');
    }
    expect(
      (
        await env.DB.prepare('SELECT status FROM cases WHERE id=?')
          .bind(c.id)
          .first()
      )?.status,
    ).toBe('pending');
    expect(
      (
        await env.DB.prepare('SELECT workflow_status FROM reports WHERE id=?')
          .bind(row.id)
          .first()
      )?.workflow_status,
    ).toBe('awaiting_status');
    await processTelegramUpdates(base, client, Date.now() + 400000);
    expect(
      (
        await env.DB.prepare('SELECT status FROM cases WHERE id=?')
          .bind(c.id)
          .first()
      )?.status,
    ).toBe('settled');
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM telegram_outbound_jobs WHERE report_id=? AND message_type='report_destination'",
        )
          .bind(row.id)
          .first()
      )?.n,
    ).toBe(1);
  });
  it.each([
    'deadline',
    'weekly',
    'monthly',
  ] as const)('persists %s installment setup and creates schedules only after an idempotent confirmation', async (type) => {
    await env.DB.prepare(
      "UPDATE installment_workflows SET status='cancelled' WHERE telegram_user_id='900001' AND status='active'",
    ).run();
    const { c, row, client } = await pending();
    await receive(
      callbackFixture(
        ++sequence,
        collectorChat,
        900001,
        row.callback_token,
        'installment',
      ),
    );
    await processTelegramUpdates(base, client, tick());
    async function workflow() {
      return await env.DB.prepare(
        'SELECT * FROM installment_workflows WHERE report_id=?',
      )
        .bind(row.id)
        .first<{
          id: string;
          token: string;
          version: number;
          status: string;
          step: string;
        }>();
    }
    async function button(action: string, wrongSender = false) {
      const state = await workflow();
      const update = callbackFixture(
        ++sequence,
        collectorChat,
        wrongSender ? 900002 : 900001,
        row.callback_token,
        'installment',
      );
      if (update.callback_query)
        update.callback_query.data = `ip:${state?.token}:${state?.version}:${action}`;
      await receive(update);
      await processTelegramUpdates(base, client, tick());
      return update;
    }
    async function text(content: string) {
      const update = reportFixture(++sequence, collectorChat, 900001, c.code);
      if (update.message) update.message.text = content;
      await receive(update);
      await processTelegramUpdates(base, client, tick());
    }
    expect((await workflow())?.step).toBe('type');
    await button(type, true);
    expect((await workflow())?.step).toBe('type');
    await button(type);
    if (type === 'deadline') {
      await text('2026/02/30');
      expect((await workflow())?.step).toBe('deadline');
      await text('2090/10/20');
    } else if (type === 'weekly') await button('week3');
    else await button('day10');
    if (type !== 'deadline') {
      await text('-1');
      expect((await workflow())?.step).toBe('per');
      await text('5000');
    }
    await text(type === 'deadline' ? '15000' : '23000');
    expect((await workflow())?.step).toBe('confirm');
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM installment_plans WHERE report_id=?',
        )
          .bind(row.id)
          .first()
      )?.n,
    ).toBe(0);
    const confirmation = await button('confirm');
    await receive(confirmation);
    await processTelegramUpdates(base, client, tick());
    const completed = await workflow();
    expect(completed?.status).toBe('completed');
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM installment_plans WHERE report_id=?',
        )
          .bind(row.id)
          .first()
      )?.n,
    ).toBe(1);
    const schedules = await env.DB.prepare(
      'SELECT expected_amount FROM installment_schedules WHERE case_id=? ORDER BY sequence',
    )
      .bind(c.id)
      .all();
    expect(schedules.results.map((s) => s.expected_amount)).toEqual(
      type === 'deadline' ? [15000] : [5000, 5000, 5000, 5000, 3000],
    );
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM payments WHERE case_id=?',
        )
          .bind(c.id)
          .first()
      )?.n,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM audit_logs WHERE entity_id=? AND action='installment.plan_created'",
        )
          .bind(c.id)
          .first()
      )?.n,
    ).toBe(1);
  });
  it('rejects another sender, malformed token, wrong source topic and an ended assignment', async () => {
    const { row, client } = await pending();
    const bad = [
      callbackFixture(
        ++sequence,
        collectorChat,
        900002,
        row.callback_token,
        'settled',
      ),
      callbackFixture(
        ++sequence,
        collectorChat,
        900001,
        '0'.repeat(32),
        'settled',
      ),
      callbackFixture(
        ++sequence,
        collectorChat,
        900001,
        row.callback_token,
        'settled',
        42,
      ),
    ];
    for (const callback of bad) {
      await receive(callback);
      await processTelegramUpdates(base, client, tick());
    }
    await env.DB.prepare('UPDATE assignments SET unassigned_at=? WHERE id=?')
      .bind(Date.now(), row.assignment_id)
      .run();
    await receive(
      callbackFixture(
        ++sequence,
        collectorChat,
        900001,
        row.callback_token,
        'settled',
      ),
    );
    await processTelegramUpdates(base, client, tick());
    expect(
      (
        await env.DB.prepare('SELECT workflow_status FROM reports WHERE id=?')
          .bind(row.id)
          .first()
      )?.workflow_status,
    ).toBe('awaiting_status');
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM telegram_outbound_jobs WHERE report_id=? AND message_type='report_destination'",
        )
          .bind(row.id)
          .first()
      )?.n,
    ).toBe(0);
  });
});
describe('Telegram local integration', () => {
  it('rejects invalid secret and oversized malformed requests without persistence', async () => {
    const r = await app.fetch(
      new Request('http://localhost/api/telegram/webhook', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' },
        body: JSON.stringify(photoFixture(600001, intakeChat)),
      }),
    );
    expect(r.status).toBe(401);
    expect(await updateRow(600001)).toBeNull();
    const invalid = await app.fetch(
      new Request('http://localhost/api/telegram/webhook', {
        method: 'POST',
        headers: {
          'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-placeholder',
        },
        body: 'x'.repeat(70000),
      }),
    );
    expect(invalid.status).toBe(400);
  });
  it('webhook persists quickly; duplicate update creates one intake and one private media without repeat download', async () => {
    const u = photoFixture(600002, intakeChat);
    for (let i = 0; i < 2; i++) {
      const r = await app.fetch(
        new Request('http://localhost/api/telegram/webhook', {
          method: 'POST',
          headers: {
            'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-placeholder',
          },
          body: JSON.stringify(u),
        }),
      );
      expect(r.status).toBe(200);
    }
    expect((await updateRow(600002))?.intake_id).toBeNull();
    const fake = await run();
    await receive(u);
    await run(fake);
    const row = await updateRow(600002);
    expect(row?.status).toBe('done');
    expect(fake.downloads).toHaveLength(1);
    const media = await env.DB.prepare(
      'SELECT id,storage_key FROM intake_media WHERE intake_id=?',
    )
      .bind(row?.intake_id)
      .all<{ id: string; storage_key: string }>();
    expect(media.results).toHaveLength(1);
    expect(media.results[0].storage_key).toMatch(/^intakes\//);
    const response = await app.fetch(
      new Request(
        `http://localhost/api/intake/${row?.intake_id}/media/${media.results[0].id}/image`,
      ),
    );
    expect(response.status).toBe(401);
  });
  it('accepts document images and rejects disallowed source topics', async () => {
    await receive(photoFixture(600003, intakeChat, { document: true }));
    await run();
    expect((await updateRow(600003))?.status).toBe('done');
    await receive(photoFixture(600004, intakeChat, { topicId: 999 }));
    await run();
    expect(await updateRow(600004)).toMatchObject({
      status: 'failed',
      last_error_code: 'SOURCE_DENIED',
    });
  });
  it('collects three album images including delayed arrivals, preserving message order and quiet period', async () => {
    const fake = new FakeTelegramClient();
    const album = 'fictional-album';
    const first = photoFixture(600005, intakeChat, { album, messageId: 20 });
    await receive(first);
    await run(fake, Date.now());
    const second = photoFixture(600006, intakeChat, { album, messageId: 10 });
    await receive(second);
    await receive(second);
    await run(fake, Date.now());
    const pending = await env.DB.prepare(
      'SELECT finalized_at FROM telegram_albums WHERE id=?',
    )
      .bind(`${intakeChat}:0:${album}`)
      .first<{ finalized_at: number | null }>();
    expect(pending?.finalized_at).toBeNull();
    await receive(photoFixture(600007, intakeChat, { album, messageId: 30 }));
    await run(fake, Date.now());
    await finalizeAlbums(base, tick());
    const rows = await env.DB.prepare(
      'SELECT intake_id FROM telegram_updates WHERE id IN (?,?,?)',
    )
      .bind('600005', '600006', '600007')
      .all<{ intake_id: string }>();
    expect(new Set(rows.results.map((r) => r.intake_id)).size).toBe(1);
    const images = await env.DB.prepare(
      'SELECT sort_order FROM intake_media WHERE intake_id=? ORDER BY sort_order',
    )
      .bind(rows.results[0].intake_id)
      .all<{ sort_order: number }>();
    expect(images.results.map((r) => r.sort_order)).toEqual([10, 20, 30]);
    expect(fake.downloads).toHaveLength(3);
    expect(
      (
        await env.DB.prepare(
          'SELECT finalized_at FROM telegram_albums WHERE id=?',
        )
          .bind(`${intakeChat}:0:${album}`)
          .first<{ finalized_at: number }>()
      )?.finalized_at,
    ).toBeTruthy();
  });
  it('download failure retries safely and reaches success without a second media row', async () => {
    await receive(photoFixture(600008, intakeChat));
    const fake = new FakeTelegramClient();
    fake.downloadFailures = 1;
    await run(fake);
    expect((await updateRow(600008))?.status).toBe('pending');
    await run(fake, tick() + 10000);
    expect((await updateRow(600008))?.status).toBe('done');
    expect(fake.downloads).toHaveLength(2);
  });
  it('same name plus different codes is no match and produces separate cases for different events', async () => {
    const name = `虛構同名-${crypto.randomUUID()}`;
    await createCase(name, `A-${crypto.randomUUID()}`);
    const context = await telegramPrincipal(base, adminId);
    const p = {
      code: `B-${crypto.randomUUID()}`,
      customer_name: name,
      address: '虛構地址甲',
      amount_due: 50000,
    };
    expect((await new CaseMatchingService().match(context, p)).kind).toBe(
      'no_match',
    );
    const receipt = await rpc(
      'intake.receive',
      {
        source: 'telegram',
        externalId: `distinct-${crypto.randomUUID()}`,
        proposedData: p,
      },
      { cookie: admin },
    );
    const id = (receipt.body as { id: string }).id;
    const d = await rpc('intake.detail', { id }, { cookie: admin });
    const resolved = await rpc(
      'intake.resolve',
      {
        id,
        expectedVersion: (d.body as { version: number }).version,
        action: 'create',
      },
      { cookie: admin },
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ status: 'created' });
  });
  it('same name and code strongly match, missing code or conflicting address require review', async () => {
    const name = `虛構規則-${crypto.randomUUID()}`;
    const code = crypto.randomUUID();
    const c = await createCase(name, code);
    const context = await telegramPrincipal(base, adminId);
    const service = new CaseMatchingService();
    const p = {
      code,
      customer_name: name,
      address: '虛構 地址甲',
      amount_due: 10,
    };
    expect((await service.match(context, p)).kind).toBe('unique_match');
    expect((await service.match(context, { ...p, code: null })).kind).toBe(
      'ambiguous',
    );
    expect(
      (await service.match(context, { ...p, address: '明顯不同的虛構地址' }))
        .kind,
    ).toBe('ambiguous');
    expect(
      (await service.match(context, { ...p, code: 'OTHER' }, c.caseNo)).kind,
    ).toBe('unique_match');
    const receipt = await rpc(
      'intake.receive',
      {
        source: 'manual',
        proposedData: { ...p, address: '明顯不同的虛構地址' },
      },
      { cookie: admin },
    );
    const id = (receipt.body as { id: string }).id;
    expect(
      (
        await rpc(
          'intake.process',
          { id, expectedVersion: 0 },
          { cookie: admin },
        )
      ).body,
    ).toMatchObject({ status: 'needs_review' });
  });
  it('collector reports assigned case, confirms manually and queues an idempotent outbound job', async () => {
    const c = await assignedCase();
    const update = reportFixture(600009, collectorChat, 900001, c.code);
    await receive(update);
    await run();
    await receive(update);
    await run();
    const row = await updateRow(600009);
    expect(row).toMatchObject({
      status: 'done',
      result_code: 'REPORT_PENDING',
    });
    const reports = await env.DB.prepare(
      'SELECT id,status,source FROM reports WHERE origin_key=?',
    )
      .bind('telegram-update:600009')
      .all<{ id: string; status: string; source: string }>();
    expect(reports.results).toHaveLength(1);
    expect(reports.results[0]).toMatchObject({
      status: 'settled',
      source: 'telegram',
    });
    const jobs = await env.DB.prepare(
      'SELECT payload FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
    )
      .bind(row?.report_id, destinationId)
      .all<{ payload: string }>();
    expect(jobs.results).toHaveLength(1);
    const payload = JSON.parse(jobs.results[0].payload);
    expect(Object.keys(payload).sort()).toEqual(['chatId', 'text', 'topicId']);
    expect(payload.topicId).toBe(77);
    expect(
      payload.text.split('\n').map((s: string) => s.split('：')[0]),
    ).toEqual(['代號', '客戶姓名', '回報內容', '日期']);
    expect(payload.text).not.toContain(c.caseNo);
    expect(payload.text).not.toContain(c.id);
    expect(
      (
        await env.DB.prepare('SELECT status FROM cases WHERE id=?')
          .bind(c.id)
          .first<{ status: string }>()
      )?.status,
    ).toBe('settled');
  });
  it('cannot report another collector case and denies unbound Telegram user', async () => {
    const c = await createCase(
      `他人-${crypto.randomUUID()}`,
      crypto.randomUUID(),
    );
    await receive(reportFixture(600010, collectorChat, 900001, c.caseNo));
    await receive(reportFixture(600011, collectorChat, 999999, c.caseNo));
    await run();
    expect((await updateRow(600010))?.result_code).toBe('CASE_DENIED');
    expect((await updateRow(600011))?.result_code).toBe('IDENTITY_DENIED');
    expect((await updateRow(600010))?.report_id).toBeNull();
  });
  it('two same-name assigned cases return ambiguity, with no sensitive fields or report', async () => {
    const name = `虛構雙名-${crypto.randomUUID()}`;
    const a = await createCase(name, crypto.randomUUID());
    const b = await createCase(name, crypto.randomUUID());
    await assign(a.id);
    await assign(b.id);
    await receive(reportFixture(600012, collectorChat, 900001, name));
    await run();
    expect((await updateRow(600012))?.result_code).toBe('AMBIGUOUS');
    const job = await env.DB.prepare(
      'SELECT payload FROM telegram_outbound_jobs WHERE dedupe_key=?',
    )
      .bind('command-reply:600012')
      .first<{ payload: string }>();
    const text = JSON.parse(job?.payload ?? '{}').text;
    expect(text).toContain(a.caseNo);
    expect(text).toContain(b.caseNo);
    expect(text).not.toContain('虛構地址甲');
    expect(text).not.toContain('50000');
  });
  it('same-name lookup resolves uniquely inside collector assignment scope', async () => {
    const c = await assignedCase();
    await createCase(c.name, crypto.randomUUID());
    await receive(reportFixture(600013, collectorChat, 900001, c.name));
    await run();
    expect((await updateRow(600013))?.result_code).toBe('REPORT_PENDING');
  });
  it('outbound failure preserves report, retries once successfully and never resends sent jobs', async () => {
    const c = await assignedCase();
    await receive(reportFixture(600014, collectorChat, 900001, c.code));
    await run();
    const row = await updateRow(600014);
    const fake = new FakeTelegramClient();
    fake.sendFailures = 1;
    // Isolate the business message from other pending replies.
    await env.DB.prepare(
      "UPDATE telegram_outbound_jobs SET next_attempt_at=? WHERE status='pending' AND NOT (report_id=? AND route_id=?)",
    )
      .bind(tick() + 100000, row?.report_id, destinationId)
      .run();
    await processOutbound(base, fake, tick());
    const failed = await env.DB.prepare(
      'SELECT status,attempts FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
    )
      .bind(row?.report_id, destinationId)
      .first<{ status: string; attempts: number }>();
    expect(failed).toMatchObject({ status: 'pending', attempts: 1 });
    expect(
      await env.DB.prepare('SELECT id FROM reports WHERE id=?')
        .bind(row?.report_id)
        .first(),
    ).toBeTruthy();
    await processOutbound(base, fake, tick() + 10000);
    await processOutbound(base, fake, tick() + 15000);
    expect(fake.sent).toHaveLength(1);
  });
  it('uncertain API delivery is failed without blind retry or duplicate successful message', async () => {
    const c = await assignedCase();
    await receive(reportFixture(600015, collectorChat, 900001, c.code));
    await run();
    const row = await updateRow(600015);
    await env.DB.prepare(
      "UPDATE telegram_outbound_jobs SET next_attempt_at=? WHERE status='pending' AND NOT (report_id=? AND route_id=?)",
    )
      .bind(tick() + 100000, row?.report_id, destinationId)
      .run();
    const fake = new FakeTelegramClient();
    fake.uncertainSend = true;
    await processOutbound(base, fake, tick());
    await processOutbound(base, fake, tick() + 10000);
    expect(fake.sent).toHaveLength(1);
    expect(
      await env.DB.prepare(
        'SELECT status,last_error_code FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
      )
        .bind(row?.report_id, destinationId)
        .first(),
    ).toMatchObject({ status: 'failed', last_error_code: 'DELIVERY_UNKNOWN' });
  });
  it('unexpected sender exceptions are sanitized and never retried', async () => {
    const c = await assignedCase();
    await receive(reportFixture(600090, collectorChat, 900001, c.code));
    await run();
    const row = await updateRow(600090);
    await env.DB.prepare(
      "UPDATE telegram_outbound_jobs SET next_attempt_at=? WHERE status='pending' AND NOT (report_id=? AND route_id=?)",
    )
      .bind(tick() + 100000, row?.report_id, destinationId)
      .run();
    let calls = 0;
    class UnexpectedSender extends FakeTelegramClient {
      async sendMessage(): Promise<string> {
        calls++;
        throw new Error(
          'fetch https://api.telegram.org/botTEST_SECRET/sendMessage',
        );
      }
    }
    const logs = vi.spyOn(console, 'warn');
    try {
      await processOutbound(base, new UnexpectedSender(), tick());
      await processOutbound(base, new UnexpectedSender(), tick() + 10000);
      expect(calls).toBe(1);
      expect(logs.mock.calls).toContainEqual([
        'telegram.diagnostic',
        expect.objectContaining({
          stage: 'unexpected_outbound_exception',
          kind: 'network',
        }),
      ]);
      expect(JSON.stringify(logs.mock.calls)).not.toContain('TEST_SECRET');
      expect(JSON.stringify(logs.mock.calls)).not.toContain('api.telegram.org');
      expect(
        await env.DB.prepare(
          'SELECT status,last_error_code FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
        )
          .bind(row?.report_id, destinationId)
          .first(),
      ).toMatchObject({
        status: 'failed',
        last_error_code: 'DELIVERY_UNKNOWN',
      });
    } finally {
      logs.mockRestore();
    }
  });
  it('formats the business timezone and exactly four allowed fields', () => {
    expect(businessDate(Date.UTC(2026, 9, 7, 18), 'Asia/Taipei')).toBe(
      '2026/10/08',
    );
    expect(
      renderBusinessReport(
        {
          code: 'A001',
          customerName: '虛構客戶',
          content: '虛構已到訪',
          createdAt: Date.UTC(2026, 9, 7, 18),
        },
        'Asia/Taipei',
      ),
    ).toBe(
      '代號：A001\n客戶姓名：虛構客戶\n回報內容：虛構已到訪\n日期：2026/10/08',
    );
  });
  it('route and identity APIs reject ordinary users', async () => {
    expect(
      (await rpc('telegram.routes', undefined, { cookie: ordinary })).status,
    ).toBe(403);
    expect(
      (
        await rpc(
          'telegram.saveRoute',
          { chatId: '-123', routeType: 'intake_source' },
          { cookie: ordinary },
        )
      ).status,
    ).toBe(403);
    expect(
      (await rpc('telegram.identities', undefined, { cookie: ordinary }))
        .status,
    ).toBe(403);
    expect(
      (await rpc('telegram.process', undefined, { cookie: ordinary })).status,
    ).toBe(403);
  });
  it('concurrent webhook delivery and processors have one receipt, download and media row', async () => {
    const update = photoFixture(600016, intakeChat);
    await Promise.all([receive(update), receive(update)]);
    const fake = new FakeTelegramClient();
    await Promise.all([run(fake), run(fake)]);
    expect((await updateRow(600016))?.status).toBe('done');
    expect(
      fake.downloads.filter((id) => id === 'fictional-image-600016'),
    ).toHaveLength(1);
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM intake_media WHERE id=?',
        )
          .bind('telegram-600016')
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it('staged private download survives a database rollback and is not downloaded again', async () => {
    await receive(photoFixture(600017, intakeChat));
    await env.DB.exec(
      "CREATE TRIGGER fictional_media_fail BEFORE INSERT ON intake_media WHEN NEW.id='telegram-600017' BEGIN SELECT RAISE(ABORT,'FICTIONAL_DB_FAILURE'); END;",
    );
    const fake = new FakeTelegramClient();
    try {
      await run(fake);
      expect((await updateRow(600017))?.status).toBe('pending');
      expect(
        await env.DB.prepare('SELECT id FROM intake_media WHERE id=?')
          .bind('telegram-600017')
          .first(),
      ).toBeNull();
    } finally {
      await env.DB.exec('DROP TRIGGER fictional_media_fail;');
    }
    await run(fake, tick() + 10000);
    expect((await updateRow(600017))?.status).toBe('done');
    expect(
      fake.downloads.filter((id) => id === 'fictional-image-600017'),
    ).toHaveLength(1);
  });
  it('report commit survives outbound queue failure and retry repairs jobs after assignment changes', async () => {
    const c = await assignedCase();
    await receive(reportFixture(600018, collectorChat, 900001, c.code));
    await env.DB.exec(
      "CREATE TRIGGER fictional_outbound_fail BEFORE INSERT ON telegram_outbound_jobs WHEN NEW.report_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'FICTIONAL_OUTBOUND_FAILURE'); END;",
    );
    try {
      await run();
      expect((await updateRow(600018))?.status).toBe('pending');
      expect((await updateRow(600018))?.report_id).toBeTruthy();
    } finally {
      await env.DB.exec('DROP TRIGGER fictional_outbound_fail;');
    }
    await env.DB.prepare(
      'UPDATE assignments SET unassigned_at=? WHERE case_id=? AND unassigned_at IS NULL',
    )
      .bind(Date.now(), c.id)
      .run();
    await run(new FakeTelegramClient(), tick() + 10000);
    const row = await updateRow(600018);
    expect(row?.result_code).toBe('REPORT_PENDING');
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM reports WHERE origin_key=?',
        )
          .bind('telegram-update:600018')
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
        )
          .bind(row?.report_id, destinationId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it('processing and outbound failures stop at five attempts with safe audit codes', async () => {
    await receive(photoFixture(600019, intakeChat));
    const fake = new FakeTelegramClient();
    fake.downloadFailures = 100;
    const start = tick();
    for (let n = 0; n < 5; n++) await run(fake, start + n * 400000);
    expect(await updateRow(600019)).toMatchObject({
      status: 'failed',
      last_error_code: 'DOWNLOAD_TIMEOUT',
    });
    const c = await assignedCase();
    await receive(reportFixture(600020, collectorChat, 900001, c.code));
    await run();
    const row = await updateRow(600020);
    await env.DB.prepare(
      "UPDATE telegram_outbound_jobs SET next_attempt_at=? WHERE status='pending' AND NOT (report_id=? AND route_id=?)",
    )
      .bind(9000000000000, row?.report_id, destinationId)
      .run();
    const sender = new FakeTelegramClient();
    sender.sendFailures = 100;
    for (let n = 0; n < 5; n++)
      await processOutbound(base, sender, start + n * 400000);
    expect(
      await env.DB.prepare(
        'SELECT status,attempts,last_error_code FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
      )
        .bind(row?.report_id, destinationId)
        .first(),
    ).toMatchObject({
      status: 'failed',
      attempts: 5,
      last_error_code: 'RATE_LIMIT',
    });
    expect(
      await env.DB.prepare('SELECT id FROM reports WHERE id=?')
        .bind(row?.report_id)
        .first(),
    ).toBeTruthy();
  });
  it('expired sending lease requires reconciliation and concurrent sends claim once', async () => {
    const c = await assignedCase();
    await receive(reportFixture(600021, collectorChat, 900001, c.code));
    await run();
    const row = await updateRow(600021);
    await env.DB.prepare(
      "UPDATE telegram_outbound_jobs SET next_attempt_at=? WHERE status='pending' AND NOT (report_id=? AND route_id=?)",
    )
      .bind(9000000000000, row?.report_id, destinationId)
      .run();
    const fake = new FakeTelegramClient();
    await Promise.all([
      processOutbound(base, fake, tick()),
      processOutbound(base, fake, tick()),
    ]);
    expect(fake.sent).toHaveLength(1);
    await env.DB.prepare(
      "UPDATE telegram_outbound_jobs SET status='sending',lease_until=?,lease_token=? WHERE report_id=? AND route_id=?",
    )
      .bind(Date.now() - 1, 'fictional-expired', row?.report_id, destinationId)
      .run();
    await processOutbound(base, fake, tick());
    expect(fake.sent).toHaveLength(1);
    expect(
      await env.DB.prepare(
        'SELECT status,last_error_code FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
      )
        .bind(row?.report_id, destinationId)
        .first(),
    ).toMatchObject({ status: 'failed', last_error_code: 'DELIVERY_UNKNOWN' });
  });
  it('inactive identity and forged sender chat cannot create reports', async () => {
    const c = await assignedCase();
    await env.DB.prepare(
      'UPDATE telegram_identities SET is_active=0 WHERE telegram_user_id=?',
    )
      .bind('900001')
      .run();
    try {
      await receive(reportFixture(600022, collectorChat, 900001, c.code));
      await run();
      expect((await updateRow(600022))?.result_code).toBe('IDENTITY_DENIED');
    } finally {
      await env.DB.prepare(
        'UPDATE telegram_identities SET is_active=1 WHERE telegram_user_id=?',
      )
        .bind('900001')
        .run();
    }
    const update = reportFixture(600023, collectorChat, 900001, c.code);
    if (update.message) update.message.sender_chat = { id: collectorChat };
    await receive(update);
    await run();
    expect((await updateRow(600023))?.result_code).toBe('IDENTITY_DENIED');
  });
  it('records audit events without credentials or private bytes', async () => {
    const audits = await env.DB.prepare(
      "SELECT action,metadata FROM audit_logs WHERE entity_type='telegram'",
    ).all<{ action: string; metadata: string }>();
    for (const action of [
      'telegram.update_received',
      'telegram.duplicate_ignored',
      'telegram.intake_created',
      'telegram.media_received',
      'telegram.album_finalized',
      'telegram.report_created',
      'telegram.report_lookup_ambiguous',
      'telegram.identity_denied',
      'report.outbound_queued',
      'report.outbound_sent',
      'report.outbound_failed',
    ])
      expect(audits.results.some((a) => a.action === action)).toBe(true);
    expect(JSON.stringify(audits.results)).not.toContain(
      'test-webhook-placeholder',
    );
    expect(JSON.stringify(audits.results)).not.toContain('base64');
  });
  it('business destinations scoped to another collector receive no job', async () => {
    const other = await rpc(
      'collectors.create',
      {
        displayName: 'Fictional separate collector',
        code: crypto.randomUUID(),
        userId: null,
        isActive: true,
      },
      { cookie: admin },
    );
    expect(other.status).toBe(200);
    const otherRoute = await route(
      -100900004,
      'report_destination',
      (other.body as { id: string }).id,
      88,
    );
    const c = await assignedCase();
    await receive(reportFixture(600024, collectorChat, 900001, c.code));
    await run();
    const row = await updateRow(600024);
    expect(row?.result_code).toBe('REPORT_PENDING');
    expect(
      await env.DB.prepare(
        'SELECT id FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
      )
        .bind(row?.report_id, otherRoute)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        'SELECT id FROM telegram_outbound_jobs WHERE report_id=? AND route_id=?',
      )
        .bind(row?.report_id, destinationId)
        .first(),
    ).toBeTruthy();
  });
  it('an unfinished album cannot be resolved into a formal case', async () => {
    await receive(
      photoFixture(600025, intakeChat, { album: 'fictional-collecting' }),
    );
    await run(new FakeTelegramClient(), Date.now());
    const row = await updateRow(600025);
    const detail = await rpc(
      'intake.detail',
      { id: row?.intake_id },
      { cookie: admin },
    );
    const d = detail.body as { version: number };
    const result = await rpc(
      'intake.resolve',
      {
        id: row?.intake_id,
        expectedVersion: d.version,
        action: 'create',
        confirmedData: {
          code: crypto.randomUUID(),
          customer_name: crypto.randomUUID(),
          address: '虛構尚未收齊',
          amount_due: 100,
        },
      },
      { cookie: admin },
    );
    expect(result.status).toBe(409);
    expect(
      await env.DB.prepare(
        'SELECT matched_case_id FROM intake_items WHERE id=?',
      )
        .bind(row?.intake_id)
        .first(),
    ).toMatchObject({ matched_case_id: null });
    await finalizeAlbums(base, tick());
  });
});
