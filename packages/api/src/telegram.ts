import { ORPCError } from '@orpc/server';
import {
  collectors,
  telegramIdentities,
  telegramOutboundJobs,
  telegramRoutes,
  telegramUpdates,
  user,
} from '@saasflare-dev/db';
import { desc, eq } from 'drizzle-orm';
import { protectedProcedure } from './middleware';
import { requirePermission } from './permissions';
import { telegramAudit } from './telegram-adapter';
import { telegramClient } from './telegram-client';
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
      if (input.collectorId) {
        const [c] = await context.DB.select()
          .from(collectors)
          .where(eq(collectors.id, input.collectorId));
        if (!c) throw new ORPCError('BAD_REQUEST');
      }
      if (input.routeType === 'collector' && !input.collectorId)
        throw new ORPCError('BAD_REQUEST');
      const now = new Date();
      const id = input.id ?? crypto.randomUUID();
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
      await telegramAudit(context, 'telegram.route_saved', id).run();
      return { id };
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
