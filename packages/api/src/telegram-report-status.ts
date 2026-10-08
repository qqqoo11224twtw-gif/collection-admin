import { ORPCError } from '@orpc/server';
import type { telegramRoutes } from '@saasflare-dev/db';
import { collectors, reports, telegramIdentities } from '@saasflare-dev/db';
import { and, eq } from 'drizzle-orm';
import { atomicCaseWrite, auditStatement } from './audit';
import { requireCaseAccess } from './case-access';
import type { Context } from './context';
import { telegramAudit } from './telegram-adapter';
import type { TelegramClient } from './telegram-client';
import {
  type TelegramReportStatus,
  type TelegramUpdate,
  telegramReportLabels,
} from './telegram-contract';
import { ensureInstallmentWorkflow } from './telegram-installments';
import {
  queueReportDestination,
  queueTelegramMessage,
} from './telegram-outbound';
import { telegramPrincipal } from './telegram-principal';
export async function processReportStatusCallback(
  base: Context,
  update: TelegramUpdate,
  route: typeof telegramRoutes.$inferSelect,
  client: TelegramClient,
) {
  const query = update.callback_query;
  const match =
    /^report_status:([a-f0-9]{32}):(settled|installment|unresolved|follow_up)$/.exec(
      query?.data ?? '',
    );
  const deny = async () => {
    await telegramAudit(
      base,
      'telegram.callback_denied',
      String(update.update_id),
      {},
      {
        sql: "NOT EXISTS(SELECT 1 FROM audit_logs WHERE entity_id=? AND action='telegram.callback_denied')",
        values: [String(update.update_id)],
      },
    ).run();
    if (query)
      await client.answerCallbackQuery(
        query.id,
        '無法確認此回報，請聯絡管理員。',
      );
    return { code: 'CALLBACK_DENIED', reportId: null };
  };
  if (!query || !match || query.from.is_bot || !query.message) return deny();
  const [report] = await base.DB.select()
    .from(reports)
    .where(eq(reports.callbackToken, match[1]))
    .limit(1);
  if (!report) return deny();
  const [identity] = await base.DB.select()
    .from(telegramIdentities)
    .where(
      and(
        eq(telegramIdentities.telegramUserId, String(query.from.id)),
        eq(telegramIdentities.isActive, true),
      ),
    )
    .limit(1);
  const [collector] = identity?.collectorId
    ? await base.DB.select()
        .from(collectors)
        .where(
          and(
            eq(collectors.id, identity.collectorId),
            eq(collectors.isActive, true),
          ),
        )
        .limit(1)
    : [];
  if (
    !identity ||
    !collector?.userId ||
    collector.id !== report.collectorId ||
    collector.userId !== report.createdByUserId ||
    (identity.userId && identity.userId !== collector.userId) ||
    report.telegramUserId !== String(query.from.id) ||
    route.id !== report.callbackRouteId ||
    route.collectorId !== collector.id ||
    route.chatId !== String(query.message.chat.id) ||
    route.topicId !== (query.message.message_thread_id ?? null)
  )
    return deny();
  let context: Context;
  try {
    context = await telegramPrincipal(base, collector.userId, true);
  } catch {
    return deny();
  }
  let record: Awaited<ReturnType<typeof requireCaseAccess>>;
  try {
    record = await requireCaseAccess(context, report.caseId, 'report.create');
  } catch {
    return deny();
  }
  const assignment = await base.env.DB.prepare(
    'SELECT id FROM assignments WHERE id=? AND case_id=? AND collector_id=? AND unassigned_at IS NULL',
  )
    .bind(report.assignmentId, report.caseId, collector.id)
    .first();
  if (!assignment) return deny();
  const selected = match[2] as TelegramReportStatus;
  let already = report.workflowStatus === 'completed';
  if (!already) {
    const token = crypto.randomUUID();
    const now = Date.now();
    try {
      await atomicCaseWrite(context, [
        base.env.DB.prepare(
          "UPDATE cases SET status=?,updated_at=?,version=version+1,write_token=? WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM reports r JOIN assignments a ON a.id=r.assignment_id JOIN collectors c ON c.id=a.collector_id JOIN telegram_identities ti ON ti.collector_id=c.id JOIN telegram_routes tr ON tr.id=r.callback_route_id WHERE r.id=? AND r.version=? AND r.workflow_status='awaiting_status' AND r.telegram_user_id=? AND a.case_id=cases.id AND a.unassigned_at IS NULL AND c.is_active=1 AND c.user_id=? AND ti.telegram_user_id=? AND ti.is_active=1 AND (ti.user_id IS NULL OR ti.user_id=c.user_id) AND tr.is_active=1 AND tr.collector_id=c.id AND tr.chat_id=? AND coalesce(tr.topic_id,0)=?)",
        ).bind(
          selected,
          now,
          token,
          report.caseId,
          record.version,
          report.id,
          report.version,
          String(query.from.id),
          collector.userId,
          String(query.from.id),
          route.chatId,
          route.topicId ?? 0,
        ),
        base.env.DB.prepare(
          "UPDATE reports SET status=?,selected_status=?,workflow_status='completed',completed_by_user_id=?,completed_at=?,updated_at=?,version=version+1 WHERE id=? AND workflow_status='awaiting_status' AND EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)",
        ).bind(
          selected,
          selected,
          collector.userId,
          now,
          now,
          report.id,
          report.caseId,
          token,
        ),
        auditStatement(
          context,
          'report.completed',
          'case',
          report.caseId,
          { reportId: report.id, fields: ['status', 'workflowStatus'] },
          token,
        ),
        telegramAudit(
          context,
          'telegram.report_completed',
          report.id,
          { reportId: report.id },
          {
            sql: 'EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)',
            values: [report.caseId, token],
          },
        ),
        base.env.DB.prepare(
          'UPDATE telegram_updates SET report_id=? WHERE id=? AND EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)',
        ).bind(report.id, String(update.update_id), report.caseId, token),
      ]);
    } catch (error: unknown) {
      const latest = await base.env.DB.prepare(
        'SELECT workflow_status FROM reports WHERE id=?',
      )
        .bind(report.id)
        .first<{ workflow_status: string }>();
      if (latest?.workflow_status === 'completed') already = true;
      else if (error instanceof ORPCError) throw error;
      else throw new ORPCError('CONFLICT');
    }
  }
  // Forward only after commit. Durable callback retries repair missing jobs safely.
  await queueReportDestination(context, report.id);
  const latest = await base.env.DB.prepare(
    'SELECT status FROM reports WHERE id=?',
  )
    .bind(report.id)
    .first<{ status: TelegramReportStatus }>();
  await queueTelegramMessage(
    context,
    route,
    `report-completed:${report.id}`,
    `已完成回報\n案件：${record.customerName} / ${record.code}\n狀態：${telegramReportLabels[latest?.status ?? selected]}`,
    report.id,
    { commandReply: true },
  );
  await client.answerCallbackQuery(
    query.id,
    already ? '此回報已完成' : '已完成回報',
  );
  if (latest?.status === 'installment')
    await ensureInstallmentWorkflow(context, report.id, route);
  return {
    code: already ? 'REPORT_ALREADY_COMPLETED' : 'REPORT_COMPLETED',
    reportId: report.id,
  };
}
