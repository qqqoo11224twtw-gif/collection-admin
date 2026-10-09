import { ORPCError } from '@orpc/server';
import { telegramBots } from '@saasflare-dev/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Context } from './context';
import { protectedProcedure } from './middleware';
import { requirePermission } from './permissions';
import { systemLog } from './system-log';
import {
  BotApiTelegramClient,
  type TelegramClient,
  TelegramFailure,
} from './telegram-client';
import { decryptBotToken, encryptBotToken } from './telegram-token-crypto';

const selector = {
  id: telegramBots.id,
  telegramBotId: telegramBots.telegramBotId,
  username: telegramBots.username,
  displayName: telegramBots.displayName,
  internalName: telegramBots.internalName,
  isActive: telegramBots.isActive,
  version: telegramBots.version,
  verifiedAt: telegramBots.verifiedAt,
  createdAt: telegramBots.createdAt,
  updatedAt: telegramBots.updatedAt,
};
const tokenSchema = z
  .string()
  .trim()
  .regex(/^\d{5,16}:[A-Za-z0-9_-]{30,100}$/);
async function verify(context: Context, token: string) {
  try {
    const result = await new BotApiTelegramClient(token).getMe();
    await systemLog(context.env.DB, {
      category: 'telegram',
      event: 'TELEGRAM_BOT_VERIFY_SUCCESS',
    });
    return result;
  } catch {
    await systemLog(context.env.DB, {
      category: 'telegram',
      event: 'TELEGRAM_BOT_VERIFY_FAILED',
      level: 'warning',
      status: 'failed',
      errorCode: 'BOT_VERIFY_FAILED',
    });
    throw new ORPCError('BAD_REQUEST', {
      message: 'Telegram Bot Token 驗證失敗。',
    });
  }
}
function audit(
  context: Context,
  action: string,
  id: string,
  data: Record<string, unknown>,
) {
  return context.env.DB.prepare(
    "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) VALUES(?,?,?,'telegram_bot',?,?,?)",
  ).bind(
    crypto.randomUUID(),
    context.user?.id ?? null,
    action,
    id,
    JSON.stringify(data),
    Date.now(),
  );
}
export async function botClientForRoute(
  context: Context,
  botId: string | null,
  legacy: TelegramClient,
) {
  if (!botId) return legacy;
  const [record] = await context.DB.select()
    .from(telegramBots)
    .where(eq(telegramBots.id, botId));
  if (!record?.isActive) throw new TelegramFailure('BOT_DISABLED', false);
  try {
    return new BotApiTelegramClient(
      await decryptBotToken(record, context.env.TELEGRAM_TOKEN_ENCRYPTION_KEY),
    );
  } catch {
    throw new TelegramFailure('BOT_CONFIGURATION', false);
  }
}
export async function logDisabledBot(
  context: Context,
  botId: string,
  routeId: string,
  jobId?: string,
  caseId?: string,
) {
  await systemLog(context.env.DB, {
    category: 'outbound',
    event: 'BOT_DISABLED',
    level: 'warning',
    status: 'failed',
    errorCode: 'BOT_DISABLED',
    safeMessage: `機器人已停用，未傳送訊息。Bot：${botId}`,
    relatedRouteId: routeId,
    relatedJobId: jobId,
    relatedCaseId: caseId,
    correlationId: context.correlationId,
  });
}
export async function botIsDisabled(context: Context, botId: string | null) {
  return (
    !!botId &&
    !(await context.env.DB.prepare(
      'SELECT id FROM telegram_bots WHERE id=? AND is_active=1',
    )
      .bind(botId)
      .first())
  );
}
export const telegramBotsApi = {
  list: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'telegram_bot.manage');
    const records = await context.DB.select(selector).from(telegramBots);
    return Promise.all(
      records.map(async (record) => ({
        ...record,
        tokenDisplay: '已安全綁定',
        activeRoutes: Number(
          (
            await context.env.DB.prepare(
              'SELECT COUNT(*) AS total FROM telegram_routes WHERE bot_id=? AND is_active=1',
            )
              .bind(record.id)
              .first<{ total: number }>()
          )?.total ?? 0,
        ),
      })),
    );
  }),
  bind: protectedProcedure
    .input(
      z.strictObject({
        token: tokenSchema,
        internalName: z.string().trim().max(120).default(''),
      }),
    )
    .handler(async ({ context, input }) => {
      requirePermission(context, 'telegram_bot.manage');
      const id = crypto.randomUUID(),
        now = new Date();
      // Fail closed on missing encryption key before sending credentials to provider.
      const encrypted = await encryptBotToken(
        input.token,
        id,
        context.env.TELEGRAM_TOKEN_ENCRYPTION_KEY,
      );
      const bot = await verify(context, input.token);
      try {
        await context.env.DB.batch([
          context.env.DB.prepare(
            'INSERT INTO telegram_bots(id,telegram_bot_id,username,display_name,internal_name,ciphertext,nonce,encryption_version,verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          ).bind(
            id,
            String(bot.id),
            bot.username,
            bot.first_name,
            input.internalName,
            encrypted.ciphertext,
            encrypted.nonce,
            encrypted.encryptionVersion,
            now.getTime(),
            now.getTime(),
            now.getTime(),
          ),
          audit(context, 'BOT_BIND', id, {
            botId: String(bot.id),
            username: bot.username,
          }),
        ]);
      } catch {
        throw new ORPCError('CONFLICT', {
          message: '此機器人已綁定，請使用重新綁定 Token。',
        });
      }

      return { id };
    }),
  rotate: protectedProcedure
    .input(
      z.strictObject({
        id: z.string(),
        token: tokenSchema,
        expectedVersion: z.number().int().nonnegative(),
      }),
    )
    .handler(async ({ context, input }) => {
      requirePermission(context, 'telegram_bot.manage');
      const [record] = await context.DB.select(selector)
        .from(telegramBots)
        .where(eq(telegramBots.id, input.id));
      if (!record) throw new ORPCError('NOT_FOUND');
      const encrypted = await encryptBotToken(
        input.token,
        input.id,
        context.env.TELEGRAM_TOKEN_ENCRYPTION_KEY,
      );
      const bot = await verify(context, input.token);
      if (String(bot.id) !== record.telegramBotId)
        throw new ORPCError('CONFLICT', {
          message: '新的 Token 屬於不同 Telegram Bot，請新增為另一隻機器人。',
        });
      const result = await context.env.DB.batch([
        context.env.DB.prepare(
          'UPDATE telegram_bots SET ciphertext=?,nonce=?,username=?,display_name=?,verified_at=?,updated_at=?,version=version+1 WHERE id=? AND version=?',
        ).bind(
          encrypted.ciphertext,
          encrypted.nonce,
          bot.username,
          bot.first_name,
          Date.now(),
          Date.now(),
          input.id,
          input.expectedVersion,
        ),
        context.env.DB.prepare(
          "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,'BOT_TOKEN_ROTATE','telegram_bot',?,?,? WHERE changes()=1",
        ).bind(
          crypto.randomUUID(),
          context.user?.id ?? null,
          input.id,
          JSON.stringify({
            botId: record.telegramBotId,
            username: bot.username,
          }),
          Date.now(),
        ),
      ]);
      if (!result[0].meta.changes)
        throw new ORPCError('CONFLICT', {
          message: '資料已變更，請重新整理。',
        });
      return { id: input.id };
    }),
  update: protectedProcedure
    .input(
      z.strictObject({
        id: z.string(),
        internalName: z.string().trim().max(120),
        isActive: z.boolean(),
        confirmDisable: z.boolean().default(false),
        expectedVersion: z.number().int().nonnegative(),
      }),
    )
    .handler(async ({ context, input }) => {
      requirePermission(context, 'telegram_bot.manage');
      const count = await context.env.DB.prepare(
        'SELECT COUNT(*) AS total FROM telegram_routes WHERE bot_id=? AND is_active=1',
      )
        .bind(input.id)
        .first<{ total: number }>();
      if (!input.isActive && count?.total && !input.confirmDisable)
        throw new ORPCError('CONFLICT', {
          message: `此機器人目前仍有 ${count.total} 條啟用中的 Telegram 路由，請確認停用。`,
        });
      const results = await context.env.DB.batch([
        context.env.DB.prepare(
          'UPDATE telegram_bots SET internal_name=?,is_active=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND (?=1 OR ?=1 OR NOT EXISTS(SELECT 1 FROM telegram_routes WHERE bot_id=? AND is_active=1))',
        ).bind(
          input.internalName,
          Number(input.isActive),
          Date.now(),
          input.id,
          input.expectedVersion,
          Number(input.isActive),
          Number(input.confirmDisable),
          input.id,
        ),
        context.env.DB.prepare(
          "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,?,'telegram_bot',?,'{}',? WHERE changes()=1",
        ).bind(
          crypto.randomUUID(),
          context.user?.id ?? null,
          input.isActive ? 'BOT_ENABLE' : 'BOT_DISABLE',
          input.id,
          Date.now(),
        ),
      ]);
      if (!results[0].meta.changes)
        throw new ORPCError('CONFLICT', {
          message: '資料已變更，請重新整理。',
        });
      return { id: input.id };
    }),
  test: protectedProcedure
    .input(z.strictObject({ id: z.string() }))
    .handler(async ({ context, input }) => {
      requirePermission(context, 'telegram_bot.manage');
      const [record] = await context.DB.select()
        .from(telegramBots)
        .where(eq(telegramBots.id, input.id));
      if (!record?.isActive)
        throw new ORPCError('BAD_REQUEST', { message: 'Bot 已停用。' });
      const token = await decryptBotToken(
        record,
        context.env.TELEGRAM_TOKEN_ENCRYPTION_KEY,
      );
      const metadata = await verify(context, token);
      if (String(metadata.id) !== record.telegramBotId)
        throw new ORPCError('CONFLICT', { message: '機器人身分不一致。' });
      await context.DB.update(telegramBots)
        .set({ verifiedAt: new Date() })
        .where(eq(telegramBots.id, input.id));
      return {
        connected: true,
        username: metadata.username,
        botId: String(metadata.id),
      };
    }),
};
