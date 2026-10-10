import { env } from 'cloudflare:workers';
import type { Context } from '@saasflare-dev/api/context';
import { botClientForRoute } from '@saasflare-dev/api/telegram-bots';
import { FakeTelegramClient } from '@saasflare-dev/api/telegram-client';
import { processOutbound } from '@saasflare-dev/api/telegram-outbound';
import { runTelegramProcessing } from '@saasflare-dev/api/telegram-processing';
import {
  decryptBotToken,
  encryptBotToken,
} from '@saasflare-dev/api/telegram-token-crypto';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminCookie, rpc, signIn } from './helpers';

const master = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));
const token = (label = 'valid') => `${777777}:${label.padEnd(40, 'x')}`;
describe('encrypted Telegram bot management', () => {
  let cookie: string, id: string;
  beforeAll(async () => {
    Object.assign(env, { TELEGRAM_TOKEN_ENCRYPTION_KEY: master });
    cookie = await adminCookie();
  });
  it('encrypts using random nonces, authenticated record identity and rejects tampering', async () => {
    const a = await encryptBotToken(token(), 'a', master),
      b = await encryptBotToken(token(), 'a', master);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.ciphertext).not.toContain(token());
    expect(await decryptBotToken({ id: 'a', ...a }, master)).toBe(token());
    await expect(
      decryptBotToken({ id: 'b', ...a }, master),
    ).rejects.toBeDefined();
    await expect(encryptBotToken(token(), 'a', '')).rejects.toBeDefined();
  });
  it('binds validated metadata, returns no credentials and keeps logs safe', async () => {
    const result = await rpc(
      'telegram.bots.bind',
      { token: token(), internalName: '虛構機器人' },
      { cookie },
    );
    expect(result.status).toBe(200);
    id = (result.body as { id: string }).id;
    const row = await env.DB.prepare('SELECT * FROM telegram_bots WHERE id=?')
      .bind(id)
      .first<Record<string, unknown>>();
    expect(row?.telegram_bot_id).toBe('777777');
    expect(row?.username).toBe('fictional_test_bot');
    expect(row?.ciphertext).not.toBe(token());
    const list = await rpc('telegram.bots.list', undefined, { cookie });
    const output = JSON.stringify(list.body);
    expect(output).not.toContain(token());
    expect(output).not.toContain('ciphertext');
    expect(output).not.toContain('nonce');
    const logs = await env.DB.prepare(
      'SELECT metadata FROM audit_logs WHERE entity_id=?',
    )
      .bind(id)
      .all();
    expect(JSON.stringify(logs.results)).not.toContain(token());
    expect(JSON.stringify(logs.results)).not.toContain(row?.ciphertext);
  });
  it('rejects invalid tokens without storing a record', async () => {
    expect(
      (await rpc('telegram.bots.bind', { token: token('invalid') }, { cookie }))
        .status,
    ).toBe(400);
  });
  it('denies ordinary users and route managers access to token APIs', async () => {
    const ordinary = await signIn('bot-ordinary@test.dev');
    const routeManager = await signIn('route-manager@test.dev');
    await env.DB.prepare('UPDATE user SET permission_allow=? WHERE email=?')
      .bind(JSON.stringify(['telegram_route.manage']), 'route-manager@test.dev')
      .run();
    for (const c of [ordinary, routeManager]) {
      expect(
        (await rpc('telegram.bots.list', undefined, { cookie: c })).status,
      ).toBe(403);
      expect(
        (await rpc('telegram.bots.bind', { token: token() }, { cookie: c }))
          .status,
      ).toBe(403);
    }
  });
  it('rotates only the same Bot and preserves encrypted credentials on mismatch', async () => {
    expect(
      (
        await rpc(
          'telegram.bots.rotate',
          { id, token: token('rotation'), expectedVersion: 0 },
          { cookie },
        )
      ).status,
    ).toBe(200);
    const before = await env.DB.prepare(
      'SELECT ciphertext FROM telegram_bots WHERE id=?',
    )
      .bind(id)
      .first();
    expect(
      (
        await rpc(
          'telegram.bots.rotate',
          { id, token: token('different'), expectedVersion: 1 },
          { cookie },
        )
      ).status,
    ).toBe(409);
    expect(
      await env.DB.prepare('SELECT ciphertext FROM telegram_bots WHERE id=?')
        .bind(id)
        .first(),
    ).toEqual(before);
  });
  it('binds route, warns on disabling with active routes and prevents new outbound', async () => {
    const route = await rpc(
      'telegram.saveRoute',
      {
        botId: id,
        chatId: '-1001234567890',
        topicId: 2,
        routeType: 'business_report',
        name: '虛構路由',
        isActive: true,
      },
      { cookie },
    );
    expect(route.status).toBe(200);
    expect(
      (
        await rpc(
          'telegram.bots.update',
          { id, internalName: '虛構', isActive: false, expectedVersion: 1 },
          { cookie },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await rpc(
          'telegram.bots.update',
          {
            id,
            internalName: '虛構',
            isActive: false,
            expectedVersion: 1,
            confirmDisable: true,
          },
          { cookie },
        )
      ).status,
    ).toBe(200);
    await expect(
      env.DB.prepare(
        "INSERT INTO telegram_outbound_jobs(id,dedupe_key,message_type,route_id,payload,status,attempts,created_at) VALUES(?,?,'command_reply',?,'{}','pending',0,?)",
      )
        .bind(
          crypto.randomUUID(),
          crypto.randomUUID(),
          (route.body as { id: string }).id,
          Date.now(),
        )
        .run(),
    ).rejects.toThrow();
    expect(
      (
        await rpc(
          'telegram.testRoute',
          { id: (route.body as { id: string }).id },
          { cookie },
        )
      ).body,
    ).toMatchObject({ success: false, code: 'BOT_DISABLED' });
    expect(
      (
        await rpc(
          'telegram.saveRoute',
          { botId: id, chatId: '-1001234567891', routeType: 'business_report' },
          { cookie },
        )
      ).status,
    ).toBe(400);
  });
  it('retains legacy route clients and refuses disabled Bot delivery', async () => {
    const legacy = new FakeTelegramClient();
    const context = { env, DB: drizzle(env.DB) } as Context;
    expect(await botClientForRoute(context, null, legacy)).toBe(legacy);
    await expect(botClientForRoute(context, id, legacy)).rejects.toMatchObject({
      code: 'BOT_DISABLED',
    });
  });
  it('logs BOT_DISABLED, preserves assignments, continues other jobs and allows new delivery after enable or rebind', async () => {
    const base = {
      env,
      DB: drizzle(env.DB),
      headers: new Headers(),
      user: null,
      session: null,
      isAdmin: false,
      correlationId: crypto.randomUUID(),
    } as Context;
    const version = async () =>
      Number(
        (
          await env.DB.prepare('SELECT version FROM telegram_bots WHERE id=?')
            .bind(id)
            .first<{ version: number }>()
        )?.version,
      );
    const toggle = async (active: boolean) => {
      expect(
        (
          await rpc(
            'telegram.bots.update',
            {
              id,
              internalName: '虛構',
              isActive: active,
              expectedVersion: await version(),
              confirmDisable: true,
            },
            { cookie },
          )
        ).status,
      ).toBe(200);
    };
    const collector = async () => {
      const r = await rpc(
        'collectors.create',
        {
          displayName: '虛構外收',
          code: crypto.randomUUID(),
          userId: null,
          isActive: true,
        },
        { cookie },
      );
      expect(r.status).toBe(200);
      return (r.body as { id: string }).id;
    };
    const create = async () => {
      const r = await rpc(
        'cases.create',
        {
          code: crypto.randomUUID(),
          customerName: '虛構停用測試',
          address: '虛構',
          amountDue: 1000,
          status: 'pending',
          source: 'manual',
          revisitStatus: 'pending',
          revisitReason: '',
        },
        { cookie },
      );
      expect(r.status).toBe(200);
      return (r.body as { id: string }).id;
    };
    const assign = async (caseId: string, collectorId: string) =>
      rpc(
        'cases.assign',
        { caseId, collectorId, expectedVersion: 0, note: null },
        { cookie },
      );
    await toggle(true);
    const c1 = await collector(),
      c2 = await collector();
    const r1 = await rpc(
      'telegram.saveRoute',
      {
        botId: id,
        collectorId: c1,
        chatId: '-1002234567890',
        topicId: 2,
        routeType: 'collector_dispatch',
        name: '虛構 Bot 派件',
      },
      { cookie },
    );
    expect(r1.status).toBe(200);
    expect(
      (
        await rpc(
          'telegram.saveRoute',
          {
            collectorId: c2,
            chatId: '-1002234567891',
            topicId: 2,
            routeType: 'collector_dispatch',
          },
          { cookie },
        )
      ).status,
    ).toBe(200);
    const first = await create(),
      other = await create();
    expect((await assign(first, c1)).status).toBe(200);
    expect((await assign(other, c2)).status).toBe(200);
    const job = await env.DB.prepare(
      'SELECT j.id FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id=?',
    )
      .bind(first)
      .first<{ id: string }>();
    await toggle(false);
    const fake = new FakeTelegramClient();
    await processOutbound(base, fake, Date.now() + 1000);
    const blocked = await env.DB.prepare(
      'SELECT status,last_error_code,next_attempt_at FROM telegram_outbound_jobs WHERE id=?',
    )
      .bind(job?.id)
      .first();
    expect(blocked).toMatchObject({
      status: 'failed',
      last_error_code: 'BOT_DISABLED',
      next_attempt_at: null,
    });
    expect(fake.sent).toHaveLength(1);
    expect(
      await env.DB.prepare(
        'SELECT id FROM assignments WHERE case_id=? AND unassigned_at IS NULL',
      )
        .bind(first)
        .first(),
    ).toBeTruthy();
    expect(
      await env.DB.prepare(
        "SELECT id FROM system_logs WHERE event='BOT_DISABLED' AND error_code='BOT_DISABLED' AND related_job_id=? AND related_case_id=?",
      )
        .bind(job?.id, first)
        .first(),
    ).toBeTruthy();
    const noJob = await create(),
      single = await assign(noJob, c1);
    expect(single.status).toBe(200);
    expect(single.body).toMatchObject({ telegramWarning: 'BOT_DISABLED' });
    const bulkCase = await create(),
      bulk = await rpc(
        'cases.bulkAssign',
        { batchId: crypto.randomUUID(), caseIds: [bulkCase], collectorId: c1 },
        { cookie },
      );
    expect(bulk.status).toBe(200);
    expect(bulk.body).toMatchObject({
      summary: { assigned: 1, telegramBlocked: 1 },
    });
    expect(
      await env.DB.prepare(
        'SELECT id FROM assignments WHERE case_id=? AND unassigned_at IS NULL',
      )
        .bind(bulkCase)
        .first(),
    ).toBeTruthy();
    await runTelegramProcessing(base, fake, Date.now() + 2000);
    expect(fake.sent).toHaveLength(1);
    await toggle(true);
    const enabled = await create();
    expect((await assign(enabled, c1)).status).toBe(200);
    await processOutbound(base, fake, Date.now() + 3000);
    expect(
      await env.DB.prepare(
        "SELECT j.id FROM telegram_outbound_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.case_id=? AND j.status='sent'",
      )
        .bind(enabled)
        .first(),
    ).toBeTruthy();
    // Original failed job stays failed: enabling never blindly re-sends it.
    expect(
      await env.DB.prepare(
        'SELECT status FROM telegram_outbound_jobs WHERE id=?',
      )
        .bind(job?.id)
        .first(),
    ).toMatchObject({ status: 'failed' });
    await toggle(false);
    expect(
      (
        await rpc(
          'telegram.saveRoute',
          {
            id: (r1.body as { id: string }).id,
            botId: null,
            collectorId: c1,
            chatId: '-1002234567890',
            topicId: 2,
            routeType: 'collector_dispatch',
          },
          { cookie },
        )
      ).status,
    ).toBe(200);
    const rebound = await create();
    expect((await assign(rebound, c1)).status).toBe(200);
    await processOutbound(base, fake, Date.now() + 4000);
    expect(fake.sent.length).toBeGreaterThan(1);
  });
});
