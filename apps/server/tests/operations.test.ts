import { env } from 'cloudflare:workers';
import type { Context } from '@saasflare-dev/api/context';
import { createPayment } from '@saasflare-dev/api/finance';
import { permissionPolicy } from '@saasflare-dev/api/permissions';
import {
  cleanupSystemLogs,
  sanitizeLogText,
  systemLog,
} from '@saasflare-dev/api/system-log';
import { FakeTelegramClient } from '@saasflare-dev/api/telegram-client';
import {
  callbackFixture,
  photoFixture,
  reportFixture,
} from '@saasflare-dev/api/telegram-fixtures';
import { processOutbound } from '@saasflare-dev/api/telegram-outbound';
import { telegramPrincipal } from '@saasflare-dev/api/telegram-principal';
import {
  processTelegramUpdates,
  receiveTelegramUpdate,
} from '@saasflare-dev/api/telegram-processing';
import { reportRoutePrincipal } from '@saasflare-dev/api/telegram-report-principal';
import { telegramRoutes } from '@saasflare-dev/db';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, expect, it } from 'vitest';
import app from '../src/index';
import {
  adminCookie,
  configureFinanceFixture,
  H,
  provisionUser,
  rpc,
  sendOtp,
  signIn,
  userCookie,
} from './helpers';

let admin: string, ordinary: string, actorId: string;
const base: Context = {
  env,
  DB: drizzle(env.DB),
  headers: new Headers(),
  session: null,
  user: null,
  isAdmin: false,
};
beforeAll(async () => {
  admin = await adminCookie();
  ordinary = await userCookie();
  actorId =
    (
      await env.DB.prepare(
        "SELECT id FROM user WHERE email='boss@test.dev'",
      ).first<{ id: string }>()
    )?.id ?? '';
});
async function savedUser(
  email: string,
  role = 'user',
  allow: string[] = [],
  deny: string[] = [],
  active = true,
) {
  const r = await rpc(
    'users.save',
    { name: '虛構營運帳號', email, role, allow, deny, active },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  return (r.body as { id: string }).id;
}
it('unknown email has no OTP, user or session and safe denial log', async () => {
  const email = `unknown-${crypto.randomUUID()}@example.test`;
  expect((await sendOtp(email)).status).toBe(403);
  expect(
    await env.DB.prepare('SELECT id FROM user WHERE email=?')
      .bind(email)
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare('SELECT id FROM verification WHERE identifier=?')
      .bind(`sign-in-otp-${email}`)
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT id FROM system_logs WHERE event='EMAIL_NOT_ALLOWED'",
    ).first(),
  ).toBeTruthy();
});
it('normalized allowlisted email signs in; Gmail aliases remain distinct', async () => {
  await provisionUser('case-normalized@example.test');
  expect((await sendOtp('  CASE-NORMALIZED@EXAMPLE.TEST  ')).status).toBe(200);
  expect(await signIn('case-normalized@example.test')).toContain('better-auth');
  await savedUser('fictional+finance@gmail.com');
  expect((await sendOtp('fictional@gmail.com')).status).toBe(403);
});
it('inactive users cannot request OTP, verify existing OTP or use cached sessions', async () => {
  const email = `inactive-${crypto.randomUUID()}@example.test`;
  const id = await savedUser(email);
  const cookie = await signIn(email);
  await sendOtp(email);
  const otp = (
    await env.DB.prepare('SELECT value FROM verification WHERE identifier=?')
      .bind(`sign-in-otp-${email}`)
      .first<{ value: string }>()
  )?.value.split(':')[0];
  expect(
    (
      await rpc(
        'users.save',
        {
          id,
          name: '虛構停用帳號',
          email,
          role: 'user',
          active: false,
          allow: [],
          deny: [],
          expectedVersion: 0,
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  expect((await sendOtp(email)).status).toBe(403);
  expect(
    (
      await app.fetch(
        new Request('http://localhost/api/auth/sign-in/email-otp', {
          method: 'POST',
          headers: H,
          body: JSON.stringify({ email, otp }),
        }),
      )
    ).status,
  ).toBe(403);
  expect((await rpc('cases.list', {}, { cookie })).status).toBe(401);
  const res = await app.fetch(
    new Request('http://localhost/api/auth/get-session', {
      headers: { Cookie: cookie },
    }),
  );
  expect(await res.json()).toBeNull();
});
it('explicit deny wins; finance extra case create permission applies immediately', async () => {
  const email = `grants-${crypto.randomUUID()}@example.test`,
    id = await savedUser(
      email,
      'finance',
      ['case.create', 'case.search'],
      ['case.search'],
    );
  const cookie = await signIn(email);
  expect((await rpc('cases.list', { query: 'abc' }, { cookie })).status).toBe(
    403,
  );
  expect((await rpc('cases.list', {}, { cookie })).status).toBe(200);
  expect(
    (
      await rpc(
        'cases.create',
        {
          customerName: '虛構權限測試',
          code: crypto.randomUUID(),
          address: '虛構街',
          amountDue: 100,
          status: 'pending',
          source: 'manual',
          revisitStatus: 'pending',
          revisitReason: '',
        },
        { cookie },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await rpc(
        'users.save',
        {
          id,
          name: '虛構營運帳號',
          email,
          role: 'finance',
          active: true,
          allow: [],
          deny: ['case.create'],
          expectedVersion: 0,
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await rpc(
        'cases.create',
        {
          customerName: '虛構',
          code: 'x',
          address: '虛構',
          amountDue: 100,
          status: 'pending',
          source: 'manual',
          revisitStatus: 'pending',
          revisitReason: '',
        },
        { cookie },
      )
    ).status,
  ).toBe(403);
});
it('ordinary users cannot manage themselves, other users, routes, logs or bulk assignments', async () => {
  for (const path of [
    'users.list',
    'users.keys',
    'telegram.routes',
    'systemLogs.summary',
  ])
    expect((await rpc(path, undefined, { cookie: ordinary })).status).toBe(403);
  expect(
    (
      await rpc(
        'users.save',
        {
          id: actorId,
          name: 'x',
          email: 'boss@test.dev',
          role: 'admin',
          active: true,
          allow: [],
          deny: [],
        },
        { cookie: ordinary },
      )
    ).status,
  ).toBe(403);
});
it('last active permission manager cannot be disabled, denied or change email', async () => {
  for (const changes of [
    { active: false },
    { deny: ['user_permission.manage'] },
    { email: 'changed@example.test' },
  ])
    expect(
      (
        await rpc(
          'users.save',
          {
            id: actorId,
            name: '管理員',
            email: 'boss@test.dev',
            role: 'admin',
            active: true,
            allow: [],
            deny: [],
            expectedVersion: 0,
            ...changes,
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(409);
});
it('permission audit stores before and after grants', async () => {
  const row = await env.DB.prepare(
    "SELECT metadata FROM audit_logs WHERE action='user.permissions_changed' ORDER BY created_at DESC LIMIT 1",
  ).first<{ metadata: string }>();
  expect(JSON.parse(row?.metadata ?? '{}')).toHaveProperty('before');
  expect(JSON.parse(row?.metadata ?? '{}')).toHaveProperty('after');
});
it('policy denies viewing own/all independently and role defaults do not bypass deny', () => {
  const policy = permissionPolicy({
    user: {
      id: 'x',
      email: 'x@example.test',
      name: 'x',
      role: 'admin',
      permissionAllow: '["case.search"]',
      permissionDeny: '["case.view_all","case.search"]',
    },
  });
  expect(policy.scope).toBe('assigned');
  expect(policy.permissions).not.toContain('case.search');
  expect(policy.permissions).not.toContain('case.view_all');
});
let sequence = 99000000;
async function reportSetup() {
  const suffix = ++sequence;
  const collector = (
    await rpc(
      'collectors.create',
      {
        displayName: `虛構群組外收${suffix}`,
        code: String(suffix),
        userId: null,
        isActive: true,
      },
      { cookie: admin },
    )
  ).body as { id: string };
  const chat = -1000000000 - suffix * 100;
  const route = (
    await rpc(
      'telegram.saveRoute',
      {
        name: '虛構回報群',
        chatId: String(chat),
        topicId: 2,
        collectorId: collector.id,
        routeType: 'collector_report',
        isActive: true,
      },
      { cookie: admin },
    )
  ).body as { id: string };
  const c = (
    await rpc(
      'cases.create',
      {
        customerName: '虛構群組客戶',
        code: `OPS-${suffix}`,
        address: '虛構街',
        amountDue: 50000,
        status: 'pending',
        source: 'manual',
        revisitStatus: 'pending',
        revisitReason: '',
      },
      { cookie: admin },
    )
  ).body as { id: string };
  await configureFinanceFixture(collector.id);
  await rpc(
    'cases.assign',
    {
      caseId: c.id,
      collectorId: collector.id,
      expectedVersion: 0,
      note: '虛構',
    },
    { cookie: admin },
  );
  return { collector, route, c, chat, code: `OPS-${suffix}` };
}
it('report photos retain no photo metadata, private media or AI jobs', async () => {
  const { chat } = await reportSetup();
  const client = new FakeTelegramClient();
  const update = photoFixture(++sequence, chat, { topicId: 2 });
  await receiveTelegramUpdate(base, update);
  await processTelegramUpdates(base, client, Date.now() + 10000);
  const row = await env.DB.prepare(
    'SELECT payload,result_code,intake_id,media_id FROM telegram_updates WHERE id=?',
  )
    .bind(String(update.update_id))
    .first();
  expect(row).toMatchObject({
    payload: '{}',
    result_code: 'REPORT_MEDIA_NO_ACTIVE_DRAFT',
    intake_id: null,
    media_id: null,
  });
  expect(client.downloads).toHaveLength(0);
  await processOutbound(base, client, Date.now() + 10000);
});
it('route collector without Telegram identity reports and different group member confirms settlement once', async () => {
  const { chat, c, code, collector } = await reportSetup();
  const client = new FakeTelegramClient();
  const report = reportFixture(++sequence, chat, 111, code);
  if (report.message) report.message.message_thread_id = 2;
  await receiveNameReport(report, client);
  const r = await env.DB.prepare(
    'SELECT id,callback_token,collector_id FROM reports WHERE origin_key=?',
  )
    .bind(`telegram-update:${report.update_id}`)
    .first<{ id: string; callback_token: string; collector_id: string }>();
  expect(r?.collector_id).toBe(collector.id);
  const cb = callbackFixture(
    ++sequence,
    chat,
    999,
    r?.callback_token ?? '',
    'settled',
    2,
  );
  await receiveTelegramUpdate(base, cb);
  await processTelegramUpdates(base, client, Date.now() + 10000);
  expect(
    (
      await env.DB.prepare('SELECT status FROM cases WHERE id=?')
        .bind(c.id)
        .first()
    )?.status,
  ).toBe('pending');
  const amount = reportFixture(++sequence, chat, 777, code);
  if (amount.message) {
    amount.message.message_thread_id = 2;
    amount.message.text = '15000';
  }
  await receiveTelegramUpdate(base, amount);
  await processTelegramUpdates(base, client, Date.now() + 10000);
  await receiveTelegramUpdate(base, amount);
  await processTelegramUpdates(base, client, Date.now() + 20000);
  expect(
    (
      await env.DB.prepare('SELECT status FROM cases WHERE id=?')
        .bind(c.id)
        .first()
    )?.status,
  ).toBe('settled');
  const ledger = await env.DB.prepare(
    'SELECT p.received_amount,s.commission_rate,s.return_amount,s.return_status FROM payments p JOIN settlements s ON s.payment_id=p.id WHERE p.case_id=?',
  )
    .bind(c.id)
    .all();
  expect(ledger.results).toEqual([
    {
      received_amount: 15000,
      commission_rate: 0.5,
      return_amount: 7500,
      return_status: 'pending',
    },
  ]);
});
it('route conflicts and inactive collectors rejected; route test does not expose token', async () => {
  const { chat, collector } = await reportSetup();
  expect(
    (
      await rpc(
        'telegram.saveRoute',
        {
          chatId: String(chat),
          topicId: 2,
          routeType: 'intake',
          isActive: true,
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await rpc(
        'telegram.saveRoute',
        {
          chatId: String(chat - 1),
          topicId: 2,
          routeType: 'collector_report',
          collectorId: collector.id,
          isActive: true,
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(409);
  const r = await rpc(
    'telegram.saveRoute',
    {
      chatId: String(chat - 2),
      topicId: 2,
      routeType: 'collector_dispatch',
      collectorId: collector.id,
      isActive: true,
    },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  const sent = await rpc(
    'telegram.testRoute',
    { id: (r.body as { id: string }).id },
    { cookie: admin },
  );
  expect(sent.body).toMatchObject({ success: true, message: '測試成功' });
  expect(JSON.stringify(sent.body)).not.toContain('token');
});
it('logs are safe, searchable, separate from audit and editable only in handling fields', async () => {
  expect(sanitizeLogText(`123456789:${'x'.repeat(35)}`)).toBe(
    '敏感內容已隱藏。',
  );
  expect(sanitizeLogText('sk-proj-synthetic-test-credential')).toBe(
    '敏感內容已隱藏。',
  );
  await systemLog(env.DB, {
    category: 'storage',
    event: 'R2_UPLOAD_FAILED',
    status: 'failed',
    level: 'error',
    errorCode: 'R2_UPLOAD_FAILED',
    safeMessage:
      'https://api.telegram.org/botTOP_SECRET/sendMessage Authorization: Bearer secret 123456',
  });
  const list = await rpc(
    'systemLogs.list',
    { category: 'storage', query: 'R2_UPLOAD_FAILED', eventStatus: 'failed' },
    { cookie: admin },
  );
  expect(list.status).toBe(200);
  const rows = (list.body as { items: { id: string; safe_message: string }[] })
    .items;
  expect(rows[0].safe_message).toBe('敏感內容已隱藏。');
  expect(JSON.stringify(rows)).not.toContain('TOP_SECRET');
  await rpc(
    'systemLogs.handle',
    { id: rows[0].id, status: 'resolved', note: '已確認測試' },
    { cookie: admin },
  );
  expect(
    await env.DB.prepare(
      'SELECT handled_status,safe_message FROM system_logs WHERE id=?',
    )
      .bind(rows[0].id)
      .first(),
  ).toMatchObject({
    handled_status: 'resolved',
    safe_message: '敏感內容已隱藏。',
  });
});
it('retention deletes only expired system logs and keeps audit and ledger', async () => {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO system_logs(id,timestamp,level,category,event,status,safe_message,correlation_id) VALUES('expired-info',?,'info','system','TEST','success','測試','test')",
  )
    .bind(now - 31 * 86400000)
    .run();
  await cleanupSystemLogs(env.DB, now);
  expect(
    await env.DB.prepare(
      "SELECT id FROM system_logs WHERE id='expired-info'",
    ).first(),
  ).toBeNull();
  expect(
    await env.DB.prepare('SELECT id FROM audit_logs LIMIT 1').first(),
  ).toBeTruthy();
});
it('foreign keys remain valid', async () => {
  expect(
    (await env.DB.prepare('PRAGMA foreign_key_check').all()).results,
  ).toEqual([]);
});
it('manual intake and image recognition APIs are retired', async () => {
  expect(
    (
      await rpc(
        'intake.receive',
        {
          source: 'manual',
          proposedData: {
            code: 'NO-AI',
            customer_name: '虛構人工客戶',
            address: '虛構街',
            amount_due: 100,
          },
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(403);
  expect(
    (await rpc('intake.extractImages', { id: 'archived' }, { cookie: admin }))
      .status,
  ).toBe(403);
});
it('route changes are used by the next outbound job; inactive routes stop delivery', async () => {
  const { collector, c, chat } = await reportSetup();
  const route = (
    await rpc(
      'telegram.saveRoute',
      {
        name: '虛構收單群',
        chatId: String(chat - 20),
        topicId: 3,
        collectorId: collector.id,
        routeType: 'collector_dispatch',
        isActive: true,
      },
      { cookie: admin },
    )
  ).body as { id: string };
  const assignment = await env.DB.prepare(
    'SELECT id FROM assignments WHERE case_id=? AND unassigned_at IS NULL',
  )
    .bind(c.id)
    .first<{ id: string }>();
  const actor = await telegramPrincipal(base, actorId);
  const { queueAssignmentDispatch } = await import(
    '@saasflare-dev/api/assignment-outbound'
  );
  await queueAssignmentDispatch(actor, assignment?.id ?? '');
  expect(
    (
      await rpc(
        'telegram.saveRoute',
        {
          id: route.id,
          name: '虛構新收單群',
          chatId: String(chat - 21),
          topicId: 4,
          collectorId: collector.id,
          routeType: 'collector_dispatch',
          isActive: true,
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  const client = new FakeTelegramClient();
  await processOutbound(base, client, Date.now() + 10000);
  expect(
    client.sent.some(
      (message) =>
        message.chatId === String(chat - 21) && message.topicId === 4,
    ),
  ).toBe(true);
  expect(
    (
      await env.DB.prepare(
        'SELECT status FROM telegram_outbound_jobs WHERE assignment_id=?',
      )
        .bind(assignment?.id)
        .first()
    )?.status,
  ).toBe('sent');
  await env.DB.prepare('UPDATE telegram_routes SET is_active=0 WHERE id=?')
    .bind(route.id)
    .run();
  await processOutbound(base, client, Date.now() + 20000);
  expect(
    client.sent.filter((message) => message.chatId === String(chat - 21)),
  ).toHaveLength(1);
});
it('a collector report route is ineffective immediately after collector deactivation', async () => {
  const { collector, code, chat } = await reportSetup();
  await env.DB.prepare('UPDATE collectors SET is_active=0 WHERE id=?')
    .bind(collector.id)
    .run();
  const update = reportFixture(++sequence, chat, 123, code);
  if (update.message) update.message.message_thread_id = 2;
  await receiveTelegramUpdate(base, update);
  await processTelegramUpdates(
    base,
    new FakeTelegramClient(),
    Date.now() + 10000,
  );
  expect(
    await env.DB.prepare(
      'SELECT result_code,report_id FROM telegram_updates WHERE id=?',
    )
      .bind(String(update.update_id))
      .first(),
  ).toMatchObject({ result_code: 'ROUTE_DENIED', report_id: null });
});
it('explicit bulk/export denies block APIs despite manager role defaults', async () => {
  const email = `blocked-manager-${crypto.randomUUID()}@example.test`;
  await savedUser(email, 'manager', [], ['assignment.bulk', 'finance.export']);
  const cookie = await signIn(email);
  expect(
    (await rpc('cases.bulkAssignmentCollectors', undefined, { cookie })).status,
  ).toBe(403);
  expect(
    (
      await app.fetch(
        new Request('http://localhost/api/finance/settlements.xlsx', {
          headers: { Cookie: cookie },
        }),
      )
    ).status,
  ).toBe(403);
});
it('canonical audit.view grant authorizes the existing audit endpoint', async () => {
  const email = `audit-${crypto.randomUUID()}@example.test`;
  await savedUser(email, 'finance', ['audit.view']);
  const cookie = await signIn(email);
  const record = await env.DB.prepare('SELECT id FROM cases LIMIT 1').first<{
    id: string;
  }>();
  expect(
    (await rpc('cases.audit', { id: record?.id }, { cookie })).status,
  ).toBe(200);
});
it('a former report target cannot be repurposed as active intake', async () => {
  const { route, chat } = await reportSetup();
  await env.DB.prepare('UPDATE telegram_routes SET is_active=0 WHERE id=?')
    .bind(route.id)
    .run();
  expect(
    (
      await rpc(
        'telegram.saveRoute',
        {
          chatId: String(chat),
          topicId: 2,
          routeType: 'intake',
          isActive: true,
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(403);
  const update = photoFixture(++sequence, chat, { topicId: 2 });
  const client = new FakeTelegramClient();
  await receiveTelegramUpdate(base, update);
  await processTelegramUpdates(base, client, Date.now() + 10000);
  expect(client.downloads).toHaveLength(0);
  expect(
    await env.DB.prepare(
      'SELECT intake_id,media_id FROM telegram_updates WHERE id=?',
    )
      .bind(String(update.update_id))
      .first(),
  ).toMatchObject({ intake_id: null, media_id: null });
});
it('settlement selection can be corrected before receipt; stale money request cannot insert ledger', async () => {
  const { route, chat, c, code } = await reportSetup();
  const client = new FakeTelegramClient();
  const update = reportFixture(++sequence, chat, 123, code);
  if (update.message) update.message.message_thread_id = 2;
  await receiveNameReport(update, client);
  const report = await env.DB.prepare(
    'SELECT id,callback_token,assignment_id FROM reports WHERE origin_key=?',
  )
    .bind(`telegram-update:${update.update_id}`)
    .first<{ id: string; callback_token: string; assignment_id: string }>();
  expect(report).toBeTruthy();
  for (const status of ['settled', 'unresolved'] as const) {
    await receiveTelegramUpdate(
      base,
      callbackFixture(
        ++sequence,
        chat,
        123,
        report?.callback_token ?? '',
        status,
        2,
      ),
    );
    await processTelegramUpdates(base, client, Date.now() + 10000);
  }
  expect(
    (
      await env.DB.prepare('SELECT status FROM cases WHERE id=?')
        .bind(c.id)
        .first()
    )?.status,
  ).toBe('unresolved');
  const [storedRoute] = await base.DB.select()
    .from(telegramRoutes)
    .where(eq(telegramRoutes.id, route.id));
  const context = await reportRoutePrincipal(base, storedRoute, update);
  await expect(
    createPayment(
      context,
      {
        caseId: c.id,
        idempotencyKey: report?.id,
        receivedAmount: 15000,
        receivedDate: new Date().toLocaleDateString('en-CA', {
          timeZone: 'Asia/Taipei',
        }),
        installmentScheduleId: null,
      },
      {
        reportId: report?.id ?? '',
        assignmentId: report?.assignment_id ?? '',
        routeId: route.id,
      },
    ),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(
    (
      await env.DB.prepare('SELECT count(*) AS n FROM payments WHERE case_id=?')
        .bind(c.id)
        .first()
    )?.n,
  ).toBe(0);
});
it('concurrent demotion cannot remove the last permission manager', async () => {
  const email = 'second-manager@example.test',
    id = await savedUser(email, 'admin');
  const cookie = await signIn(email);
  const version =
    (
      await env.DB.prepare('SELECT permission_version FROM user WHERE id=?')
        .bind(actorId)
        .first<{ permission_version: number }>()
    )?.permission_version ?? 0;
  const input = (
    targetId: string,
    targetEmail: string,
    expectedVersion: number,
  ) => ({
    id: targetId,
    name: '虛構權限管理者',
    email: targetEmail,
    role: 'user',
    active: true,
    allow: [],
    deny: [],
    expectedVersion,
  });
  const results = await Promise.all([
    rpc('users.save', input(actorId, 'boss@test.dev', version), {
      cookie: admin,
    }),
    rpc('users.save', input(id, email, 0), { cookie }),
  ]);
  expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  expect(
    (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM user WHERE active=1 AND role='admin' AND NOT EXISTS(SELECT 1 FROM json_each(permission_deny) WHERE value='user_permission.manage')",
      ).first()
    )?.n,
  ).toBe(1);
});

// Exercise the new name query + next-message content, retaining finance assertions.
async function receiveNameReport(
  update: ReturnType<typeof reportFixture>,
  client: FakeTelegramClient,
) {
  const m = update.message;
  if (!m) throw new Error('Expected text fixture');
  const name =
    (
      await env.DB.prepare('SELECT customer_name FROM cases WHERE code=?')
        .bind(m.text?.split(' ')[1] ?? '')
        .first<{ customer_name: string }>()
    )?.customer_name ?? '';
  await receiveTelegramUpdate(base, {
    ...update,
    update_id: 100000000 + update.update_id,
    message: { ...m, text: `/回報 ${name}` },
  });
  await processTelegramUpdates(base, client, Date.now() + 10000);
  await receiveTelegramUpdate(base, {
    ...update,
    message: { ...m, text: '虛構回報：已到訪' },
  });
  await processTelegramUpdates(base, client, Date.now() + 10000);
}
