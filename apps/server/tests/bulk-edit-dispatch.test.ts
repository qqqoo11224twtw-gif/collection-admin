import { env } from 'cloudflare:workers';
import { queueAssignmentDispatch } from '@saasflare-dev/api/assignment-outbound';
import type { Context } from '@saasflare-dev/api/context';
import {
  FakeTelegramClient,
  TelegramFailure,
} from '@saasflare-dev/api/telegram-client';
import { processOutbound } from '@saasflare-dev/api/telegram-outbound';
import { runTelegramProcessing } from '@saasflare-dev/api/telegram-processing';
import { DEMO_IMAGES } from '@saasflare-dev/db/demo-images';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, expect, it } from 'vitest';
import { adminCookie, assignFinanceFixture, rpc, userCookie } from './helpers';

let admin: string, ordinary: string, collector: string;
const base: Context = {
  env,
  DB: drizzle(env.DB),
  headers: new Headers(),
  session: null,
  user: null,
  isAdmin: false,
};
async function create() {
  const r = await rpc(
    'cases.create',
    {
      code: crypto.randomUUID(),
      customerName: '完全虛構批量客戶',
      address: '虛構地址',
      amountDue: 1000,
      status: 'pending',
      source: 'manual',
      revisitStatus: 'pending',
      revisitReason: '',
      region: '桃園市',
    },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  return (r.body as { id: string }).id;
}
async function newCollector() {
  const r = await rpc(
    'collectors.create',
    {
      displayName: '虛構補登外收',
      code: crypto.randomUUID(),
      userId: null,
      isActive: true,
    },
    { cookie: admin },
  );
  return (r.body as { id: string }).id;
}
async function route(c = collector) {
  const r = await rpc(
    'telegram.saveRoute',
    {
      name: '虛構派件',
      chatId: String(-1000000 - Math.floor(Math.random() * 999999)),
      topicId: 2,
      collectorId: c,
      routeType: 'collector_dispatch',
      isActive: true,
    },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  return r.body as { id: string; chatId: string };
}
async function edit(
  caseIds: string[],
  fields: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return rpc(
    'cases.bulkEdit',
    {
      caseIds,
      fields,
      batchId: crypto.randomUUID(),
      note: '虛構歷史人工核對',
      ...extra,
    },
    { cookie: admin },
  );
}
async function detail(id: string) {
  return (await rpc('cases.detail', { id }, { cookie: admin })).body as {
    id: string;
    version: number;
    region: string;
    code: string;
    amountDue: number;
    customerName: string;
  };
}
async function assignment(id: string) {
  const r = await rpc(
    'cases.assign',
    {
      caseId: id,
      collectorId: collector,
      expectedVersion: (await detail(id)).version,
      note: '正式派件',
    },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
}
async function addImages(id: string, n: number) {
  const bucket = env.CASE_BUCKET;
  if (!bucket) throw new Error('Missing test bucket');
  const bytes = Uint8Array.from(atob(DEMO_IMAGES[0].base64), (c) =>
    c.charCodeAt(0),
  );
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('');
  for (let i = 0; i < n; i++) {
    const mid = crypto.randomUUID(),
      key = `cases/${id}/${mid}`;
    await bucket.put(key, bytes);
    await env.DB.prepare(
      'INSERT INTO case_media(id,case_id,storage_key,original_filename,media_type,sort_order,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)',
    )
      .bind(mid, id, key, `${i}.png`, 'image/png', i, hash, Date.now())
      .run();
  }
}
beforeAll(async () => {
  admin = await adminCookie();
  ordinary = await userCookie();
  collector = await newCollector();
  await route();
});
it('only selected region changes; invalid/unselected fields are rejected; partial success and idempotency audit', async () => {
  const id = await create(),
    before = await detail(id),
    batchId = crypto.randomUUID();
  const r = await edit([id, 'missing-case'], { region: '台北市' }, { batchId });
  expect(r.body).toMatchObject({ success: 1, skipped: 1 });
  expect(await detail(id)).toMatchObject({
    region: '台北市',
    code: before.code,
    amountDue: before.amountDue,
    customerName: before.customerName,
  });
  expect(
    (await edit([id, 'missing-case'], { region: '台北市' }, { batchId })).body,
  ).toMatchObject({ success: 1 });
  expect(
    (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_logs WHERE entity_id=? AND action='case.bulk_edited'",
      )
        .bind(id)
        .first()
    )?.n,
  ).toBe(1);
  expect((await edit([id], { customerName: '不允許' })).status).toBe(400);
  expect((await edit([id], {})).status).toBe(400);
});
it('fill empty warns and skips existing collector; explicit overwrite preserves correction history and never queues Telegram', async () => {
  const a = await create(),
    b = await create();
  await edit([a], { collectorId: collector });
  const preview = await rpc(
    'cases.bulkEditPreview',
    { caseIds: [a, b] },
    { cookie: admin },
  );
  expect(preview.body).toMatchObject({ existingCollectorCount: 1 });
  const other = await newCollector();
  expect((await edit([a, b], { collectorId: other })).body).toMatchObject({
    success: 1,
    skipped: 1,
  });
  expect(
    (await edit([a], { collectorId: other }, { mode: 'overwrite' })).status,
  ).toBe(400);
  expect(
    (
      await edit(
        [a],
        { collectorId: other },
        { mode: 'overwrite', confirmOverwrite: true },
      )
    ).body,
  ).toMatchObject({ success: 1 });
  const rows = await env.DB.prepare(
    'SELECT record_type,unassigned_at FROM assignments WHERE case_id=? ORDER BY assigned_at',
  )
    .bind(a)
    .all();
  expect(rows.results).toHaveLength(2);
  expect(rows.results.map((v) => v.record_type)).toEqual([
    'historical',
    'correction',
  ]);
  for (const id of [a, b]) {
    const current = await env.DB.prepare(
      'SELECT id FROM assignments WHERE case_id=? AND unassigned_at IS NULL',
    )
      .bind(id)
      .first<{ id: string }>();
    await queueAssignmentDispatch(base, current?.id ?? '');
  }
  await runTelegramProcessing(
    base,
    new FakeTelegramClient(),
    Date.now() + 10000,
  );
  expect(
    (
      await env.DB.prepare(
        'SELECT count(*) AS n FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id IN (?,?)',
      )
        .bind(a, b)
        .first()
    )?.n,
  ).toBe(0);
});
it('100 historical corrections create exactly zero outbound even after scheduler recovery', async () => {
  const ids = [];
  for (let i = 0; i < 100; i++) ids.push(await create());
  expect((await edit(ids, { collectorId: collector })).body).toMatchObject({
    success: 100,
    skipped: 0,
  });
  await runTelegramProcessing(
    base,
    new FakeTelegramClient(),
    Date.now() + 10000,
  );
  const rows = await env.DB.prepare(
    `SELECT count(*) AS n FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(...ids)
    .first();
  expect(rows?.n).toBe(0);
}, 60000);
it('single correction cannot queue dispatch; formal reassignment can', async () => {
  const id = await create();
  await assignment(id);
  const other = await newCollector();
  await route(other);
  expect(
    (
      await rpc(
        'cases.correctAssignment',
        {
          caseId: id,
          collectorId: other,
          expectedVersion: (await detail(id)).version,
          reason: '歷史核對',
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  await runTelegramProcessing(
    base,
    new FakeTelegramClient(),
    Date.now() + 10000,
  );
  expect(
    (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id=? AND a.record_type='correction'",
      )
        .bind(id)
        .first()
    )?.n,
  ).toBe(0);
  await assignment(id);
  expect(
    (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id=? AND a.record_type='assignment'",
      )
        .bind(id)
        .first()
    )?.n,
  ).toBe(2);
});
it('permissions, inactive collector and voided cases are rejected safely without deleting histories', async () => {
  const id = await create();
  expect(
    (
      await rpc(
        'cases.bulkEdit',
        {
          caseIds: [id],
          fields: { region: '台北市' },
          batchId: crypto.randomUUID(),
          note: '測試',
        },
        { cookie: ordinary },
      )
    ).status,
  ).toBe(403);
  const inactive = await newCollector();
  await env.DB.prepare('UPDATE collectors SET is_active=0 WHERE id=?')
    .bind(inactive)
    .run();
  expect((await edit([id], { collectorId: inactive })).body).toMatchObject({
    success: 0,
    skipped: 1,
  });
  expect(
    (
      await rpc(
        'cases.bulkVoid',
        { caseIds: [id], note: '虛構作廢', confirmed: true },
        { cookie: admin },
      )
    ).body,
  ).toMatchObject({ success: 1 });
  expect((await edit([id], { region: '台北市' })).body).toMatchObject({
    success: 0,
    skipped: 1,
  });
  expect(
    (
      await rpc(
        'cases.assign',
        { caseId: id, collectorId: collector, expectedVersion: 1, note: null },
        { cookie: admin },
      )
    ).status,
  ).toBe(409);
  expect(
    await env.DB.prepare('SELECT voided_at FROM cases WHERE id=?')
      .bind(id)
      .first(),
  ).toBeTruthy();
});
it.each([
  1, 2, 3, 11, 20,
])('formal dispatch sends all %i private images with per-case caption and never resends', async (n) => {
  const id = await create();
  await addImages(id, n);
  await assignment(id);
  const client = new FakeTelegramClient();
  await processOutbound(base, client, Date.now() + 10000);
  await processOutbound(base, client, Date.now() + 20000);
  expect(
    client.photos.length + client.albums.reduce((sum, a) => sum + a.length, 0),
  ).toBe(n);
  expect(
    client.sent.every(
      (m) => m.chatId && m.topicId === 2 && m.text.includes('地區：桃園市'),
    ),
  ).toBe(true);
  const job = await env.DB.prepare(
    'SELECT j.status,j.dispatch_state FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id=?',
  )
    .bind(id)
    .first<{ status: string; dispatch_state: string }>();
  expect(job?.status).toBe('sent');
  expect(JSON.parse(job?.dispatch_state ?? '{}').media).toHaveLength(n);
  expect(job?.dispatch_state).not.toContain('https://');
});
it('second album 429 retries only its remainder; unknown delivery never blindly resends', async () => {
  const id = await create();
  await addImages(id, 12);
  await assignment(id);
  class RetryClient extends FakeTelegramClient {
    calls = 0;
    override async sendMediaGroup(
      input: Parameters<FakeTelegramClient['sendMediaGroup']>[0],
    ) {
      this.calls++;
      if (this.calls === 2) throw new TelegramFailure('API_429', true);
      return super.sendMediaGroup(input);
    }
  }
  const client = new RetryClient();
  await processOutbound(base, client, Date.now() + 10000);
  expect(client.albums).toHaveLength(1);
  await processOutbound(base, client, Date.now() + 30000);
  expect(client.albums.map((v) => v.length)).toEqual([10, 2]);
  const unknown = await create();
  await addImages(unknown, 2);
  await assignment(unknown);
  const unsure = new FakeTelegramClient();
  unsure.uncertainSend = true;
  await processOutbound(base, unsure, Date.now() + 10000);
  await processOutbound(base, unsure, Date.now() + 30000);
  expect(unsure.sent).toHaveLength(1);
  expect(
    (
      await env.DB.prepare(
        'SELECT j.last_error_code FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id=?',
      )
        .bind(unknown)
        .first()
    )?.last_error_code,
  ).toBe('DELIVERY_UNKNOWN');
});
it('creating a case never dispatches; missing route warns and a different collector route never receives images', async () => {
  const id = await create();
  expect(
    (
      await env.DB.prepare(
        'SELECT count(*) AS n FROM assignments WHERE case_id=?',
      )
        .bind(id)
        .first()
    )?.n,
  ).toBe(0);
  const unrouted = await newCollector();
  const response = await rpc(
    'cases.assign',
    { caseId: id, collectorId: unrouted, expectedVersion: 0, note: null },
    { cookie: admin },
  );
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ telegramWarning: 'ROUTE_NOT_FOUND' });
  const correct = await create();
  await addImages(correct, 2);
  await assignment(correct);
  const other = await route(unrouted);
  await env.DB.prepare(
    'UPDATE telegram_outbound_jobs SET route_id=? WHERE assignment_id IN (SELECT id FROM assignments WHERE case_id=?)',
  )
    .bind(other.id, correct)
    .run();
  const client = new FakeTelegramClient();
  await processOutbound(base, client, Date.now() + 10000);
  expect(client.sent).toHaveLength(0);
  expect(
    (
      await env.DB.prepare(
        'SELECT j.last_error_code FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id=?',
      )
        .bind(correct)
        .first()
    )?.last_error_code,
  ).toBe('ASSIGNMENT_CHANGED');
});
it('void preserves linked receipts and pending returns, blocks new receipts and retains ordinary settlement rules', async () => {
  const id = await create();
  await env.DB.prepare('UPDATE cases SET amount_due=15000 WHERE id=?')
    .bind(id)
    .run();
  await assignFinanceFixture(id);
  const payment = await rpc(
    'finance.createPayment',
    {
      caseId: id,
      idempotencyKey: crypto.randomUUID(),
      receivedDate: new Date().toLocaleDateString('en-CA', {
        timeZone: 'Asia/Taipei',
      }),
      receivedAmount: 15000,
      installmentScheduleId: null,
    },
    { cookie: admin },
  );
  expect(payment.status).toBe(200);
  const before = await env.DB.prepare(
    'SELECT s.id,s.version,s.return_amount FROM settlements s JOIN payments p ON p.id=s.payment_id WHERE p.case_id=?',
  )
    .bind(id)
    .first<{ id: string; version: number; return_amount: number }>();
  expect(before?.return_amount).toBe(7500);
  expect(
    (
      await rpc(
        'cases.bulkVoid',
        { caseIds: [id], note: '虛構安全作廢', confirmed: true },
        { cookie: admin },
      )
    ).body,
  ).toMatchObject({ success: 1 });
  const extra = await rpc(
    'finance.createPayment',
    {
      caseId: id,
      idempotencyKey: crypto.randomUUID(),
      receivedDate: new Date().toLocaleDateString('en-CA', {
        timeZone: 'Asia/Taipei',
      }),
      receivedAmount: 10,
      installmentScheduleId: null,
    },
    { cookie: admin },
  );
  expect(extra.status).toBe(409);
  expect(
    (
      await rpc(
        'finance.markSettlement',
        {
          id: before?.id,
          expectedVersion: before?.version,
          returnStatus: 'returned',
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await env.DB.prepare('SELECT count(*) AS n FROM payments WHERE case_id=?')
        .bind(id)
        .first()
    )?.n,
  ).toBe(1);
});
