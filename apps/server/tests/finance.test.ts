import { env } from 'cloudflare:workers';
import {
  calculateCommission,
  generateSchedule,
  planCreateSchema,
} from '@saasflare-dev/api/finance-contract';
import { DEMO_IMAGES } from '@saasflare-dev/db/demo-images';
import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, expect, it } from 'vitest';
import app from '../src/index';
import { adminCookie, rpc, userCookie } from './helpers';

let admin: string, ordinary: string;
beforeAll(async () => {
  admin = await adminCookie();
  ordinary = await userCookie();
});
async function createCase(extra: Record<string, unknown> = {}) {
  const r = await rpc(
    'cases.create',
    {
      customerName: 'Fictional finance customer',
      code: crypto.randomUUID(),
      region: '高雄市',
      address: 'Fictional street',
      amountDue: 50000,
      status: 'pending',
      source: 'manual',
      revisitStatus: 'pending',
      revisitReason: '',
      ...extra,
    },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  expect((r.body as { kind: string }).kind).toBe('created');
  return r.body as { id: string; caseNo: string };
}
async function payment(
  caseId: string,
  extra: Record<string, unknown> = {},
  cookie = admin,
) {
  return rpc(
    'finance.createPayment',
    {
      caseId,
      idempotencyKey: crypto.randomUUID(),
      receivedDate: '2026-09-10',
      receivedAmount: 15000,
      ...extra,
    },
    { cookie },
  );
}
it('generates deadline, weekly remainder and actual calendar months with leap and missing-day clamping', () => {
  expect(
    generateSchedule(
      {
        caseId: 'case',
        reportId: null,
        planType: 'deadline',
        deadlineDate: '2026-10-20',
        totalAmount: 15000,
      },
      '2026-10-08',
    ),
  ).toEqual([{ sequence: 1, dueDate: '2026-10-20', expectedAmount: 15000 }]);
  const weekly = generateSchedule(
    {
      caseId: 'case',
      reportId: null,
      planType: 'weekly',
      weekday: 3,
      perPaymentAmount: 5000,
      totalAmount: 23000,
    },
    '2026-10-08',
  );
  expect(weekly.map((s) => s.expectedAmount)).toEqual([
    5000, 5000, 5000, 5000, 3000,
  ]);
  expect(weekly[0].dueDate).toBe('2026-10-14');
  expect(weekly[1].dueDate).toBe('2026-10-21');
  expect(
    generateSchedule(
      {
        caseId: 'case',
        reportId: null,
        planType: 'monthly',
        dayOfMonth: 31,
        perPaymentAmount: 5000,
        totalAmount: 15000,
      },
      '2028-01-30',
    ).map((s) => s.dueDate),
  ).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
  expect(
    generateSchedule(
      {
        caseId: 'case',
        reportId: null,
        planType: 'monthly',
        dayOfMonth: 10,
        perPaymentAmount: 5000,
        totalAmount: 15000,
      },
      '2026-10-11',
    ).map((s) => s.dueDate),
  ).toEqual(['2026-11-10', '2026-12-10', '2027-01-10']);
  expect(
    planCreateSchema.safeParse({
      caseId: 'case',
      planType: 'deadline',
      deadlineDate: '2026-02-30',
      totalAmount: 1,
    }).success,
  ).toBe(false);
  expect(
    planCreateSchema.safeParse({
      caseId: 'case',
      planType: 'weekly',
      weekday: 3,
      perPaymentAmount: -1,
      totalAmount: 100,
    }).success,
  ).toBe(false);
  expect(calculateCommission(15000, 0.5)).toEqual({
    commissionRate: 0.5,
    commissionAmount: 7500,
    returnAmount: 7500,
  });
  expect(calculateCommission(3, 0.5).returnAmount).toBe(1);
  expect(calculateCommission(15000, 0.25).returnAmount).toBe(11250);
});
it('plan creation predicts receipts, payment advances a schedule, void restores it without deleting history', async () => {
  const c = await createCase();
  const plan = await rpc(
    'installments.create',
    {
      caseId: c.id,
      planType: 'weekly',
      weekday: 3,
      perPaymentAmount: 5000,
      totalAmount: 23000,
    },
    { cookie: admin },
  );
  expect(plan.status).toBe(200);
  const list = await rpc('installments.list', { id: c.id }, { cookie: admin });
  const schedules = (
    list.body as { schedules: { id: string; expectedAmount: number }[] }
  ).schedules;
  expect(schedules).toHaveLength(5);
  expect(
    (
      await env.DB.prepare('SELECT count(*) AS n FROM payments WHERE case_id=?')
        .bind(c.id)
        .first()
    )?.n,
  ).toBe(0);
  const receipt = await payment(c.id, {
    receivedAmount: 2000,
    installmentScheduleId: schedules[0].id,
  });
  expect(receipt.status).toBe(200);
  const id = (receipt.body as { id: string }).id;
  expect(
    (
      await env.DB.prepare(
        'SELECT paid_amount FROM installment_schedules WHERE id=?',
      )
        .bind(schedules[0].id)
        .first()
    )?.paid_amount,
  ).toBe(2000);
  expect(
    (
      await payment(c.id, {
        receivedAmount: 4000,
        installmentScheduleId: schedules[0].id,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await rpc(
        'finance.voidPayment',
        { id, expectedVersion: 0 },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await env.DB.prepare(
        'SELECT paid_amount FROM installment_schedules WHERE id=?',
      )
        .bind(schedules[0].id)
        .first()
    )?.paid_amount,
  ).toBe(0);
  expect(
    (
      await env.DB.prepare('SELECT status FROM payments WHERE id=?')
        .bind(id)
        .first()
    )?.status,
  ).toBe('voided');
});
it('concurrent payment retries create one pending settlement; return marking is separate and permission guarded', async () => {
  const c = await createCase();
  const input = { idempotencyKey: crypto.randomUUID() };
  const receipts = await Promise.all([
    payment(c.id, input),
    payment(c.id, input),
  ]);
  expect(receipts.map((r) => r.status)).toEqual([200, 200]);
  expect(receipts[0].body).toMatchObject({
    id: (receipts[1].body as { id: string }).id,
  });
  const id = (receipts[0].body as { id: string }).id;
  const ledger = await env.DB.prepare(
    'SELECT * FROM settlements WHERE payment_id=?',
  )
    .bind(id)
    .all<{ id: string; return_amount: number; return_status: string }>();
  expect(ledger.results).toHaveLength(1);
  const row = ledger.results[0];
  expect(row).toMatchObject({ return_amount: 7500, return_status: 'pending' });
  expect(
    (
      await rpc(
        'finance.markSettlement',
        { id: row.id, expectedVersion: 0, returnStatus: 'returned' },
        { cookie: ordinary },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await rpc(
        'finance.markSettlement',
        { id: row.id, expectedVersion: 0, returnStatus: 'returned' },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await env.DB.prepare(
        'SELECT returned_at,returned_by_user_id FROM settlements WHERE id=?',
      )
        .bind(row.id)
        .first()
    )?.returned_at,
  ).toBeTypeOf('number');
  expect(
    (
      await rpc(
        'finance.voidPayment',
        { id, expectedVersion: 0 },
        { cookie: admin },
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await rpc(
        'finance.markSettlement',
        { id: row.id, expectedVersion: 1, returnStatus: 'pending' },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await env.DB.prepare('SELECT returned_at FROM settlements WHERE id=?')
        .bind(row.id)
        .first()
    )?.returned_at,
  ).toBeNull();
  expect((await payment(c.id, { ...input, receivedAmount: 999 })).status).toBe(
    409,
  );
});
it('exports genuine XLSX with five safe columns, exact return amount and an inclusive date range', async () => {
  const c = await createCase();
  await payment(c.id, { receivedDate: '2026-09-12' });
  await payment(c.id, { receivedDate: '2026-09-13' });
  const response = await app.fetch(
    new Request(
      'http://localhost/api/finance/settlements.xlsx?dateFrom=2026-09-12&dateTo=2026-09-12',
      { headers: { Cookie: admin } },
    ),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toContain('spreadsheetml');
  const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
  expect(Object.keys(zip)).toContain('xl/workbook.xml');
  const sheet = strFromU8(zip['xl/worksheets/sheet1.xml']);
  for (const column of ['日期', '代理/代號', '客戶', '金額', '類型'])
    expect(sheet).toContain(column);
  expect(sheet).toContain('<v>7500</v>');
  expect(sheet).not.toContain('2026/09/13');
  expect(sheet).not.toContain(c.id);
  expect(sheet).not.toContain('<f>');
  expect(
    (
      await app.fetch(
        new Request('http://localhost/api/finance/settlements.xlsx', {
          headers: { Cookie: ordinary },
        }),
      )
    ).status,
  ).toBe(403);
});
it('snapshots stay unchanged after name/code/region and historical collector corrections', async () => {
  const c = await createCase();
  const a = await rpc(
    'collectors.create',
    {
      displayName: 'Fictional original',
      code: crypto.randomUUID(),
      isActive: true,
      userId: null,
    },
    { cookie: admin },
  );
  const b = await rpc(
    'collectors.create',
    {
      displayName: 'Fictional corrected',
      code: crypto.randomUUID(),
      isActive: true,
      userId: null,
    },
    { cookie: admin },
  );
  const collectorA = (a.body as { id: string }).id,
    collectorB = (b.body as { id: string }).id;
  let record = (await rpc('cases.detail', { id: c.id }, { cookie: admin }))
    .body as { version: number };
  expect(
    (
      await rpc(
        'cases.assign',
        {
          caseId: c.id,
          collectorId: collectorA,
          expectedVersion: record.version,
          note: 'Fictional historical entry',
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  const receipt = await payment(c.id);
  expect(receipt.status).toBe(200);
  const prior = await env.DB.prepare(
    'SELECT * FROM settlements WHERE payment_id=?',
  )
    .bind((receipt.body as { id: string }).id)
    .first();
  record = (await rpc('cases.detail', { id: c.id }, { cookie: admin }))
    .body as { version: number };
  expect(
    (
      await rpc(
        'cases.correctAssignment',
        {
          caseId: c.id,
          collectorId: collectorB,
          expectedVersion: record.version,
          reason: 'Fictional historical correction',
        },
        { cookie: ordinary },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await rpc(
        'cases.correctAssignment',
        {
          caseId: c.id,
          collectorId: collectorB,
          expectedVersion: record.version,
          reason: 'Fictional historical correction',
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  const history = await env.DB.prepare(
    'SELECT assigned_at,record_type,unassigned_at FROM assignments WHERE case_id=?',
  )
    .bind(c.id)
    .all();
  expect(history.results).toHaveLength(2);
  expect(history.results[0].assigned_at).toBe(history.results[1].assigned_at);
  expect(history.results.some((r) => r.record_type === 'correction')).toBe(
    true,
  );
  const d = (await rpc('cases.detail', { id: c.id }, { cookie: admin }))
    .body as Record<string, unknown>;
  expect(
    (
      await rpc(
        'cases.edit',
        {
          id: c.id,
          expectedVersion: d.version,
          customerName: 'Corrected fictional name',
          code: crypto.randomUUID(),
          region: '台南市',
          address: d.address,
          amountDue: d.amountDue,
          status: d.status,
          revisitStatus: d.revisitStatus,
          revisitReason: d.revisitReason,
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  expect(
    await env.DB.prepare('SELECT * FROM settlements WHERE payment_id=?')
      .bind((receipt.body as { id: string }).id)
      .first(),
  ).toEqual(prior);
  const filtered = await rpc(
    'cases.list',
    { region: '台南市', collectorId: collectorB, assignmentStatus: 'assigned' },
    { cookie: admin },
  );
  expect(
    (filtered.body as { items: { id: string }[] }).items.some(
      (r) => r.id === c.id,
    ),
  ).toBe(true);
  const regions = await rpc('cases.regions', {}, { cookie: admin });
  expect(
    (regions.body as { region: string; assigned: number }[]).find(
      (r) => r.region === '台南市',
    )?.assigned,
  ).toBeGreaterThanOrEqual(1);
});
async function manual(
  code: string,
  override = false,
  key = crypto.randomUUID(),
  cookie = admin,
) {
  const form = new FormData();
  form.append(
    'input',
    JSON.stringify({
      customerName: 'Fictional manual customer',
      code,
      region: '高雄市',
      idempotencyKey: key,
      duplicateOverride: override,
    }),
  );
  form.append(
    'files',
    new File(
      [
        Uint8Array.from(atob(DEMO_IMAGES[0].base64), (c) => c.charCodeAt(0))
          .buffer,
      ],
      'fictional-finished.png',
      { type: 'image/png' },
    ),
  );
  return app.fetch(
    new Request('http://localhost/api/cases/manual', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'http://localhost:3000' },
      body: form,
    }),
  );
}
it('manual case and private SHA media are atomic, warnings expose only date and overrides preserve the old case', async () => {
  const code = crypto.randomUUID(),
    key = crypto.randomUUID();
  const first = await manual(code, false, key);
  expect(first.status).toBe(201);
  const created = (await first.json()) as { id: string };
  const media = await env.DB.prepare(
    'SELECT sha256 FROM case_media WHERE case_id=?',
  )
    .bind(created.id)
    .first();
  expect(media?.sha256).toMatch(/^[a-f0-9]{64}$/);
  const replay = await manual(code, false, key);
  expect(await replay.json()).toMatchObject({
    id: created.id,
    duplicate: true,
  });
  const warning = await manual(code);
  expect(await warning.json()).toMatchObject({
    kind: 'duplicate_warning',
    duplicate: true,
  });
  expect(
    (
      await env.DB.prepare('SELECT count(*) AS n FROM cases WHERE code=?')
        .bind(code)
        .first()
    )?.n,
  ).toBe(1);
  const override = await manual(code, true);
  expect(((await override.json()) as { id: string }).id).not.toBe(created.id);
  expect(
    (
      await env.DB.prepare('SELECT count(*) AS n FROM cases WHERE code=?')
        .bind(code)
        .first()
    )?.n,
  ).toBe(2);
  expect((await manual(crypto.randomUUID())).status).toBe(201);
  expect(
    (await manual(crypto.randomUUID(), false, crypto.randomUUID(), ordinary))
      .status,
  ).toBe(403);
  expect(
    (
      await env.DB.prepare(
        'SELECT count(*) AS n FROM ai_image_jobs WHERE intake_id=?',
      )
        .bind(created.id)
        .first()
    )?.n,
  ).toBe(0);
});
it('region schema and database reject free text; unassigned summaries and combined filters use active assignments', async () => {
  const c = await createCase({ region: '台中市' });
  expect(
    (
      await rpc(
        'cases.create',
        {
          customerName: 'Fictional',
          code: crypto.randomUUID(),
          address: 'Fictional',
          region: '自由文字',
          amountDue: 0,
          status: 'pending',
          source: 'manual',
          revisitStatus: 'pending',
          revisitReason: '',
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(400);
  await expect(
    env.DB.prepare('UPDATE cases SET region=? WHERE id=?')
      .bind('Free text', c.id)
      .run(),
  ).rejects.toThrow();
  const list = await rpc(
    'cases.list',
    { region: '台中市', assignmentStatus: 'unassigned', status: 'pending' },
    { cookie: admin },
  );
  expect(
    (list.body as { items: { id: string }[] }).items.some((r) => r.id === c.id),
  ).toBe(true);
  const regions = await rpc('cases.regions', {}, { cookie: admin });
  expect(
    (regions.body as { region: string; unassigned: number }[]).find(
      (r) => r.region === '台中市',
    )?.unassigned,
  ).toBeGreaterThanOrEqual(1);
  expect(
    (await env.DB.prepare('PRAGMA foreign_key_check').all()).results,
  ).toEqual([]);
});

it('failed settlement insertion rolls the entire receipt transaction back', async () => {
  const c = await createCase(),
    key = crypto.randomUUID();
  await env.DB.exec(
    "CREATE TRIGGER finance_rollback BEFORE INSERT ON settlements BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
  );
  try {
    expect((await payment(c.id, { idempotencyKey: key })).status).toBe(409);
  } finally {
    await env.DB.exec('DROP TRIGGER finance_rollback');
  }
  expect(
    (
      await env.DB.prepare('SELECT count(*) AS n FROM payments WHERE case_id=?')
        .bind(c.id)
        .first()
    )?.n,
  ).toBe(0);
  expect((await payment(c.id, { idempotencyKey: key })).status).toBe(200);
});
it('collector cannot bypass installment confirmation or record receipts against another case', async () => {
  const c = await createCase();
  expect(
    (
      await rpc(
        'installments.create',
        {
          caseId: c.id,
          planType: 'deadline',
          deadlineDate: '2090-10-20',
          totalAmount: 15000,
        },
        { cookie: ordinary },
      )
    ).status,
  ).toBe(403);
  expect((await payment(c.id, {}, ordinary)).status).toBe(404);
});

it('voiding a receipt after cancellation preserves the cancelled forecast and original amounts', async () => {
  const c = await createCase();
  const plan = await rpc(
    'installments.create',
    {
      caseId: c.id,
      planType: 'weekly',
      weekday: 3,
      totalAmount: 10000,
      perPaymentAmount: 5000,
    },
    { cookie: admin },
  );
  expect(plan.status).toBe(200);
  let detail = (await rpc('installments.list', { id: c.id }, { cookie: admin }))
    .body as {
    plans: { id: string; version: number }[];
    schedules: { id: string }[];
  };
  const scheduleId = detail.schedules[0].id;
  const receipt = await payment(c.id, {
    receivedAmount: 5000,
    installmentScheduleId: scheduleId,
  });
  expect(receipt.status).toBe(200);
  detail = (await rpc('installments.list', { id: c.id }, { cookie: admin }))
    .body as typeof detail;
  expect(
    (
      await rpc(
        'installments.cancel',
        { id: detail.plans[0].id, expectedVersion: detail.plans[0].version },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await rpc(
        'finance.voidPayment',
        { id: (receipt.body as { id: string }).id, expectedVersion: 0 },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  expect(
    await env.DB.prepare(
      'SELECT status,expected_amount,paid_amount FROM installment_schedules WHERE id=?',
    )
      .bind(scheduleId)
      .first(),
  ).toMatchObject({
    status: 'cancelled',
    expected_amount: 5000,
    paid_amount: 0,
  });
});
it('commission configuration is snapshotted per receipt and manual API warning also requires explicit override', async () => {
  const c = await createCase(),
    settings = env as unknown as { COMMISSION_RATE?: string };
  const old = settings.COMMISSION_RATE;
  try {
    settings.COMMISSION_RATE = '0.25';
    const receipt = await payment(c.id);
    expect(receipt.status).toBe(200);
    settings.COMMISSION_RATE = '0.50';
    expect(
      await env.DB.prepare(
        'SELECT commission_rate,return_amount FROM settlements WHERE payment_id=?',
      )
        .bind((receipt.body as { id: string }).id)
        .first(),
    ).toMatchObject({ commission_rate: 0.25, return_amount: 11250 });
  } finally {
    settings.COMMISSION_RATE = old;
  }
  const detail = (await rpc('cases.detail', { id: c.id }, { cookie: admin }))
    .body as { code: string };
  const warning = await rpc(
    'cases.create',
    {
      customerName: 'Another fictional customer',
      code: detail.code,
      address: 'Fictional',
      amountDue: 0,
      status: 'pending',
      source: 'manual',
      revisitStatus: 'pending',
      revisitReason: '',
    },
    { cookie: admin },
  );
  expect(warning.status).toBe(200);
  expect(warning.body).toMatchObject({ kind: 'duplicate_warning' });
  expect(
    (
      await env.DB.prepare('SELECT count(*) AS n FROM cases WHERE code=?')
        .bind(detail.code)
        .first()
    )?.n,
  ).toBe(1);
});
