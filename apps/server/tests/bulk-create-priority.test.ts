import { env } from 'cloudflare:workers';
import {
  bulkCreateSchema,
  createBulkCases,
  previewBulkCases,
} from '@saasflare-dev/api/bulk-case-create';
import { uploadCaseImages } from '@saasflare-dev/api/case-media-management';
import type { Context } from '@saasflare-dev/api/context';
import { createPayment } from '@saasflare-dev/api/finance';
import { duePriority } from '@saasflare-dev/api/installment-priority';
import { telegramPrincipal } from '@saasflare-dev/api/telegram-principal';
import { DEMO_IMAGES } from '@saasflare-dev/db/demo-images';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, expect, it } from 'vitest';
import { adminCookie, assignFinanceFixture, rpc, userCookie } from './helpers';

let admin: string, ordinary: string, context: Context, collectorId: string;
beforeAll(async () => {
  admin = await adminCookie();
  ordinary = await userCookie();
  const actor = await env.DB.prepare(
    "SELECT id FROM user WHERE email='boss@test.dev'",
  ).first<{ id: string }>();
  context = await telegramPrincipal(
    {
      env,
      DB: drizzle(env.DB),
      headers: new Headers(),
      user: null,
      session: null,
      isAdmin: false,
    },
    actor?.id ?? '',
  );
  const collector = await rpc(
    'collectors.create',
    {
      displayName: '虛構批量外收',
      code: crypto.randomUUID(),
      isActive: true,
      userId: null,
    },
    { cookie: admin },
  );
  collectorId = (collector.body as { id: string }).id;
  expect(collector.status).toBe(200);
  expect(
    (
      await rpc(
        'telegram.saveRoute',
        {
          routeType: 'collector_dispatch',
          chatId: '-987612345',
          topicId: 3,
          collectorId,
          isActive: true,
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
});
function batch(mode: 'new' | 'historical', size = 20, collector = '') {
  const prefix = crypto.randomUUID();
  return bulkCreateSchema.parse({
    batchId: crypto.randomUUID(),
    mode,
    formalDispatch: mode === 'new' && !!collector,
    rows: Array.from({ length: size }, (_, index) => ({
      code: `${prefix}-${index}`,
      customerName: `虛構批量 ${index}`,
      region: '桃園市',
      collector,
    })),
  });
}
it('creates twenty unassigned new cases with individual audit, and retries without duplicate cases', async () => {
  const input = batch('new');
  const first = await createBulkCases(context, input);
  expect(first.succeeded).toBe(20);
  expect(first.failed).toBe(0);
  const again = await createBulkCases(context, input);
  expect(again.results.map((r) => r.caseId)).toEqual(
    first.results.map((r) => r.caseId),
  );
  for (const row of first.results) {
    expect(
      await env.DB.prepare('SELECT id FROM assignments WHERE case_id=?')
        .bind(row.caseId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT id FROM audit_logs WHERE entity_id=? AND action='case.created'",
      )
        .bind(row.caseId)
        .first(),
    ).not.toBeNull();
  }
});
it('partial validation failures preserve eighteen successful cases and expose row reasons', async () => {
  const input = batch('new');
  input.rows[3].code = '';
  input.rows[8].region = '不存在地區';
  const preview = await previewBulkCases(context, input);
  expect(preview[3].status).toBe('invalid');
  expect(preview[8].status).toBe('invalid');
  const created = await createBulkCases(context, input);
  expect(created.succeeded).toBe(18);
  expect(created.failed).toBe(2);
  expect(created.results[3].reason).toContain('缺少');
});
it('same-name different codes remain separate while same-name same-code requires explicit confirmation', async () => {
  const input = batch('new', 2);
  input.rows[1].customerName = input.rows[0].customerName;
  const first = await createBulkCases(context, input);
  expect(first.succeeded).toBe(2);
  const second = batch('new', 1);
  second.rows[0] = { ...input.rows[0] };
  expect((await previewBulkCases(context, second))[0].status).toBe('duplicate');
  expect((await createBulkCases(context, second)).succeeded).toBe(0);
  second.rows[0].duplicateOverride = true;
  expect((await createBulkCases(context, second)).succeeded).toBe(1);
});
it('creates twenty historical assignments with exactly zero outbound, including retry', async () => {
  const input = batch('historical', 20, collectorId);
  const first = await createBulkCases(context, input);
  expect(first.succeeded).toBe(20);
  expect((await createBulkCases(context, input)).succeeded).toBe(20);
  for (const result of first.results) {
    const assignment = await env.DB.prepare(
      'SELECT id,record_type FROM assignments WHERE case_id=? AND unassigned_at IS NULL',
    )
      .bind(result.caseId)
      .first<{ id: string; record_type: string }>();
    expect(assignment?.record_type).toBe('historical');
    expect(
      await env.DB.prepare(
        'SELECT id FROM telegram_outbound_jobs WHERE assignment_id=?',
      )
        .bind(assignment?.id)
        .first(),
    ).toBeNull();
    const record = await env.DB.prepare('SELECT source FROM cases WHERE id=?')
      .bind(result.caseId)
      .first<{ source: string }>();
    expect(record?.source).toBe('historical_import');
  }
  const id = first.results[0].caseId;
  const detail = await rpc('cases.detail', { id }, { cookie: admin });
  const assigned = await rpc(
    'cases.assign',
    {
      caseId: id,
      collectorId,
      expectedVersion: (detail.body as { version: number }).version,
      note: '虛構正式重新派件驗收',
    },
    { cookie: admin },
  );
  expect(assigned.status).toBe(200);
  const outbound = await env.DB.prepare(
    "SELECT j.id FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id=? AND a.unassigned_at IS NULL AND a.record_type='assignment'",
  )
    .bind(id)
    .first();
  expect(outbound).not.toBeNull();
});
it('historical rows without collector stay unassigned; new formal rows get individual assignments and outbound', async () => {
  const history = await createBulkCases(context, batch('historical', 2));
  expect(history.succeeded).toBe(2);
  expect(
    await env.DB.prepare('SELECT id FROM assignments WHERE case_id=?')
      .bind(history.results[0].caseId)
      .first(),
  ).toBeNull();
  const input = batch('new', 3, collectorId);
  input.rows.forEach((row) => {
    row.imageCount = 1;
  });
  const created = await createBulkCases(context, input);
  expect(created.succeeded).toBe(3);
  expect(
    (await createBulkCases(context, input)).results.map((r) => r.caseId),
  ).toEqual(created.results.map((r) => r.caseId));
  for (const row of created.results) {
    expect(
      await env.DB.prepare('SELECT id FROM assignments WHERE case_id=?')
        .bind(row.caseId)
        .first(),
    ).toBeNull();
    expect(
      (
        await rpc(
          'cases.finalizeBulkMedia',
          { batchId: input.batchId, row: row.row, expectedImageCount: 1 },
          { cookie: admin },
        )
      ).status,
    ).toBe(409);
    await upload(row.caseId as string, row.row);
    expect(
      (
        await rpc(
          'cases.finalizeBulkMedia',
          { batchId: input.batchId, row: row.row, expectedImageCount: 1 },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await rpc(
          'cases.finalizeBulkMedia',
          { batchId: input.batchId, row: row.row, expectedImageCount: 1 },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    const jobs = await env.DB.prepare(
      'SELECT j.id FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id=?',
    )
      .bind(row.caseId)
      .all();
    expect(jobs.results).toHaveLength(1);
  }
});
it('rejects invalid collector, missing route, unconfirmed formal dispatch, unauthenticated and unauthorized APIs', async () => {
  const input = batch('new', 1, 'missing');
  expect((await createBulkCases(context, input)).failed).toBe(1);
  input.rows[0].collector = collectorId;
  input.formalDispatch = false;
  expect((await createBulkCases(context, input)).failed).toBe(1);
  for (const path of ['cases.previewBulkCreate', 'cases.bulkCreate']) {
    expect((await rpc(path, input, { cookie: ordinary })).status).toBe(403);
    expect((await rpc(path, input, { cookie: null })).status).toBe(401);
  }
});
it('concurrent batch retries do not duplicate cases, historical assignments or audits', async () => {
  const input = batch('historical', 2, collectorId);
  const [a, b] = await Promise.all([
    createBulkCases(context, input),
    createBulkCases(context, input),
  ]);
  expect(a.succeeded + b.succeeded).toBe(4);
  expect(a.results.map((r) => r.caseId)).toEqual(
    b.results.map((r) => r.caseId),
  );
  for (const row of a.results) {
    expect(
      (
        await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM assignments WHERE case_id=?',
        )
          .bind(row.caseId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM audit_logs WHERE entity_id=? AND action='case.created'",
        )
          .bind(row.caseId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  }
});
it('formal concurrent retries without images create no assignment/job and changed inputs cannot reuse a row', async () => {
  const input = batch('new', 2, collectorId);
  const [first, second] = await Promise.all([
    createBulkCases(context, input),
    createBulkCases(context, input),
  ]);
  expect(first.succeeded).toBe(2);
  expect(second.succeeded).toBe(2);
  for (const row of first.results)
    expect(
      (
        await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id=?',
        )
          .bind(row.caseId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  input.rows[0].collector = '';
  expect((await createBulkCases(context, input)).results[0].status).toBe(
    'failed',
  );
});
async function upload(
  caseId: string,
  index: number,
  uploadKey = crypto.randomUUID(),
  invalid = false,
) {
  const record = await env.DB.prepare('SELECT version FROM cases WHERE id=?')
    .bind(caseId)
    .first<{ version: number }>();
  const body = new FormData();
  const bytes = Uint8Array.from(
    atob(DEMO_IMAGES[index % DEMO_IMAGES.length].base64),
    (c) => c.charCodeAt(0),
  );
  body.set(
    'files',
    new File(
      [invalid ? new Uint8Array([0]) : bytes],
      `fictional-${index}.png`,
      { type: 'image/png' },
    ),
  );
  body.set('expectedVersion', String(record?.version));
  body.set('uploadKey', uploadKey);
  const origin = (env.CORS_ORIGIN ?? 'http://localhost:3000').split(',')[0];
  return uploadCaseImages(
    context,
    caseId,
    new Request('http://localhost/api/media', {
      method: 'POST',
      headers: { Origin: origin },
      body,
    }),
  );
}
it.each([
  1, 5, 10, 20,
])('isolates %i mixed rows and uploads, with idempotent media retry and historical outbound zero', async (size) => {
  const input = batch('historical', size, collectorId),
    result = await createBulkCases(context, input);
  expect(result.succeeded).toBe(size);
  for (const row of result.results) {
    const id = row.caseId as string,
      count = size === 5 ? 5 : row.row % 3;
    for (let i = 0; i < count; i++) {
      const key = crypto.randomUUID();
      if (row.row === 1 && i === 0)
        await expect(upload(id, row.row, key, true)).rejects.toBeTruthy();
      const first = await upload(id, row.row, key);
      const again = await upload(id, row.row, key);
      expect(again.ids).toEqual(first.ids);
    }
    const media = await env.DB.prepare(
      'SELECT sha256 FROM case_media WHERE case_id=?',
    )
      .bind(id)
      .all<{ sha256: string }>();
    expect(media.results).toHaveLength(count);
    expect(
      media.results.every(
        (image) =>
          image.sha256 === DEMO_IMAGES[row.row % DEMO_IMAGES.length].sha256,
      ),
    ).toBe(true);
    expect(
      await env.DB.prepare(
        'SELECT j.id FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id=?',
      )
        .bind(id)
        .first(),
    ).toBeNull();
  }
  expect((await createBulkCases(context, input)).succeeded).toBe(size);
});
it('single-row transaction rollback does not leave a case or block other rows', async () => {
  const input = batch('new', 2);
  await env.DB.exec(
    `CREATE TRIGGER bulk_fixture_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='case.created' AND EXISTS(SELECT 1 FROM cases WHERE id=NEW.entity_id AND code='${input.rows[0].code}') BEGIN SELECT RAISE(ABORT,'FICTIONAL_AUDIT_FAILURE'); END;`,
  );
  try {
    const result = await createBulkCases(context, input);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(
      await env.DB.prepare('SELECT id FROM cases WHERE manual_entry_key=?')
        .bind(`${input.batchId}:0`)
        .first(),
    ).toBeNull();
    expect(result.results[1].caseId).not.toBeNull();
  } finally {
    await env.DB.exec('DROP TRIGGER bulk_fixture_audit_failure;');
  }
});
it('ten new rows can start awaiting images, receive one each, enforce permissions and finalize without duplicate outbound', async () => {
  const input = batch('new', 10, collectorId),
    result = await createBulkCases(context, input);
  expect(result.succeeded).toBe(10);
  const finalize = (row: number, cookie: string | null = admin) =>
    rpc(
      'cases.finalizeBulkMedia',
      { batchId: input.batchId, row, expectedImageCount: 1 },
      { cookie },
    );
  expect((await finalize(1, ordinary)).status).toBe(403);
  expect((await finalize(1, null)).status).toBe(401);
  expect((await finalize(1)).status).toBe(409);
  for (const row of result.results) {
    const caseId = row.caseId as string;
    const key = crypto.randomUUID();
    await upload(caseId, row.row, key);
    if (row.row === 1) {
      await env.DB.prepare('UPDATE collectors SET is_active=0 WHERE id=?')
        .bind(collectorId)
        .run();
      expect((await finalize(1)).status).toBe(400);
      await env.DB.prepare('UPDATE collectors SET is_active=1 WHERE id=?')
        .bind(collectorId)
        .run();
    }
    expect((await finalize(row.row)).status).toBe(200);
    expect((await finalize(row.row)).status).toBe(200);
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) n FROM case_media WHERE case_id=?',
        )
          .bind(caseId)
          .first()
      )?.n,
    ).toBe(1);
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) n FROM assignments WHERE case_id=?',
        )
          .bind(caseId)
          .first()
      )?.n,
    ).toBe(1);
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) n FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id=?',
        )
          .bind(caseId)
          .first()
      )?.n,
    ).toBe(1);
  }
});
it('inactive collectors and missing dispatch routes are rejected before case creation', async () => {
  const response = await rpc(
    'collectors.create',
    {
      displayName: '虛構無路由外收',
      code: crypto.randomUUID(),
      isActive: true,
      userId: null,
    },
    { cookie: admin },
  );
  const id = (response.body as { id: string }).id;
  const input = batch('new', 1, id);
  expect((await previewBulkCases(context, input))[0].reasons.join()).toContain(
    'Telegram',
  );
  expect((await createBulkCases(context, input)).succeeded).toBe(0);
  await env.DB.prepare('UPDATE collectors SET is_active=0 WHERE id=?')
    .bind(id)
    .run();
  input.mode = 'historical';
  expect((await previewBulkCases(context, input))[0].reasons.join()).toContain(
    '外收人員無效',
  );
  expect(
    await env.DB.prepare('SELECT id FROM cases WHERE manual_entry_key=?')
      .bind(`${input.batchId}:0`)
      .first(),
  ).toBeNull();
});
it('case.view_own remains enforced for a creator with individual bulk assignment grants', async () => {
  const ownContext: Context = {
    ...context,
    user: context.user
      ? {
          ...context.user,
          role: 'user',
          permissionAllow:
            '["case.create","assignment.create","assignment.bulk"]',
          permissionDeny: '[]',
        }
      : null,
  };
  const input = batch('historical', 1, collectorId);
  expect((await createBulkCases(ownContext, input)).succeeded).toBe(0);
  expect(
    await env.DB.prepare('SELECT id FROM cases WHERE manual_entry_key=?')
      .bind(`${input.batchId}:0`)
      .first(),
  ).toBeNull();
  const created = await rpc(
    'collectors.create',
    {
      displayName: '虛構自己委外',
      code: crypto.randomUUID(),
      isActive: true,
      userId: context.user?.id,
    },
    { cookie: admin },
  );
  input.rows[0].collector = (created.body as { id: string }).id;
  expect((await createBulkCases(ownContext, input)).succeeded).toBe(1);
});
it('classifies calendar boundaries including month/year crossings without time-of-day drift', () => {
  for (const [date, days, group] of [
    ['2026-10-26', -5, 'overdue'],
    ['2026-10-31', 0, 'today'],
    ['2026-11-01', 1, 'within3'],
    ['2026-11-03', 3, 'within3'],
    ['2026-11-07', 7, 'within7'],
    ['2026-11-08', 8, 'later'],
  ] as const)
    expect(duePriority(date, '2026-10-31')).toEqual({ days, group });
  expect(duePriority('2027-01-01', '2026-12-31').days).toBe(1);
});

async function plan(
  dueDate: string,
  status: 'active' | 'completed' = 'active',
) {
  const created = await createBulkCases(context, batch('new', 1));
  const caseId = created.results[0].caseId as string;
  const id = crypto.randomUUID(),
    scheduleId = crypto.randomUUID(),
    time = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE cases SET status='installment',amount_due=10000 WHERE id=?",
    ).bind(caseId),
    env.DB.prepare(
      "INSERT INTO installment_plans(id,case_id,plan_type,total_amount,per_payment_amount,day_of_month,status,created_by_user_id,created_at,updated_at) VALUES(?,?,'monthly',10000,5000,1,?,?,?,?)",
    ).bind(id, caseId, status, context.user?.id, time, time),
    env.DB.prepare(
      "INSERT INTO installment_schedules(id,plan_id,case_id,sequence,due_date,expected_amount,status,created_at,updated_at) VALUES(?,?,?,1,?,5000,'pending',?,?)",
    ).bind(scheduleId, id, caseId, dueDate, time, time),
    env.DB.prepare(
      "INSERT INTO installment_schedules(id,plan_id,case_id,sequence,due_date,expected_amount,status,created_at,updated_at) VALUES(?,?,?,2,'2026-12-01',5000,'pending',?,?)",
    ).bind(crypto.randomUUID(), id, caseId, time, time),
  ]);
  await upload(caseId, 1);
  return { caseId, id, scheduleId };
}
it('tracking count includes every valid assigned installment case independent of historical due dates', async () => {
  const before = await rpc('installments.priorityCount', undefined, {
    cookie: admin,
  });
  const rows = [];
  for (const date of ['2026-10-01', '2026-12-31']) {
    const r = await plan(date);
    await assignFinanceFixture(r.caseId);
    rows.push(r);
  }
  const ids = rows.map((r) => r.caseId);
  const result = await rpc(
    'installments.trackingList',
    { pageSize: 50 },
    { cookie: admin },
  );
  expect(result.status).toBe(200);
  expect(
    (result.body as { items: { id: string }[] }).items.filter((r) =>
      ids.includes(r.id),
    ),
  ).toHaveLength(2);
  expect(
    (await rpc('installments.priorityCount', undefined, { cookie: admin }))
      .body,
  ).toBe((before.body as number) + 2);
});
it('actual payment preserves a legacy plan and schedule; current status alone controls tracking', async () => {
  const r = await plan('2026-10-26');
  await assignFinanceFixture(r.caseId);
  const before = await env.DB.prepare(
    'SELECT * FROM installment_schedules WHERE id=?',
  )
    .bind(r.scheduleId)
    .first();
  await createPayment(context, {
    caseId: r.caseId,
    installmentScheduleId: null,
    idempotencyKey: crypto.randomUUID(),
    receivedDate: new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Taipei',
    }),
    receivedAmount: 8000,
  });
  expect(
    await env.DB.prepare('SELECT * FROM installment_schedules WHERE id=?')
      .bind(r.scheduleId)
      .first(),
  ).toEqual(before);
  await env.DB.prepare("UPDATE cases SET status='unresolved' WHERE id=?")
    .bind(r.caseId)
    .run();
  const list = await rpc('installments.trackingList', {}, { cookie: admin });
  expect(
    (list.body as { items: { id: string }[] }).items.some(
      (c) => c.id === r.caseId,
    ),
  ).toBe(false);
  expect(
    await env.DB.prepare('SELECT id FROM installment_plans WHERE id=?')
      .bind(r.id)
      .first(),
  ).toMatchObject({ id: r.id });
});
it('collector sees only active own assignments and cannot use admin collector filter', async () => {
  const uid = (
    await env.DB.prepare(
      "SELECT id FROM user WHERE email='customer@test.dev'",
    ).first<{ id: string }>()
  )?.id;
  await env.DB.prepare('UPDATE collectors SET user_id=? WHERE id=?')
    .bind(uid, collectorId)
    .run();
  const own = await plan('2026-10-31');
  expect(
    (
      await rpc(
        'cases.assign',
        { caseId: own.caseId, collectorId, expectedVersion: 1, note: null },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  const list = await rpc('installments.trackingList', {}, { cookie: ordinary });
  expect(list.status).toBe(200);
  const body = list.body as { items: { id: string }[] };
  expect(body.items).toHaveLength(1);
  expect(body.items[0].id).toBe(own.caseId);
  expect(
    (
      await rpc(
        'installments.trackingList',
        { collectorId },
        { cookie: ordinary },
      )
    ).status,
  ).toBe(403);
  expect(
    (await rpc('installments.trackingList', {}, { cookie: null })).status,
  ).toBe(401);
  const adminList = await rpc(
    'installments.trackingList',
    { collectorId },
    { cookie: admin },
  );
  expect(adminList.status).toBe(200);
});
