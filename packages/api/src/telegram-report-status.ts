import { ORPCError } from '@orpc/server';
import type { telegramRoutes } from '@saasflare-dev/db';
import { reports } from '@saasflare-dev/db';
import { eq } from 'drizzle-orm';
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
import {
  queueReportDestination,
  queueTelegramMessage,
} from './telegram-outbound';
import { expireReportConversations } from './telegram-report-expiry';
import { reportMediaReady } from './telegram-report-media';
import { reportRoutePrincipal } from './telegram-report-principal';
export async function processReportStatusCallback(
  base: Context,
  update: TelegramUpdate,
  route: typeof telegramRoutes.$inferSelect,
  client: TelegramClient,
) {
  await expireReportConversations(base.env.DB);
  const query = update.callback_query;
  const match =
    /^report_status:([a-f0-9]{32}):(settled|installment|offset|unresolved|follow_up)$/.exec(
      query?.data ?? '',
    );
  const deny = async (text = '無法確認此回報，請聯絡管理員。') => {
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
    if (query) await client.answerCallbackQuery(query.id, text);
    return { code: 'CALLBACK_DENIED', reportId: null };
  };
  if (!query || !match || !query.message) return deny();
  const [report] = await base.DB.select()
    .from(reports)
    .where(eq(reports.callbackToken, match[1]))
    .limit(1);
  if (!report) return deny();
  if (report.financeEvent === 'payment')
    return deny('這筆是收款紀錄，請使用收款流程或後台財務更正。');
  const conversation = await base.env.DB.prepare(
    'SELECT stage,expires_at FROM telegram_report_conversations WHERE report_id=?',
  )
    .bind(report.id)
    .first<{ stage: string; expires_at: number }>();
  if (
    conversation &&
    (!['status', 'completed'].includes(conversation.stage) ||
      conversation.expires_at <= Date.now())
  )
    return deny('回報已逾時失敗，請重新輸入 /回報。');
  if (
    route.id !== report.callbackRouteId ||
    route.collectorId !== report.collectorId
  )
    return deny();
  let context: Context;
  try {
    context = await reportRoutePrincipal(base, route, update);
  } catch {
    return deny();
  }
  const collector = { id: route.collectorId, userId: context.user?.id };
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
  if (!(await reportMediaReady(base, report.id)))
    return deny('圖片仍在接收中，請稍後再選擇狀態。');
  const selected: TelegramReportStatus =
    match[2] === 'offset'
      ? 'direct_to_principal'
      : (match[2] as TelegramReportStatus);
  if (selected === 'direct_to_principal') {
    if (report.workflowStatus === 'completed') {
      await client.answerCallbackQuery(query.id, '此回報已完成');
      return { code: 'REPORT_ALREADY_COMPLETED', reportId: report.id };
    }
    if (
      report.selectedStatus &&
      report.selectedStatus !== 'direct_to_principal'
    )
      return deny();
    const result = await base.env.DB.prepare(
      "UPDATE reports SET selected_status='direct_to_principal',updated_at=?,version=version+1 WHERE id=? AND workflow_status='awaiting_status' AND (selected_status IS NULL OR selected_status='direct_to_principal') AND EXISTS(SELECT 1 FROM assignments a JOIN cases c ON c.id=a.case_id JOIN collectors col ON col.id=a.collector_id JOIN telegram_routes tr ON tr.id=reports.callback_route_id WHERE a.id=reports.assignment_id AND a.collector_id=? AND a.unassigned_at IS NULL AND col.is_active=1 AND c.voided_at IS NULL AND tr.is_active=1 AND tr.collector_id=col.id) AND EXISTS(SELECT 1 FROM telegram_report_conversations conv WHERE conv.report_id=reports.id AND conv.stage='status' AND conv.expires_at>?)",
    )
      .bind(Date.now(), report.id, route.collectorId, Date.now())
      .run();
    if (result.meta.changes !== 1) return deny();
    await client.answerCallbackQuery(query.id, '請輸入客戶直接付款金額');
    await queueTelegramMessage(
      context,
      route,
      `direct-amount:${report.id}`,
      '請輸入客戶本次直接匯給案主的金額（整數台幣）。系統會計算後結抵扣。',
      report.id,
      { commandReply: true },
    );
    return { code: 'DIRECT_PAYMENT_AMOUNT_REQUIRED', reportId: report.id };
  }
  if (report.selectedStatus === 'direct_to_principal') return deny();
  if (
    report.workflowStatus !== 'completed' &&
    report.selectedStatus === 'settled' &&
    selected !== 'settled'
  ) {
    const paid = await base.env.DB.prepare(
      "SELECT id FROM payments WHERE idempotency_key=? AND status='received'",
    )
      .bind(report.id)
      .first();
    if (paid) return deny();
  }
  let already = report.workflowStatus === 'completed';
  if (selected === 'settled' && !already) {
    const payment = await base.env.DB.prepare(
      "SELECT id FROM payments WHERE idempotency_key=? AND case_id=? AND status='received'",
    )
      .bind(report.id, report.caseId)
      .first();
    if (!payment) {
      await base.env.DB.prepare(
        "UPDATE reports SET selected_status='settled',updated_at=?,version=version+1 WHERE id=? AND workflow_status='awaiting_status' AND selected_status IS NULL AND NOT EXISTS(SELECT 1 FROM reports other WHERE other.id<>reports.id AND other.callback_route_id=reports.callback_route_id AND other.workflow_status='awaiting_status' AND other.selected_status='settled' AND NOT EXISTS(SELECT 1 FROM telegram_report_conversations conv WHERE conv.report_id=other.id AND (conv.stage<>'status' OR conv.expires_at<=?))) AND EXISTS(SELECT 1 FROM assignments a JOIN collectors c ON c.id=a.collector_id JOIN telegram_routes r ON r.id=reports.callback_route_id WHERE a.id=reports.assignment_id AND a.unassigned_at IS NULL AND c.is_active=1 AND r.is_active=1 AND r.collector_id=c.id AND r.route_type='collector_report') AND NOT EXISTS(SELECT 1 FROM telegram_report_conversations own WHERE own.report_id=reports.id AND (own.stage<>'status' OR own.expires_at<=?))",
      )
        .bind(Date.now(), report.id, Date.now(), Date.now())
        .run();
      const current = await base.env.DB.prepare(
        'SELECT selected_status FROM reports WHERE id=?',
      )
        .bind(report.id)
        .first<{ selected_status: string | null }>();
      if (current?.selected_status !== 'settled') {
        await client.answerCallbackQuery(
          query.id,
          '此群組有未完成的收款，請先完成上一筆。',
        );
        return { code: 'PAYMENT_WORKFLOW_BUSY', reportId: report.id };
      }
      await queueTelegramMessage(
        context,
        route,
        `settlement-amount:${report.id}`,
        '請輸入本次實際收款金額（整數台幣）。尚未實收請勿選結清。',
        report.id,
        { commandReply: true },
      );
      await client.answerCallbackQuery(query.id, '請輸入實際收款金額');
      return { code: 'PAYMENT_AMOUNT_REQUIRED', reportId: report.id };
    }
  }
  if (!already) {
    const token = crypto.randomUUID();
    const now = Date.now();
    try {
      await atomicCaseWrite(context, [
        base.env.DB.prepare(
          "UPDATE cases SET current_status=NULL,status=?,updated_at=?,version=version+1,write_token=? WHERE id=? AND version=? AND (?='settled' OR NOT EXISTS(SELECT 1 FROM payments WHERE idempotency_key=? AND status='received')) AND EXISTS(SELECT 1 FROM reports r JOIN assignments a ON a.id=r.assignment_id JOIN collectors c ON c.id=a.collector_id JOIN telegram_routes tr ON tr.id=r.callback_route_id WHERE r.id=? AND r.version=? AND r.workflow_status='awaiting_status' AND a.case_id=cases.id AND a.unassigned_at IS NULL AND c.is_active=1 AND tr.is_active=1 AND tr.route_type='collector_report' AND tr.collector_id=c.id AND tr.chat_id=? AND coalesce(tr.topic_id,0)=? AND NOT EXISTS(SELECT 1 FROM telegram_report_conversations conv WHERE conv.report_id=r.id AND (conv.stage<>'status' OR conv.expires_at<=?)))",
        ).bind(
          selected,
          now,
          token,
          report.caseId,
          record.version,
          selected,
          report.id,
          report.id,
          report.version,
          route.chatId,
          route.topicId ?? 0,
          Date.now(),
        ),
        base.env.DB.prepare(
          "UPDATE reports SET status=?,selected_status=?,workflow_status='completed',completed_by_user_id=?,completed_at=?,updated_at=?,payment_detected=CASE WHEN ?='settled' THEN 1 ELSE payment_detected END,payment_amount=CASE WHEN ?='settled' THEN (SELECT received_amount FROM payments WHERE idempotency_key=reports.id AND status='received') ELSE payment_amount END,version=version+1 WHERE id=? AND workflow_status='awaiting_status' AND EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)",
        ).bind(
          selected,
          selected,
          collector.userId,
          now,
          now,
          selected,
          selected,
          report.id,
          report.caseId,
          token,
        ),
        base.env.DB.prepare(
          "UPDATE telegram_report_conversations SET stage='completed',updated_at=? WHERE report_id=? AND stage='status' AND EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)",
        ).bind(now, report.id, report.caseId, token),
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

  await base.env.DB.prepare(
    "UPDATE telegram_report_conversations SET stage='completed',updated_at=? WHERE report_id=? AND stage='status'",
  )
    .bind(Date.now(), report.id)
    .run();
  return {
    code: already ? 'REPORT_ALREADY_COMPLETED' : 'REPORT_COMPLETED',
    reportId: report.id,
  };
}
