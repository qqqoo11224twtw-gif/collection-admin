import { ORPCError } from '@orpc/server';
import {
  collectors,
  telegramBots,
  telegramIdentities,
  telegramOutboundJobs,
  telegramRoutes,
  telegramUpdates,
  user,
} from '@saasflare-dev/db';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { protectedProcedure } from './middleware';
import { requirePermission } from './permissions';
import { systemLog } from './system-log';
import { telegramAudit } from './telegram-adapter';
import { botClientForRoute } from './telegram-bots';
import { TelegramFailure, telegramClient } from './telegram-client';
import {
  identitySchema,
  routeSchema,
  telegramUpdateSchema,
} from './telegram-contract';
import {
  receiveTelegramUpdate,
  runTelegramProcessing,
} from './telegram-processing';
export const telegramApi = {
  options: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'telegram_route.manage');
    return {
      collectors: await context.DB.select({
        id: collectors.id,
        displayName: collectors.displayName,
        userId: collectors.userId,
      }).from(collectors),
      bots: await context.DB.select({
        id: telegramBots.id,
        username: telegramBots.username,
        internalName: telegramBots.internalName,
        isActive: telegramBots.isActive,
      }).from(telegramBots),
      users: await context.DB.select({
        id: user.id,
        name: user.name,
        email: user.email,
      }).from(user),
      mode: context.env.TELEGRAM_MODE ?? 'disabled',
    };
  }),
  routes: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'telegram_route.manage');
    return context.DB.select()
      .from(telegramRoutes)
      .orderBy(desc(telegramRoutes.createdAt));
  }),
  identities: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'telegram_route.manage');
    return context.DB.select()
      .from(telegramIdentities)
      .orderBy(desc(telegramIdentities.createdAt));
  }),
  saveRoute: protectedProcedure
    .input(routeSchema)
    .handler(async ({ context, input }) => {
      const actor = requirePermission(context, 'telegram_route.manage');
      if (input.botId) {
        const [bot] = await context.DB.select()
          .from(telegramBots)
          .where(eq(telegramBots.id, input.botId));
        if (!bot || (input.isActive && !bot.isActive))
          throw new ORPCError('BAD_REQUEST', {
            message: '請選擇啟用中的機器人。',
          });
      }
      if (input.id && input.botId !== undefined) {
        const old = await context.env.DB.prepare(
          'SELECT bot_id FROM telegram_routes WHERE id=?',
        )
          .bind(input.id)
          .first<{ bot_id: string | null }>();
        if (
          old &&
          old.bot_id !== input.botId &&
          (await context.env.DB.prepare(
            "SELECT id FROM telegram_outbound_jobs WHERE route_id=? AND status IN ('pending','sending') AND dispatch_state IS NOT NULL LIMIT 1",
          )
            .bind(input.id)
            .first())
        )
          throw new ORPCError('CONFLICT', {
            message: '此路由仍有圖片派件進行中，請先完成或處理後再更換機器人。',
          });
      }
      const typeMap = {
        collector: 'collector_dispatch',
        report_destination: 'business_report',
        intake_source: 'intake',
      } as const;
      const routeType =
        input.routeType in typeMap
          ? typeMap[input.routeType as keyof typeof typeMap]
          : input.routeType;
      input = { ...input, routeType };
      if (input.collectorId) {
        const [c] = await context.DB.select()
          .from(collectors)
          .where(eq(collectors.id, input.collectorId));
        if (!c || (input.isActive && !c.isActive))
          throw new ORPCError('BAD_REQUEST', {
            message: '請選擇啟用中的外收人員。',
          });
      }
      if (
        ['collector_dispatch', 'collector_report'].includes(routeType) &&
        !input.collectorId
      )
        throw new ORPCError('BAD_REQUEST', {
          message: '收單群與回報群必須綁定外收人員。',
        });
      if (input.isActive) {
        const conflict = await context.env.DB.prepare(
          "SELECT id FROM telegram_routes WHERE id<>? AND is_active=1 AND ((chat_id=? AND coalesce(topic_id,0)=?) OR (collector_id=? AND ((route_type IN ('collector','collector_dispatch') AND ?='collector_dispatch') OR (route_type='collector_report' AND ?='collector_report')))) LIMIT 1",
        )
          .bind(
            input.id ?? '',
            input.chatId,
            input.topicId ?? 0,
            input.collectorId,
            routeType,
            routeType,
          )
          .first();
        if (conflict)
          throw new ORPCError('CONFLICT', {
            message:
              '此群組／Topic 或外收人員已有啟用中的路由，請先停用舊設定。',
          });
      }
      const now = new Date();
      const id = input.id ?? crypto.randomUUID();
      try {
        if (input.id) {
          const result = await context.DB.update(telegramRoutes)
            .set({ ...input, managedByUserId: actor.id, updatedAt: now })
            .where(eq(telegramRoutes.id, id))
            .returning({ id: telegramRoutes.id });
          if (!result.length) throw new ORPCError('NOT_FOUND');
        } else
          await context.DB.insert(telegramRoutes).values({
            ...input,
            id,
            managedByUserId: actor.id,
            createdAt: now,
            updatedAt: now,
          });
      } catch (error: unknown) {
        if (error instanceof ORPCError) throw error;
        throw new ORPCError('CONFLICT', {
          message: '群組路由設定衝突，請重新整理後確認。',
        });
      }
      await telegramAudit(context, 'telegram.route_saved', id).run();
      if (input.botId !== undefined)
        await telegramAudit(context, 'BOT_ROUTE_BIND', id, {
          botId: input.botId,
        }).run();
      return { id };
    }),
  testRoute: protectedProcedure
    .input(z.strictObject({ id: z.string() }))
    .handler(async ({ context, input }) => {
      requirePermission(context, 'telegram_route.manage');
      const [route] = await context.DB.select()
        .from(telegramRoutes)
        .where(eq(telegramRoutes.id, input.id));
      if (!route?.isActive)
        throw new ORPCError('BAD_REQUEST', { message: '請先啟用路由。' });
      try {
        const client = await botClientForRoute(
          context,
          route.botId,
          telegramClient(context.env),
        );
        const messageId = await client.sendMessage({
          chatId: route.chatId,
          topicId: route.topicId,
          text: 'Telegram 群組設定測試：連線正常。',
        });
        await systemLog(context.env.DB, {
          category: 'telegram',
          event: 'ROUTE_TEST_SENT',
          relatedRouteId: route.id,
        });
        return { success: true, code: 'SENT', message: '測試成功', messageId };
      } catch (error: unknown) {
        const code =
          error instanceof TelegramFailure ? error.code : 'DELIVERY_UNKNOWN';
        await systemLog(context.env.DB, {
          category: 'telegram',
          event: 'ROUTE_TEST_FAILED',
          level: 'error',
          status: 'failed',
          errorCode: code,
          relatedRouteId: route.id,
        });
        return {
          success: false,
          code,
          message:
            code === 'API_403'
              ? 'Bot 權限不足'
              : code === 'API_400'
                ? '找不到群組／Topic 或 Telegram API 拒絕'
                : code === 'DELIVERY_UNKNOWN'
                  ? '送達狀態未知，請人工檢查群組'
                  : 'Telegram API 拒絕',
        };
      }
    }),
  saveIdentity: protectedProcedure
    .input(identitySchema)
    .handler(async ({ context, input }) => {
      requirePermission(context, 'telegram_route.manage');
      if (input.collectorId) {
        const [c] = await context.DB.select()
          .from(collectors)
          .where(eq(collectors.id, input.collectorId));
        if (!c || !c.userId || (input.userId && input.userId !== c.userId))
          throw new ORPCError('BAD_REQUEST');
      }
      if (input.userId) {
        const [u] = await context.DB.select({ id: user.id })
          .from(user)
          .where(eq(user.id, input.userId));
        if (!u) throw new ORPCError('BAD_REQUEST');
      }
      const now = new Date();
      const id = input.id ?? crypto.randomUUID();
      if (input.id) {
        const updated = await context.DB.update(telegramIdentities)
          .set({ ...input, updatedAt: now })
          .where(eq(telegramIdentities.id, id))
          .returning({ id: telegramIdentities.id });
        if (!updated.length) throw new ORPCError('NOT_FOUND');
      } else
        await context.DB.insert(telegramIdentities).values({
          ...input,
          id,
          createdAt: now,
          updatedAt: now,
        });
      await telegramAudit(context, 'telegram.identity_saved', id).run();
      return { id };
    }),
  jobs: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'telegram_route.manage');
    return context.DB.select({
      id: telegramOutboundJobs.id,
      messageType: telegramOutboundJobs.messageType,
      status: telegramOutboundJobs.status,
      attempts: telegramOutboundJobs.attempts,
      lastErrorCode: telegramOutboundJobs.lastErrorCode,
      createdAt: telegramOutboundJobs.createdAt,
    })
      .from(telegramOutboundJobs)
      .orderBy(desc(telegramOutboundJobs.createdAt))
      .limit(50);
  }),
  updates: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'telegram_route.manage');
    return context.DB.select({
      id: telegramUpdates.id,
      status: telegramUpdates.status,
      resultCode: telegramUpdates.resultCode,
      lastErrorCode: telegramUpdates.lastErrorCode,
      attempts: telegramUpdates.attempts,
    })
      .from(telegramUpdates)
      .orderBy(desc(telegramUpdates.createdAt))
      .limit(50);
  }),
  simulate: protectedProcedure
    .input(telegramUpdateSchema)
    .handler(async ({ context, input }) => {
      requirePermission(context, 'telegram_route.manage');
      if (
        context.env.TELEGRAM_MODE !== 'fake' ||
        !/^http:\/\/localhost(?::\d+)?\/?$/.test(context.env.SERVER_URL ?? '')
      )
        throw new ORPCError('FORBIDDEN');
      return receiveTelegramUpdate(context, input);
    }),
  process: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'telegram_route.manage');
    return runTelegramProcessing(context, telegramClient(context.env));
  }),
};
