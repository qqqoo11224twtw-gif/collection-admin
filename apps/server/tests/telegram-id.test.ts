import { env } from 'cloudflare:workers';
import type { Context } from '@saasflare-dev/api/context';
import { FakeTelegramClient } from '@saasflare-dev/api/telegram-client';
import { handleTelegramId } from '@saasflare-dev/api/telegram-id-command';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';
import app from '../src/index';

const context = {
  env,
  DB: drizzle(env.DB),
  user: null,
  session: null,
  isAdmin: false,
  headers: new Headers(),
} as Context;
async function counts() {
  const rows = await env.DB.prepare(
    'SELECT (SELECT count(*) FROM cases) AS cases,(SELECT count(*) FROM intake_items) AS intake,(SELECT count(*) FROM reports) AS reports,(SELECT count(*) FROM telegram_outbound_jobs) AS outbound',
  ).first();
  return rows;
}
describe('Telegram /id management helper', () => {
  for (const [type, topic] of [
    ['group', undefined],
    ['supergroup', undefined],
    ['supergroup', 12],
  ] as const)
    it(`${type} ${topic ?? 'no topic'}`, async () => {
      const before = await counts();
      const client = Object.assign(new FakeTelegramClient(), {
        isChatAdmin: async () => true,
      });
      const update = {
        update_id: Math.floor(Math.random() * 1000000000),
        message: {
          message_id: 1,
          date: 1,
          chat: { id: -1001234567890, type },
          from: { id: 123 },
          text: '/id',
          message_thread_id: topic,
        },
      };
      await handleTelegramId(context, update, client);
      expect(client.sent).toHaveLength(1);
      expect(client.sent[0].text).toBe(
        `Chat ID: -1001234567890\nTopic ID: ${topic ?? '無'}`,
      );
      expect(client.sent[0].topicId).toBe(topic ?? null);
      expect(await counts()).toEqual(before);
      expect(await handleTelegramId(context, update, client)).toMatchObject({
        duplicate: true,
      });
      expect(client.sent).toHaveLength(1);
    });
  it('denies non-admin and never enters business processing', async () => {
    const before = await counts();
    const client = Object.assign(new FakeTelegramClient(), {
      isChatAdmin: async () => false,
    });
    await handleTelegramId(
      context,
      {
        update_id: 1900000001,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: -123, type: 'group' },
          from: { id: 123 },
          text: '/id',
        },
      },
      client,
    );
    expect(client.sent).toHaveLength(0);
    expect(await counts()).toEqual(before);
  });
  it('webhook accepts an id topic command without scheduling business jobs', async () => {
    const before = await counts();
    const response = await app.request('/api/telegram/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET ?? '',
      },
      body: JSON.stringify({
        update_id: 1900000002,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: -1001234567890, type: 'supergroup' },
          from: { id: 123 },
          text: '/id',
          message_thread_id: 12,
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await counts()).toEqual(before);
    expect(
      await env.DB.prepare(
        'SELECT status,payload,result_code FROM telegram_updates WHERE id=?',
      )
        .bind('1900000002')
        .first(),
    ).toMatchObject({
      status: 'done',
      payload: '{}',
      result_code: 'ID_COMMAND',
    });
  });
});
