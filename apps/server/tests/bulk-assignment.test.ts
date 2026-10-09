import { env } from 'cloudflare:workers';
import type { Context } from '@saasflare-dev/api/context';
import { FakeTelegramClient } from '@saasflare-dev/api/telegram-client';
import { processOutbound } from '@saasflare-dev/api/telegram-outbound';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminCookie, rpc, signIn, userCookie } from './helpers';

let admin: string;
let ordinary: string;
let collectorId: string;
let routeId: string;
let chatId: string;
const base: Context = {
  env,
  DB: drizzle(env.DB),
  headers: new Headers(),
  session: null,
  user: null,
  isAdmin: false,
};
type Outcome = {
  batchId: string;
  summary: {
    assigned: number;
    skipped: number;
    failed: number;
    telegramRetrying: number;
    telegramSent: number;
    telegramFailed: number;
  };
  items: {
    caseId: string;
    assignmentId: string | null;
    outboundJobId: string | null;
    reason: string | null;
    status: string;
  }[];
};
async function createCase(region = '桃園市') {
  const code = `BULK-${crypto.randomUUID()}`;
  const r = await rpc(
    'cases.create',
    {
      code,
      customerName: `Fictional ${code}`,
      address: 'Fictional address',
      amountDue: 1000,
      status: 'pending',
      source: 'manual',
      revisitStatus: 'pending',
      revisitReason: '',
      region,
    },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  return r.body as { id: string; caseNo: string };
}
async function collector(active = true) {
  const c = await rpc(
    'collectors.create',
    {
      displayName: 'Fictional bulk collector',
      code: crypto.randomUUID(),
      userId: null,
      isActive: active,
    },
    { cookie: admin },
  );
  expect(c.status).toBe(200);
  return (c.body as { id: string }).id;
}
async function bulk(
  caseIds: string[],
  batchId: string = crypto.randomUUID(),
  id = collectorId,
) {
  return rpc(
    'cases.bulkAssign',
    { caseIds, batchId, collectorId: id },
    { cookie: admin },
  );
}
async function result(batchId: string) {
  const r = await rpc(
    'cases.bulkAssignmentResult',
    { batchId },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  return r.body as Outcome;
}
async function count(table: string, caseId: string) {
  return (
    await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE case_id=?`)
      .bind(caseId)
      .first<{ n: number }>()
  )?.n;
}
beforeAll(async () => {
  admin = await adminCookie();
  ordinary = await userCookie();
  collectorId = await collector();
  chatId = '-1008888101';
  const r = await rpc(
    'telegram.saveRoute',
    {
      collectorId,
      chatId,
      topicId: 48,
      routeType: 'collector',
      isActive: true,
    },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  routeId = (r.body as { id: string }).id;
});
describe('Bulk assignment transactions and individual Telegram delivery', () => {
  it('composes region and unassigned filters, creates one assignment/job per case and audits each case plus batch', async () => {
    const a = await createCase(),
      b = await createCase(),
      outside = await createCase('台北市');
    const filtered = await rpc(
      'cases.list',
      { region: '桃園市', assignmentStatus: 'unassigned', pageSize: 50 },
      { cookie: admin },
    );
    const ids = (filtered.body as { items: { id: string }[] }).items.map(
      (i) => i.id,
    );
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(outside.id);
    const r = await bulk([a.id, b.id]);
    expect(r.status).toBe(200);
    const output = r.body as Outcome;
    expect(output.summary.assigned).toBe(2);
    expect(new Set(output.items.map((i) => i.assignmentId)).size).toBe(2);
    expect(new Set(output.items.map((i) => i.outboundJobId)).size).toBe(2);
    for (const c of [a, b]) {
      expect(await count('assignments', c.id)).toBe(1);
      const job = await env.DB.prepare(
        'SELECT j.* FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id=?',
      )
        .bind(c.id)
        .first<{ payload: string; message_type: string; dedupe_key: string }>();
      expect(job?.message_type).toBe('assignment_dispatch');
      expect(JSON.parse(job?.payload ?? '{}')).toMatchObject({
        chatId,
        topicId: 48,
      });
      expect(JSON.parse(job?.payload ?? '{}').text).toContain(c.caseNo);
      expect(JSON.parse(job?.payload ?? '{}').text).not.toContain(
        c.id === a.id ? b.caseNo : a.caseNo,
      );
      const audit = await env.DB.prepare(
        "SELECT metadata FROM audit_logs WHERE entity_id=? AND action='assignment.created'",
      )
        .bind(c.id)
        .first<{ metadata: string }>();
      expect(JSON.parse(audit?.metadata ?? '{}')).toMatchObject({
        bulkAssignmentId: output.batchId,
        collectorId,
      });
    }
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM audit_logs WHERE entity_id=? AND action='bulk_assignment_created'",
        )
          .bind(output.batchId)
          .first()
      )?.n,
    ).toBe(1);
    const after = await rpc(
      'cases.list',
      { region: '桃園市', assignmentStatus: 'unassigned', pageSize: 50 },
      { cookie: admin },
    );
    expect(
      (after.body as { items: { id: string }[] }).items.some(
        (i) => i.id === a.id || i.id === b.id,
      ),
    ).toBe(false);
  });
  it('skips a case assigned since selection and an unknown case without blocking other cases or overwriting history', async () => {
    const a = await createCase(),
      b = await createCase();
    const assigned = await rpc(
      'cases.assign',
      {
        caseId: a.id,
        collectorId,
        expectedVersion: 0,
        note: 'Another administrator assigned this first',
      },
      { cookie: admin },
    );
    expect(assigned.status).toBe(200);
    const r = await bulk([a.id, b.id, crypto.randomUUID()]);
    expect(r.status).toBe(200);
    const output = r.body as Outcome;
    expect(output.summary).toMatchObject({ assigned: 1, skipped: 2 });
    expect(output.items.find((i) => i.caseId === a.id)?.reason).toBe(
      'ALREADY_ASSIGNED',
    );
    expect(await count('assignments', a.id)).toBe(1);
    expect(
      await env.DB.prepare(
        'SELECT note,unassigned_at FROM assignments WHERE case_id=?',
      )
        .bind(a.id)
        .first(),
    ).toMatchObject({
      note: 'Another administrator assigned this first',
      unassigned_at: null,
    });
  });
  it('concurrent batches cannot assign the same case twice and unrelated cases still succeed', async () => {
    const shared = await createCase(),
      a = await createCase(),
      b = await createCase();
    const results = await Promise.all([
      bulk([shared.id, a.id]),
      bulk([shared.id, b.id]),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(
      results.reduce((n, r) => n + (r.body as Outcome).summary.assigned, 0),
    ).toBe(3);
    expect(await count('assignments', shared.id)).toBe(1);
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id=?',
        )
          .bind(shared.id)
          .first()
      )?.n,
    ).toBe(1);
  });
  it('concurrent and reordered request retries reuse batch, assignments, jobs and audit', async () => {
    const a = await createCase(),
      b = await createCase(),
      batchId = crypto.randomUUID();
    const results = await Promise.all([
      bulk([a.id, b.id], batchId),
      bulk([b.id, a.id], batchId),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect((await result(batchId)).summary.assigned).toBe(2);
    expect(await count('assignments', a.id)).toBe(1);
    const replay = await bulk([a.id, b.id], batchId);
    expect((replay.body as Outcome).summary.assigned).toBe(2);
    expect((await bulk([a.id], batchId)).status).toBe(409);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM audit_logs WHERE entity_id=? AND action='bulk_assignment_created'",
        )
          .bind(batchId)
          .first()
      )?.n,
    ).toBe(1);
  });
  it('rejects inactive collectors, missing/inactive routes and multiple active routes without assignments', async () => {
    const c = await createCase(),
      inactive = await collector(false),
      missing = await collector();
    expect((await bulk([c.id], crypto.randomUUID(), inactive)).status).toBe(
      400,
    );
    expect((await bulk([c.id], crypto.randomUUID(), missing)).status).toBe(400);
    await rpc(
      'telegram.saveRoute',
      {
        collectorId: missing,
        chatId: '-1008888111',
        routeType: 'collector',
        isActive: false,
      },
      { cookie: admin },
    );
    expect((await bulk([c.id], crypto.randomUUID(), missing)).status).toBe(400);
    let activeId = '';
    for (const chat of ['-1008888112', '-1008888113']) {
      const result = await rpc(
        'telegram.saveRoute',
        {
          collectorId: missing,
          chatId: chat,
          routeType: 'collector',
          isActive: true,
        },
        { cookie: admin },
      );
      expect(result.status).toBe(activeId ? 409 : 200);
      if (result.status === 200) activeId = (result.body as { id: string }).id;
    }
    await env.DB.prepare('UPDATE telegram_routes SET is_active=0 WHERE id=?')
      .bind(activeId)
      .run();
    expect((await bulk([c.id], crypto.randomUUID(), missing)).status).toBe(400);
    expect(await count('assignments', c.id)).toBe(0);
  });
  it('denies ordinary/anonymous users, result access by another manager, and strict invalid requests', async () => {
    const c = await createCase(),
      input = { caseIds: [c.id], batchId: crypto.randomUUID(), collectorId };
    expect(
      (await rpc('cases.bulkAssign', input, { cookie: ordinary })).status,
    ).toBe(403);
    expect(
      (await rpc('cases.bulkAssign', input, { cookie: null })).status,
    ).toBe(401);
    expect(
      (
        await rpc('cases.bulkAssignmentCollectors', undefined, {
          cookie: ordinary,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await rpc(
          'cases.bulkAssign',
          { ...input, caseIds: [c.id, c.id] },
          { cookie: admin },
        )
      ).status,
    ).toBe(400);
    expect(
      (await rpc('cases.bulkAssign', { ...input, chatId }, { cookie: admin }))
        .status,
    ).toBe(400);
    expect((await bulk([], input.batchId)).status).toBe(400);
    await bulk([c.id], input.batchId);
    expect(
      (
        await rpc(
          'cases.bulkAssignmentResult',
          { batchId: input.batchId },
          { cookie: ordinary },
        )
      ).status,
    ).toBe(403);
    await signIn('bulk-manager@example.test');
    await env.DB.prepare(
      "UPDATE user SET role='manager' WHERE email='bulk-manager@example.test'",
    ).run();
    const manager = await signIn('bulk-manager@example.test');
    expect(
      (
        await rpc(
          'cases.bulkAssignmentResult',
          { batchId: input.batchId },
          { cookie: manager },
        )
      ).status,
    ).toBe(404);
    expect(
      (await rpc('cases.bulkAssign', input, { cookie: manager })).status,
    ).toBe(409);
  });
  it('Telegram explicit failure preserves assignments, retries only the failed job and never duplicates assignments', async () => {
    await processOutbound(base, new FakeTelegramClient(), Date.now() + 10000);
    const a = await createCase(),
      b = await createCase();
    const output = (await bulk([a.id, b.id])).body as Outcome;
    const client = new FakeTelegramClient();
    client.sendFailures = 1;
    await processOutbound(base, client, Date.now() + 10000);
    const pending = await result(output.batchId);
    expect(pending.summary).toMatchObject({
      assigned: 2,
      telegramRetrying: 1,
      telegramSent: 1,
    });
    await processOutbound(base, client, Date.now() + 30000);
    expect((await result(output.batchId)).summary).toMatchObject({
      assigned: 2,
      telegramRetrying: 0,
      telegramSent: 2,
    });
    expect(client.sent).toHaveLength(2);
    await bulk([a.id, b.id], output.batchId);
    await processOutbound(base, client, Date.now() + 60000);
    expect(client.sent).toHaveLength(2);
    expect(await count('assignments', a.id)).toBe(1);
    expect(await count('assignments', b.id)).toBe(1);
  });
  it('never sends queued dispatch after route is disabled or assignment replaced', async () => {
    const a = await createCase();
    const output = (await bulk([a.id])).body as Outcome;
    await env.DB.prepare('UPDATE telegram_routes SET is_active=0 WHERE id=?')
      .bind(routeId)
      .run();
    const client = new FakeTelegramClient();
    await processOutbound(base, client, Date.now() + 10000);
    expect((await result(output.batchId)).summary).toMatchObject({
      assigned: 1,
      telegramFailed: 1,
    });
    expect(client.sent).toHaveLength(0);
    await env.DB.prepare('UPDATE telegram_routes SET is_active=1 WHERE id=?')
      .bind(routeId)
      .run();
    const b = await createCase();
    const second = (await bulk([b.id])).body as Outcome;
    const detail = await rpc('cases.detail', { id: b.id }, { cookie: admin });
    await rpc(
      'cases.assign',
      {
        caseId: b.id,
        collectorId: null,
        expectedVersion: (detail.body as { version: number }).version,
        note: null,
      },
      { cookie: admin },
    );
    await processOutbound(base, client, Date.now() + 20000);
    expect((await result(second.batchId)).summary.telegramFailed).toBe(1);
    expect(client.sent).toHaveLength(0);
  });
  it('a failing outbound insert rolls back only that case; others complete and failed item is traceable', async () => {
    const a = await createCase(),
      b = await createCase();
    await env.DB.exec(
      `CREATE TRIGGER bulk_test_fail BEFORE INSERT ON telegram_outbound_jobs WHEN EXISTS(SELECT 1 FROM assignments WHERE id=NEW.assignment_id AND case_id='${a.id}') BEGIN SELECT RAISE(ABORT,'test failure'); END;`,
    );
    try {
      const output = (await bulk([a.id, b.id])).body as Outcome;
      expect(output.summary).toMatchObject({ assigned: 1, failed: 1 });
      expect(await count('assignments', a.id)).toBe(0);
      expect(await count('assignments', b.id)).toBe(1);
      expect(
        (
          await env.DB.prepare('SELECT version FROM cases WHERE id=?')
            .bind(a.id)
            .first()
        )?.version,
      ).toBe(0);
      expect(output.items.find((i) => i.caseId === a.id)?.reason).toBe(
        'SAVE_FAILED',
      );
    } finally {
      await env.DB.exec('DROP TRIGGER bulk_test_fail;');
    }
    expect(
      (await env.DB.prepare('PRAGMA foreign_key_check').all()).results,
    ).toEqual([]);
  });
  it('resumed pending batches revalidate a collector deactivated after selection', async () => {
    const c = await createCase(),
      batchId = crypto.randomUUID();
    const actor = await env.DB.prepare(
      "SELECT id FROM user WHERE email='boss@test.dev'",
    ).first<{ id: string }>();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO bulk_assignments(id,created_by_user_id,collector_id,route_id,request,created_at) VALUES(?,?,?,?,?,?)',
      ).bind(
        batchId,
        actor?.id,
        collectorId,
        routeId,
        JSON.stringify({ collectorId, caseIds: [c.id] }),
        Date.now(),
      ),
      env.DB.prepare(
        "INSERT INTO bulk_assignment_items(id,bulk_assignment_id,requested_case_id,status,updated_at) VALUES(?,?,?,'pending',?)",
      ).bind(`${batchId}:000`, batchId, c.id, Date.now()),
      env.DB.prepare('UPDATE collectors SET is_active=0 WHERE id=?').bind(
        collectorId,
      ),
    ]);
    try {
      const r = await bulk([c.id], batchId);
      expect(r.status).toBe(200);
      expect((r.body as Outcome).summary).toMatchObject({
        assigned: 0,
        skipped: 1,
      });
      expect(await count('assignments', c.id)).toBe(0);
    } finally {
      await env.DB.prepare('UPDATE collectors SET is_active=1 WHERE id=?')
        .bind(collectorId)
        .run();
    }
  });
  it('uncertain Telegram delivery retains assignment and is never blindly resent', async () => {
    await processOutbound(base, new FakeTelegramClient(), Date.now() + 10000);
    const c = await createCase(),
      output = (await bulk([c.id])).body as Outcome;
    const client = new FakeTelegramClient();
    client.uncertainSend = true;
    await processOutbound(base, client, Date.now() + 10000);
    expect((await result(output.batchId)).summary).toMatchObject({
      assigned: 1,
      telegramFailed: 1,
    });
    expect(client.sent).toHaveLength(1);
    await processOutbound(base, client, Date.now() + 20000);
    expect(client.sent).toHaveLength(1);
    expect(await count('assignments', c.id)).toBe(1);
  });
});
