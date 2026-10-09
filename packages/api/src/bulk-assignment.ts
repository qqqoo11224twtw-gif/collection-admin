import { ORPCError } from '@orpc/server';
import {
  bulkAssignmentItems,
  bulkAssignments,
  collectors,
  telegramOutboundJobs,
  telegramRoutes,
} from '@saasflare-dev/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { auditStatement } from './audit';
import { requireCaseAccess } from './case-access';
import type { Context } from './context';
import { protectedProcedure } from './middleware';
import { permissionPolicy, requirePermission } from './permissions';
import { telegramAudit } from './telegram-adapter';
import { outboundPayloadSchema } from './telegram-contract';

export const bulkAssignmentSchema = z.strictObject({
  batchId: z.uuid(),
  collectorId: z.string().min(1).max(120),
  caseIds: z
    .array(z.string().min(1).max(120))
    .min(1)
    .max(50)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'Choose distinct cases.',
    ),
});
type BulkInput = z.infer<typeof bulkAssignmentSchema>;

export function renderAssignment(input: {
  caseNo: string;
  code: string;
  customerName: string;
  address: string;
  amountDue: number;
}) {
  const line = (text: string) =>
    text
      .split('')
      .map((character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
          ? ' '
          : character,
      )
      .join('');
  return `案件編號：${line(input.caseNo)}\n代號：${line(input.code)}\n客戶姓名：${line(input.customerName)}\n地址：${line(input.address)}\n應收款項：${input.amountDue}`;
}
async function batchRecord(context: Context, id: string) {
  const actor = requirePermission(context, 'assignment.create');
  requirePermission(context, 'assignment.bulk');
  const [batch] = await context.DB.select()
    .from(bulkAssignments)
    .where(
      and(
        eq(bulkAssignments.id, id),
        eq(bulkAssignments.createdByUserId, actor.id),
      ),
    );
  if (!batch) throw new ORPCError('NOT_FOUND');
  return batch;
}
export async function bulkAssignmentResult(context: Context, id: string) {
  const batch = await batchRecord(context, id);
  const rows = await context.DB.select({
    caseId: bulkAssignmentItems.requestedCaseId,
    status: bulkAssignmentItems.status,
    reason: bulkAssignmentItems.reason,
    assignmentId: bulkAssignmentItems.assignmentId,
    outboundJobId: bulkAssignmentItems.outboundJobId,
    telegramStatus: telegramOutboundJobs.status,
    telegramAttempts: telegramOutboundJobs.attempts,
    telegramError: telegramOutboundJobs.lastErrorCode,
  })
    .from(bulkAssignmentItems)
    .leftJoin(
      telegramOutboundJobs,
      eq(telegramOutboundJobs.id, bulkAssignmentItems.outboundJobId),
    )
    .where(eq(bulkAssignmentItems.bulkAssignmentId, id))
    .orderBy(bulkAssignmentItems.id);
  const items = await Promise.all(
    rows.map(async (row) => {
      let label: { caseNo: string; customerName: string } | null = null;
      try {
        const record = await requireCaseAccess(context, row.caseId);
        label = { caseNo: record.caseNo, customerName: record.customerName };
      } catch (error: unknown) {
        if (!(error instanceof ORPCError)) throw error;
      }
      return { ...row, label };
    }),
  );
  return {
    batchId: id,
    collectorId: batch.collectorId,
    items,
    summary: {
      assigned: items.filter((i) => i.status === 'assigned').length,
      skipped: items.filter((i) => i.status === 'skipped').length,
      failed: items.filter((i) => i.status === 'failed').length,
      processing: items.filter((i) => i.status === 'pending').length,
      telegramQueued: items.filter(
        (i) => i.telegramStatus === 'pending' && !i.telegramError,
      ).length,
      telegramRetrying: items.filter(
        (i) => i.telegramStatus === 'pending' && !!i.telegramError,
      ).length,
      telegramFailed: items.filter((i) => i.telegramStatus === 'failed').length,
      telegramSent: items.filter((i) => i.telegramStatus === 'sent').length,
    },
  };
}
async function finishItem(
  context: Context,
  itemId: string,
  status: 'skipped' | 'failed',
  reason: string,
) {
  await context.env.DB.prepare(
    "UPDATE bulk_assignment_items SET status=?,reason=?,updated_at=? WHERE id=? AND status='pending'",
  )
    .bind(status, reason, Date.now(), itemId)
    .run();
}
export async function createBulkAssignment(context: Context, raw: BulkInput) {
  const input = bulkAssignmentSchema.parse(raw);
  input.caseIds.sort();
  const actor = requirePermission(context, 'assignment.create');
  requirePermission(context, 'assignment.bulk');
  const request = JSON.stringify({
    collectorId: input.collectorId,
    caseIds: [...input.caseIds].sort(),
  });
  let [batch] = await context.DB.select()
    .from(bulkAssignments)
    .where(eq(bulkAssignments.id, input.batchId));
  if (
    batch &&
    (batch.createdByUserId !== actor.id || batch.request !== request)
  )
    throw new ORPCError('CONFLICT', {
      message: 'Batch ID already used for a different request.',
    });
  if (!batch) {
    const [collector] = await context.DB.select()
      .from(collectors)
      .where(eq(collectors.id, input.collectorId));
    if (!collector?.isActive)
      throw new ORPCError('BAD_REQUEST', {
        message: 'Choose an active collector.',
      });
    const routes = await context.DB.select()
      .from(telegramRoutes)
      .where(
        and(
          eq(telegramRoutes.collectorId, input.collectorId),
          sql`${telegramRoutes.routeType} IN ('collector','collector_dispatch')`,
          eq(telegramRoutes.isActive, true),
        ),
      );
    if (routes.length !== 1)
      throw new ORPCError('BAD_REQUEST', {
        message:
          'Collector must have exactly one active Telegram collector route.',
      });
    const now = Date.now();
    const createToken = crypto.randomUUID();
    // The insertion guard also checks mutable collector/route state inside the transaction.
    await context.env.DB.batch([
      context.env.DB.prepare(
        "INSERT INTO bulk_assignments(id,created_by_user_id,collector_id,route_id,request,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM collectors c JOIN telegram_routes r ON r.collector_id=c.id WHERE c.id=? AND c.is_active=1 AND r.id=? AND r.is_active=1 AND r.route_type IN ('collector','collector_dispatch')) ON CONFLICT(id) DO NOTHING",
      ).bind(
        input.batchId,
        actor.id,
        input.collectorId,
        routes[0].id,
        request,
        now,
        input.collectorId,
        routes[0].id,
      ),
      ...input.caseIds.map((caseId, index) =>
        context.env.DB.prepare(
          "INSERT INTO bulk_assignment_items(id,bulk_assignment_id,requested_case_id,status,updated_at) SELECT ?,?,?,'pending',? WHERE EXISTS(SELECT 1 FROM bulk_assignments WHERE id=? AND created_by_user_id=? AND request=?) ON CONFLICT(bulk_assignment_id,requested_case_id) DO NOTHING",
        ).bind(
          `${input.batchId}:${String(index).padStart(3, '0')}`,
          input.batchId,
          caseId,
          now,
          input.batchId,
          actor.id,
          request,
        ),
      ),
      context.env.DB.prepare(
        "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,'bulk_assignment_created','bulk_assignment',?,?,? WHERE EXISTS(SELECT 1 FROM bulk_assignments WHERE id=? AND created_by_user_id=? AND request=?) AND NOT EXISTS(SELECT 1 FROM audit_logs WHERE entity_id=? AND action='bulk_assignment_created')",
      ).bind(
        createToken,
        actor.id,
        input.batchId,
        JSON.stringify({
          collectorId: input.collectorId,
          count: input.caseIds.length,
        }),
        now,
        input.batchId,
        actor.id,
        request,
        input.batchId,
      ),
    ]);
    batch = await batchRecord(context, input.batchId);
    if (batch.request !== request) throw new ORPCError('CONFLICT');
  }
  const items = await context.DB.select()
    .from(bulkAssignmentItems)
    .where(
      and(
        eq(bulkAssignmentItems.bulkAssignmentId, batch.id),
        eq(bulkAssignmentItems.status, 'pending'),
      ),
    );
  for (const item of items) {
    requirePermission(context, 'assignment.create');
    let record: Awaited<ReturnType<typeof requireCaseAccess>>;
    try {
      record = await requireCaseAccess(context, item.requestedCaseId);
    } catch (error: unknown) {
      if (!(error instanceof ORPCError)) throw error;
      await finishItem(context, item.id, 'skipped', 'CASE_UNAVAILABLE');
      continue;
    }
    const [route] = await context.DB.select()
      .from(telegramRoutes)
      .where(eq(telegramRoutes.id, batch.routeId));
    if (
      !route?.isActive ||
      route.collectorId !== input.collectorId ||
      !['collector', 'collector_dispatch'].includes(route.routeType)
    ) {
      await finishItem(context, item.id, 'skipped', 'ROUTE_UNAVAILABLE');
      continue;
    }
    const token = crypto.randomUUID(),
      assignmentId = crypto.randomUUID(),
      jobId = crypto.randomUUID(),
      now = Date.now();
    const parsedPayload = outboundPayloadSchema.safeParse({
      chatId: route.chatId,
      topicId: route.topicId,
      text: renderAssignment(record),
    });
    if (!parsedPayload.success) {
      await finishItem(context, item.id, 'failed', 'INVALID_CASE_DATA');
      continue;
    }
    const payload = parsedPayload.data;
    const scope =
      permissionPolicy(context).scope === 'all'
        ? ''
        : ' AND EXISTS(SELECT 1 FROM assignments a JOIN collectors c ON c.id=a.collector_id WHERE a.case_id=cases.id AND a.unassigned_at IS NULL AND c.is_active=1 AND c.user_id=?)';
    try {
      const results = await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE cases SET assigned_agent_id=(SELECT user_id FROM collectors WHERE id=?),updated_at=?,version=version+1,write_token=? WHERE id=? AND version=? AND NOT EXISTS(SELECT 1 FROM assignments WHERE case_id=cases.id AND unassigned_at IS NULL) AND EXISTS(SELECT 1 FROM bulk_assignment_items WHERE id=? AND status='pending') AND EXISTS(SELECT 1 FROM collectors c JOIN telegram_routes r ON r.collector_id=c.id WHERE c.id=? AND c.is_active=1 AND r.id=? AND r.is_active=1 AND r.route_type IN ('collector','collector_dispatch') AND r.chat_id=? AND coalesce(r.topic_id,0)=? AND (SELECT count(*) FROM telegram_routes WHERE collector_id=c.id AND route_type IN ('collector','collector_dispatch') AND is_active=1)=1) AND EXISTS(SELECT 1 FROM user WHERE id=? AND role=? AND (banned IS NULL OR banned=0 OR ban_expires<=?))${scope}`,
        ).bind(
          input.collectorId,
          now,
          token,
          record.id,
          record.version,
          item.id,
          input.collectorId,
          route.id,
          route.chatId,
          route.topicId ?? 0,
          actor.id,
          actor.role ?? 'user',
          now,
          ...(scope ? [actor.id] : []),
        ),
        context.env.DB.prepare(
          'INSERT INTO assignments(id,case_id,collector_id,assigned_by_user_id,assigned_at,note) SELECT ?,?,?,?,?,NULL WHERE EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)',
        ).bind(
          assignmentId,
          record.id,
          input.collectorId,
          actor.id,
          now,
          record.id,
          token,
        ),
        context.env.DB.prepare(
          "INSERT INTO telegram_outbound_jobs(id,dedupe_key,message_type,assignment_id,route_id,payload,status,attempts,next_attempt_at,created_at) SELECT ?,?,'assignment_dispatch',?,?,?,'pending',0,?,? WHERE EXISTS(SELECT 1 FROM assignments WHERE id=?)",
        ).bind(
          jobId,
          `assignment:${assignmentId}`,
          assignmentId,
          route.id,
          JSON.stringify(payload),
          now,
          now,
          assignmentId,
        ),
        context.env.DB.prepare(
          "UPDATE bulk_assignment_items SET status='assigned',assignment_id=?,outbound_job_id=?,updated_at=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM assignments WHERE id=?)",
        ).bind(assignmentId, jobId, now, item.id, assignmentId),
        auditStatement(
          context,
          'assignment.created',
          'case',
          record.id,
          {
            collectorId: input.collectorId,
            previousCollectorId: null,
            version: record.version + 1,
            bulkAssignmentId: batch.id,
            assignmentId,
          },
          token,
        ),
        telegramAudit(
          context,
          'assignment.outbound_queued',
          jobId,
          { assignmentId, bulkAssignmentId: batch.id, routeId: route.id },
          {
            sql: 'EXISTS(SELECT 1 FROM telegram_outbound_jobs WHERE id=?)',
            values: [jobId],
          },
        ),
      ]);
      if (results[0].meta.changes !== 1) {
        const current = await context.env.DB.prepare(
          'SELECT id FROM assignments WHERE case_id=? AND unassigned_at IS NULL',
        )
          .bind(record.id)
          .first();
        await finishItem(
          context,
          item.id,
          'skipped',
          current ? 'ALREADY_ASSIGNED' : 'RECORD_CHANGED',
        );
      }
    } catch {
      // A failed per-case transaction rolls back that item only; never persist raw errors.
      await finishItem(context, item.id, 'failed', 'SAVE_FAILED');
    }
  }
  return bulkAssignmentResult(context, batch.id);
}
export const bulkAssignmentApi = {
  bulkAssign: protectedProcedure
    .input(bulkAssignmentSchema)
    .handler(({ context, input }) => createBulkAssignment(context, input)),
  bulkAssignmentResult: protectedProcedure
    .input(z.strictObject({ batchId: z.uuid() }))
    .handler(({ context, input }) =>
      bulkAssignmentResult(context, input.batchId),
    ),
  bulkAssignmentCollectors: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'assignment.create');
    requirePermission(context, 'assignment.bulk');
    return context.DB.select({
      id: collectors.id,
      displayName: collectors.displayName,
      code: collectors.code,
      routeCount: sql<number>`(SELECT count(*) FROM telegram_routes WHERE collector_id=collectors.id AND route_type IN ('collector','collector_dispatch') AND is_active=1)`,
    })
      .from(collectors)
      .where(eq(collectors.isActive, true))
      .orderBy(collectors.displayName);
  }),
};
