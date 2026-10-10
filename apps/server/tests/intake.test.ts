import { env } from 'cloudflare:workers';
import type { Context } from '@saasflare-dev/api/context';
import {
  extractionOutputSchema,
  validatedExtraction,
} from '@saasflare-dev/api/intake-contract';
import { receiveIntake } from '@saasflare-dev/api/intake-service';
import { imageExtractionProvider } from '@saasflare-dev/api/openai-image-extraction';
import { FakeTelegramClient } from '@saasflare-dev/api/telegram-client';
import { photoFixture } from '@saasflare-dev/api/telegram-fixtures';
import { telegramPrincipal } from '@saasflare-dev/api/telegram-principal';
import {
  receiveTelegramUpdate,
  runTelegramProcessing,
} from '@saasflare-dev/api/telegram-processing';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, expect, it } from 'vitest';
import app from '../src/index';
import { adminCookie, H, rpc, userCookie } from './helpers';

let admin: string, ordinary: string, context: Context, archivedId: string;
const fields = {
  code: 'ARCHIVED-ONLY',
  customer_name: '虛構封存戶',
  address: '虛構封存地址',
  amount_due: 5000,
};
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
      session: null,
      user: null,
      isAdmin: false,
    },
    actor?.id ?? '',
  );
  // Explicit archived fixture: the formal API cannot create this data.
  archivedId = (
    await receiveIntake(context, { source: 'manual', proposedData: fields })
  ).id;
});
it.each([
  'manual',
  'telegram',
  'line',
  'poster_builder',
  'historical_import',
  'api',
])('rejects formal %s intake without writing any intake or case', async (source) => {
  const externalId = crypto.randomUUID();
  const result = await rpc(
    'intake.receive',
    { source, externalId, proposedData: fields },
    { cookie: admin },
  );
  expect(result.status).toBe(403);
  expect(JSON.stringify(result.body)).toContain('INTAKE_DISABLED');
  expect(
    await env.DB.prepare('SELECT id FROM intake_items WHERE external_id=?')
      .bind(externalId)
      .first(),
  ).toBeNull();
});
it('keeps authenticated archival reads while rejecting process, resolve, promote and extraction', async () => {
  const detail = await rpc(
    'intake.detail',
    { id: archivedId },
    { cookie: admin },
  );
  expect(detail.status).toBe(200);
  const original = JSON.stringify(detail.body);
  for (const [path, input] of [
    ['intake.process', { id: archivedId, expectedVersion: 0 }],
    [
      'intake.resolve',
      { id: archivedId, expectedVersion: 0, action: 'create' },
    ],
    ['intake.promote', { id: archivedId }],
    ['intake.extractImages', { id: archivedId }],
  ] as const)
    expect((await rpc(path, input, { cookie: admin })).status).toBe(403);
  expect(
    JSON.stringify(
      (await rpc('intake.detail', { id: archivedId }, { cookie: admin })).body,
    ),
  ).toBe(original);
  expect(
    (await rpc('intake.detail', { id: archivedId }, { cookie: null })).status,
  ).toBe(401);
  expect(
    (
      await rpc(
        'intake.resolve',
        { id: archivedId, expectedVersion: 0, action: 'create' },
        { cookie: ordinary },
      )
    ).status,
  ).toBe(403);
});
it('rejects new archive media before storage or database writes', async () => {
  const form = new FormData();
  form.append('expectedVersion', '0');
  form.append(
    'images',
    new File([new Uint8Array([1])], 'fictional.png', { type: 'image/png' }),
  );
  const response = await app.fetch(
    new Request(`http://localhost/api/intake/${archivedId}/media`, {
      method: 'POST',
      headers: { ...H, Cookie: admin },
      body: form,
    }),
  );
  expect(response.status).toBe(403);
  expect(
    await env.DB.prepare('SELECT id FROM intake_media WHERE intake_id=?')
      .bind(archivedId)
      .first(),
  ).toBeNull();
});
it('legacy intake route images/album and retries create no intake, case, download or AI usage', async () => {
  const id = crypto.randomUUID(),
    time = Date.now(),
    chat = -998877665;
  // Simulate a retained pre-retirement route rather than creating one through the formal API.
  await env.DB.prepare(
    "INSERT INTO telegram_routes(id,chat_id,topic_id,route_type,is_active,managed_by_user_id,created_at,updated_at) VALUES(?, ?,2,'intake',1,?,?,?)",
  )
    .bind(id, String(chat), context.user?.id, time, time)
    .run();
  const before = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM cases) AS cases,(SELECT COUNT(*) FROM intake_items) AS intake,(SELECT COUNT(*) FROM ai_usage_logs) AS ai',
  ).first();
  const client = new FakeTelegramClient();
  for (let index = 0; index < 3; index++) {
    const update = photoFixture(881200 + index, chat, {
      topicId: 2,
      album: 'retired-album',
    });
    await receiveTelegramUpdate(context, update);
    await receiveTelegramUpdate(context, update);
    expect(
      await env.DB.prepare(
        'SELECT result_code,payload,intake_id FROM telegram_updates WHERE id=?',
      )
        .bind(String(update.update_id))
        .first(),
    ).toMatchObject({
      result_code: 'TELEGRAM_INTAKE_DISABLED',
      payload: '{}',
      intake_id: null,
    });
  }
  await runTelegramProcessing(context, client, time + 10000);
  expect(
    await env.DB.prepare(
      'SELECT (SELECT COUNT(*) FROM cases) AS cases,(SELECT COUNT(*) FROM intake_items) AS intake,(SELECT COUNT(*) FROM ai_usage_logs) AS ai',
    ).first(),
  ).toEqual(before);
  expect(client.downloads).toHaveLength(0);
  expect(
    imageExtractionProvider({ ...env, IMAGE_EXTRACTION_MODE: 'openai' }),
  ).toBeNull();
  expect(
    (
      await rpc(
        'telegram.saveRoute',
        { chatId: String(chat - 1), routeType: 'intake', isActive: true },
        { cookie: admin },
      )
    ).status,
  ).toBe(403);
  expect(
    (await rpc('telegram.testRoute', { id }, { cookie: admin })).status,
  ).toBe(403);
  expect(
    (
      await rpc(
        'telegram.saveRoute',
        {
          id,
          chatId: String(chat),
          topicId: 2,
          routeType: 'intake',
          isActive: false,
        },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
});
it('preserves strict archived extraction schemas without enabling an ingestion runtime', async () => {
  expect(
    extractionOutputSchema.safeParse({
      ...fields,
      confidence: 0.9,
      arbitrarySql: 'invalid',
    }).success,
  ).toBe(false);
  await expect(
    validatedExtraction(
      { extract: async () => ({ ...fields, confidence: 3 }) },
      { mediaId: 'archived' },
    ),
  ).rejects.toThrow();
  expect(
    extractionOutputSchema.parse({ ...fields, confidence: 0.9 }).confidence,
  ).toBe(0.9);
});
it('applies the new priority index on clean migration schema and preserves foreign keys', async () => {
  const plan = await env.DB.prepare(
    "EXPLAIN QUERY PLAN SELECT due_date FROM installment_schedules WHERE plan_id=? AND status IN ('pending','partial','overdue') AND paid_amount<expected_amount ORDER BY due_date,sequence",
  )
    .bind('fixture')
    .all<{ detail: string }>();
  expect(
    plan.results.some((r) => r.detail.includes('schedule_unpaid_plan_due_idx')),
  ).toBe(true);
  expect(
    (await env.DB.prepare('PRAGMA foreign_key_check').all()).results,
  ).toEqual([]);
});
