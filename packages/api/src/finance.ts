import { ORPCError } from '@orpc/server';
import { cases, payments, settlements } from '@saasflare-dev/db';
import { and, count, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { atomicCaseWrite } from './audit';
import { caseVisibility, requireCaseAccess } from './case-access';
import { caseIdSchema } from './case-contract';
import { readCollectorRates, readFinanceSettings } from './collector-finance';
import type { Context } from './context';
import { financeAudit } from './finance-audit';
import {
  businessToday,
  calculatePrincipalSplit,
  financeRangeSchema,
  ledgerVersionSchema,
  paymentCreateSchema,
  settlementStateSchema,
} from './finance-contract';
import { protectedProcedure } from './middleware';
import { requirePermission } from './permissions';

export function scheduleRefresh(
  context: Context,
  paymentId: string,
  token: string,
) {
  const now = Date.now(),
    today = businessToday(
      new Date(),
      context.env.BUSINESS_TIMEZONE ?? 'Asia/Taipei',
    );
  return [
    context.env.DB.prepare(
      "UPDATE installment_schedules SET paid_amount=coalesce((SELECT sum(a.amount) FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE a.schedule_id=installment_schedules.id AND p.status='received'),0),updated_at=? WHERE case_id=(SELECT case_id FROM payments WHERE id=? AND write_token=?)",
    ).bind(now, paymentId, token),
    context.env.DB.prepare(
      "UPDATE installment_schedules SET status=CASE WHEN EXISTS(SELECT 1 FROM installment_plans p WHERE p.id=plan_id AND p.status='cancelled') THEN 'cancelled' WHEN paid_amount>=expected_amount THEN 'paid' WHEN due_date<? THEN 'overdue' WHEN paid_amount>0 THEN 'partial' ELSE 'pending' END WHERE case_id=(SELECT case_id FROM payments WHERE id=? AND write_token=?) AND status<>'cancelled'",
    ).bind(today, paymentId, token),
    context.env.DB.prepare(
      "UPDATE installment_plans SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM installment_schedules WHERE plan_id=installment_plans.id AND paid_amount<expected_amount AND status<>'cancelled') THEN 'completed' ELSE 'active' END,updated_at=?,version=version+1 WHERE case_id=(SELECT case_id FROM payments WHERE id=? AND write_token=?) AND status<>'cancelled'",
    ).bind(now, paymentId, token),
    context.env.DB.prepare(
      "UPDATE cases SET status=CASE WHEN EXISTS(SELECT 1 FROM installment_plans WHERE case_id=cases.id AND status='active') THEN 'installment' WHEN EXISTS(SELECT 1 FROM installment_plans WHERE case_id=cases.id AND status='completed') THEN 'settled' ELSE status END,updated_at=?,version=version+1 WHERE id=(SELECT case_id FROM payments WHERE id=? AND write_token=?)",
    ).bind(now, paymentId, token),
  ];
}
export async function createPayment(
  context: Context,
  raw: unknown,
  workflow?: {
    reportId: string;
    assignmentId: string;
    routeId: string;
    kind?: 'settled' | 'payment' | 'offset';
  },
) {
  const actor = requirePermission(context, 'payment.create'),
    input = paymentCreateSchema.parse(raw);
  if (
    workflow &&
    (!context.telegramCollectorId || input.idempotencyKey !== workflow.reportId)
  )
    throw new ORPCError('FORBIDDEN');
  const record = await requireCaseAccess(
    context,
    input.caseId,
    'payment.create',
  );
  if (
    input.receivedDate >
    businessToday(new Date(), context.env.BUSINESS_TIMEZONE ?? 'Asia/Taipei')
  )
    throw new ORPCError('BAD_REQUEST', {
      message: 'Receipt date cannot be in the future.',
    });
  const replay = async () => {
    const prior = await context.env.DB.prepare(
      'SELECT id,case_id,received_amount,received_date,installment_schedule_id,created_by_user_id,channel,status FROM payments WHERE idempotency_key=?',
    )
      .bind(input.idempotencyKey)
      .first<{
        id: string;
        case_id: string;
        received_amount: number;
        received_date: string;
        installment_schedule_id: string | null;
        created_by_user_id: string;
        channel: string;
        status: string;
      }>();
    if (!prior) return null;
    if (
      prior.case_id !== input.caseId ||
      prior.received_amount !== input.receivedAmount ||
      prior.received_date !== input.receivedDate ||
      prior.installment_schedule_id !== input.installmentScheduleId ||
      prior.channel !==
        (workflow?.kind === 'offset'
          ? 'direct_to_principal'
          : 'collector_received') ||
      prior.status !== 'received' ||
      (prior.created_by_user_id !== actor.id && !workflow)
    )
      throw new ORPCError('CONFLICT');
    return { id: prior.id, duplicate: true };
  };
  const existing = await replay();
  if (existing) return existing;
  const settings = await readFinanceSettings(context);
  const assignment = await context.env.DB.prepare(
    'SELECT collector_id FROM assignments WHERE case_id=? AND unassigned_at IS NULL',
  )
    .bind(record.id)
    .first<{ collector_id: string }>();
  const rates = await readCollectorRates(
    context,
    assignment?.collector_id ?? null,
  );
  const planId = null;
  if (input.installmentScheduleId)
    throw new ORPCError('BAD_REQUEST', {
      message: '舊分期計畫已退役，請直接記錄實際收款。',
    });
  let amounts: ReturnType<typeof calculatePrincipalSplit>;
  try {
    amounts = calculatePrincipalSplit(input.receivedAmount, rates.returnRate);
  } catch {
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      message: '回帳比例設定無效。',
    });
  }
  const id = crypto.randomUUID(),
    settlementId = crypto.randomUUID(),
    token = crypto.randomUUID(),
    now = Date.now();
  const direct = workflow?.kind === 'offset';
  if (direct && !assignment) throw new ORPCError('FORBIDDEN');
  if (direct && amounts.collectorShare === 0)
    throw new ORPCError('BAD_REQUEST', {
      message: '此筆付款沒有可後結的外收份額。',
    });
  // Retired management fees: legacy NOT NULL columns are written as zero.
  const managementCommission = 0;
  const offsetId = crypto.randomUUID();
  const scheduleGuard = input.installmentScheduleId
    ? ' AND EXISTS(SELECT 1 FROM installment_schedules s JOIN installment_plans p ON p.id=s.plan_id WHERE s.id=? AND s.case_id=cases.id)'
    : '';
  const workflowGuard = workflow
    ? " AND EXISTS(SELECT 1 FROM reports r JOIN assignments a ON a.id=r.assignment_id JOIN collectors c ON c.id=a.collector_id JOIN telegram_routes tr ON tr.id=r.callback_route_id WHERE r.id=? AND r.case_id=cases.id AND r.workflow_status='awaiting_status' AND (r.selected_status=? OR (?='payment' AND r.finance_event='payment')) AND a.id=? AND a.unassigned_at IS NULL AND c.is_active=1 AND c.id=? AND tr.id=? AND tr.route_type='collector_report' AND tr.is_active=1 AND tr.collector_id=c.id AND tr.chat_id=? AND coalesce(tr.topic_id,0)=? AND NOT EXISTS(SELECT 1 FROM telegram_report_conversations conv WHERE conv.report_id=r.id AND (conv.stage<>'status' OR conv.expires_at<=?)))"
    : '';
  try {
    const workflowRoute = workflow
      ? await context.env.DB.prepare(
          'SELECT chat_id,coalesce(topic_id,0) AS topic_id FROM telegram_routes WHERE id=?',
        )
          .bind(workflow.routeId)
          .first<{ chat_id: string; topic_id: number }>()
      : null;
    await atomicCaseWrite(context, [
      context.env.DB.prepare(
        `UPDATE cases SET updated_at=?,version=version+1,write_token=? WHERE id=? AND version=? AND voided_at IS NULL AND EXISTS(SELECT 1 FROM finance_settings WHERE id='global' AND version=?) AND NOT EXISTS(SELECT 1 FROM payments WHERE idempotency_key=?)${scheduleGuard}${workflowGuard}`,
      ).bind(
        now,
        token,
        record.id,
        record.version,
        settings.version,
        input.idempotencyKey,
        ...(input.installmentScheduleId ? [input.installmentScheduleId] : []),
        ...(workflow
          ? [
              workflow.reportId,
              direct ? 'direct_to_principal' : 'settled',
              workflow.kind ?? 'settled',
              workflow.assignmentId,
              context.telegramCollectorId ?? '',
              workflow.routeId,
              workflowRoute?.chat_id ?? '',
              workflowRoute?.topic_id ?? 0,
              now,
            ]
          : []),
      ),
      context.env.DB.prepare(
        "UPDATE finance_settings SET version=version+1,write_token=?,updated_at=? WHERE id='global' AND EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)",
      ).bind(token, now, record.id, token),
      context.env.DB.prepare(
        "INSERT INTO payments(id,idempotency_key,case_id,installment_plan_id,installment_schedule_id,collector_id,received_date,received_amount,status,source,created_by_user_id,created_at,updated_at,write_token,channel) SELECT ?,?,?,?,?,(SELECT collector_id FROM assignments WHERE case_id=? AND unassigned_at IS NULL),?,?,'received',?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)",
      ).bind(
        id,
        input.idempotencyKey,
        record.id,
        planId,
        input.installmentScheduleId,
        record.id,
        input.receivedDate,
        input.receivedAmount,
        workflow
          ? 'telegram'
          : input.installmentScheduleId
            ? 'installment'
            : context.user?.role === 'user'
              ? 'manual'
              : 'admin',
        actor.id,
        now,
        now,
        token,
        direct ? 'direct_to_principal' : 'collector_received',
        record.id,
        token,
      ),
      context.env.DB.prepare(
        "INSERT INTO settlements(id,payment_id,case_id,collector_id,received_date,agent_code_snapshot,customer_name_snapshot,received_amount,commission_rate,commission_amount,return_amount,return_status,created_at,updated_at,admin_commission_rate,admin_commission_amount,collector_return_rate_snapshot,admin_commission_rate_snapshot,collector_received_amount,principal_return_due_from_collector,collector_entitlement) SELECT ?,id,case_id,collector_id,received_date,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,? FROM payments WHERE id=? AND write_token=?",
      ).bind(
        settlementId,
        record.code,
        record.customerName,
        input.receivedAmount,
        amounts.collectorShareRate,
        amounts.collectorShare,
        amounts.principalDue,
        now,
        now,
        0,
        managementCommission,
        rates.returnRate,
        0,
        direct ? 0 : input.receivedAmount,
        direct ? 0 : amounts.principalDue,
        direct ? amounts.collectorShare : 0,
        id,
        token,
      ),
      ...(direct
        ? [
            context.env.DB.prepare(
              'INSERT INTO collector_offsets(id,source_payment_id,collector_id,amount,admin_commission_rate,admin_commission_amount,created_by_user_id,created_at) SELECT ?,id,collector_id,?,?,?,?,? FROM payments WHERE id=? AND write_token=?',
            ).bind(
              offsetId,
              amounts.collectorShare,
              0,
              managementCommission,
              actor.id,
              now,
              id,
              token,
            ),
            financeAudit(context, record.id, 'offset.created', offsetId, {
              sql: 'EXISTS(SELECT 1 FROM payments WHERE id=? AND write_token=?)',
              values: [id, token],
            }),
          ]
        : []),
      ...(workflow && workflow.kind !== 'payment'
        ? [
            context.env.DB.prepare(
              "UPDATE cases SET status='settled' WHERE id=? AND write_token=?",
            ).bind(record.id, token),
            context.env.DB.prepare(
              'UPDATE cases SET current_status=? WHERE id=? AND write_token=?',
            ).bind(
              direct ? 'direct_to_principal' : 'settled',
              record.id,
              token,
            ),
          ]
        : []),
      ...(workflow
        ? [
            context.env.DB.prepare(
              "UPDATE reports SET workflow_status='completed',status=CASE WHEN (SELECT status FROM cases WHERE id=reports.case_id)='settled' THEN 'settled' WHEN (SELECT status FROM cases WHERE id=reports.case_id)='installment' THEN 'installment' ELSE 'follow_up' END,finance_event=?,payment_detected=1,payment_amount=?,completed_at=?,completed_by_user_id=?,updated_at=?,version=version+1 WHERE id=? AND EXISTS(SELECT 1 FROM payments WHERE id=? AND write_token=?)",
            ).bind(
              workflow.kind === 'offset'
                ? 'offset'
                : workflow.kind === 'payment'
                  ? 'payment'
                  : null,
              input.receivedAmount,
              now,
              actor.id,
              now,
              workflow.reportId,
              id,
              token,
            ),
            context.env.DB.prepare(
              "UPDATE telegram_report_conversations SET stage='completed',updated_at=? WHERE report_id=? AND stage='status' AND EXISTS(SELECT 1 FROM payments WHERE id=? AND write_token=?)",
            ).bind(now, workflow.reportId, id, token),
          ]
        : []),
      financeAudit(context, record.id, 'payment.received', id, {
        sql: 'EXISTS(SELECT 1 FROM payments WHERE id=? AND write_token=?)',
        values: [id, token],
      }),
      ...(workflow
        ? [
            financeAudit(
              context,
              record.id,
              'report.completed',
              workflow.reportId,
              {
                sql: 'EXISTS(SELECT 1 FROM payments WHERE id=? AND write_token=?)',
                values: [id, token],
              },
            ),
          ]
        : []),
      financeAudit(context, record.id, 'settlement.created', settlementId, {
        sql: 'EXISTS(SELECT 1 FROM payments WHERE id=? AND write_token=?)',
        values: [id, token],
      }),
    ]);
  } catch (error: unknown) {
    const prior = await replay();
    if (prior) return prior;
    throw error;
  }
  return { id, duplicate: false };
}
export async function settlementRows(
  context: Context,
  raw: unknown,
  exporting = false,
) {
  requirePermission(context, exporting ? 'finance.export' : 'settlement.view');
  const input = financeRangeSchema.parse(raw);
  const where = and(
    caseVisibility(context),
    eq(payments.status, 'received'),
    input.dateFrom ? gte(settlements.receivedDate, input.dateFrom) : undefined,
    input.dateTo ? lte(settlements.receivedDate, input.dateTo) : undefined,
  );
  const totals = await context.DB.select({ total: count() })
    .from(settlements)
    .innerJoin(payments, eq(payments.id, settlements.paymentId))
    .innerJoin(cases, eq(cases.id, settlements.caseId))
    .where(where);
  if (exporting && totals[0].total > 5000)
    throw new ORPCError('BAD_REQUEST', {
      message: 'Choose a smaller date range (maximum 5000 rows).',
    });
  const rows = await context.DB.select({
    id: settlements.id,
    paymentId: settlements.paymentId,
    caseId: settlements.caseId,
    collectorId: settlements.collectorId,
    receivedDate: settlements.receivedDate,
    agentCode: settlements.agentCodeSnapshot,
    customerName: settlements.customerNameSnapshot,
    receivedAmount: settlements.collectorReceivedAmount,
    customerPaymentAmount: payments.receivedAmount,
    collectorEntitlement: settlements.collectorEntitlement,
    collectorReturnRateSnapshot: settlements.collectorReturnRateSnapshot,
    returnAmount: settlements.principalReturnDueFromCollector,
    returnStatus: settlements.returnStatus,
    channel: payments.channel,
    ledgerManaged: sql<number>`(${payments.channel}='direct_to_principal' OR EXISTS(SELECT 1 FROM offset_allocations a JOIN collector_offsets o ON o.id=a.offset_id JOIN payments p ON p.id=o.source_payment_id WHERE a.settlement_id=${settlements.id} AND o.voided_at IS NULL AND p.status='received') OR (${settlements.returnStatus}='pending' AND EXISTS(SELECT 1 FROM remittance_allocations a JOIN remittances r ON r.id=a.remittance_id WHERE a.settlement_id=${settlements.id} AND r.voided_at IS NULL)))`,
    returnedAt: settlements.returnedAt,
    returnedByUserId: settlements.returnedByUserId,
    version: settlements.version,
  })
    .from(settlements)
    .innerJoin(payments, eq(payments.id, settlements.paymentId))
    .innerJoin(cases, eq(cases.id, settlements.caseId))
    .where(where)
    .orderBy(desc(settlements.receivedDate), desc(settlements.createdAt))
    .limit(exporting ? 5000 : input.pageSize)
    .offset(exporting ? 0 : (input.page - 1) * input.pageSize);
  return {
    items: rows,
    total: totals[0].total,
    page: input.page,
    pageSize: input.pageSize,
  };
}
export const financeApi = {
  settlements: protectedProcedure
    .input(financeRangeSchema)
    .handler(({ context, input }) => settlementRows(context, input)),
  payments: protectedProcedure
    .input(caseIdSchema)
    .handler(async ({ context, input }) => {
      await requireCaseAccess(context, input.id, 'payment.view');
      return context.DB.select({
        id: payments.id,
        caseId: payments.caseId,
        receivedDate: payments.receivedDate,
        receivedAmount: payments.receivedAmount,
        status: payments.status,
        canVoid: sql<boolean>`1`.mapWith(Boolean),
        source: payments.source,
        channel: payments.channel,
        installmentScheduleId: payments.installmentScheduleId,
        allocatedAmount: sql<number>`coalesce((SELECT sum(amount) FROM payment_allocations WHERE payment_id=${payments.id}),0)`,
        unappliedAmount: sql<number>`${payments.receivedAmount}-coalesce((SELECT sum(amount) FROM payment_allocations WHERE payment_id=${payments.id}),0)`,
        agentCode: settlements.agentCodeSnapshot,
        customerName: settlements.customerNameSnapshot,
        version: payments.version,
      })
        .from(payments)
        .innerJoin(settlements, eq(settlements.paymentId, payments.id))
        .where(eq(payments.caseId, input.id))
        .orderBy(desc(payments.receivedDate), desc(payments.createdAt));
    }),
  createPayment: protectedProcedure
    .input(paymentCreateSchema)
    .handler(({ context, input }) => createPayment(context, input)),
  voidPayment: protectedProcedure
    .input(ledgerVersionSchema)
    .handler(async ({ context, input }) => {
      requirePermission(context, 'payment.void');
      const [payment] = await context.DB.select()
        .from(payments)
        .where(eq(payments.id, input.id));
      if (!payment) throw new ORPCError('NOT_FOUND');
      await requireCaseAccess(context, payment.caseId, 'payment.void');
      if (payment.status === 'voided')
        return { id: payment.id, duplicate: true };
      const token = crypto.randomUUID();
      const settings = await readFinanceSettings(context);
      await atomicCaseWrite(context, [
        context.env.DB.prepare(
          "UPDATE payments SET status='voided',version=version+1,updated_at=?,write_token=? WHERE id=? AND version=? AND status='received' AND EXISTS(SELECT 1 FROM finance_settings WHERE id='global' AND version=?)",
        ).bind(
          Date.now(),
          token,
          payment.id,
          input.expectedVersion,
          settings.version,
        ),
        context.env.DB.prepare(
          "UPDATE finance_settings SET version=version+1,write_token=?,updated_at=? WHERE id='global' AND EXISTS(SELECT 1 FROM payments WHERE id=? AND write_token=?)",
        ).bind(token, Date.now(), payment.id, token),
        financeAudit(context, payment.caseId, 'payment.voided', payment.id, {
          sql: 'EXISTS(SELECT 1 FROM payments WHERE id=? AND write_token=?)',
          values: [payment.id, token],
        }),
      ]);
      return { id: payment.id };
    }),
  markSettlement: protectedProcedure
    .input(settlementStateSchema)
    .handler(async ({ context, input }) => {
      const actor = requirePermission(
        context,
        input.returnStatus === 'returned'
          ? 'settlement.mark_returned'
          : 'settlement.mark_pending',
      );
      const [row] = await context.DB.select()
        .from(settlements)
        .where(eq(settlements.id, input.id));
      if (!row) throw new ORPCError('NOT_FOUND');
      const paymentChannel = await context.env.DB.prepare(
        'SELECT channel FROM payments WHERE id=?',
      )
        .bind(row.paymentId)
        .first<{ channel: string }>();
      if (paymentChannel?.channel === 'direct_to_principal')
        throw new ORPCError('BAD_REQUEST', {
          message: '請至外收財報新增或作廢回帳事件，保留獨立回帳及後結事件。',
        });
      await requireCaseAccess(
        context,
        row.caseId,
        input.returnStatus === 'returned'
          ? 'settlement.mark_returned'
          : 'settlement.mark_pending',
      );
      const token = crypto.randomUUID(),
        now = Date.now();
      const settings = await readFinanceSettings(context);
      const legacyEvent = await context.env.DB.prepare(
        'SELECT r.id,(SELECT count(*) FROM remittance_allocations other WHERE other.remittance_id=r.id) AS allocation_count FROM remittance_allocations a JOIN remittances r ON r.id=a.remittance_id WHERE a.settlement_id=? AND r.voided_at IS NULL',
      )
        .bind(row.id)
        .first<{ id: string; allocation_count: number }>();
      const offsets = await context.env.DB.prepare(
        "SELECT a.id FROM offset_allocations a JOIN collector_offsets o ON o.id=a.offset_id JOIN payments p ON p.id=o.source_payment_id WHERE a.settlement_id=? AND o.voided_at IS NULL AND p.status='received'",
      )
        .bind(row.id)
        .first();
      if (
        offsets ||
        (legacyEvent &&
          (input.returnStatus === 'returned' ||
            legacyEvent.allocation_count !== 1))
      )
        throw new ORPCError('BAD_REQUEST', {
          message: '此項已有 allocation，請使用回帳事件作廢／更正。',
        });
      const remittanceId = crypto.randomUUID();
      await atomicCaseWrite(context, [
        context.env.DB.prepare(
          "UPDATE settlements SET return_status=?,returned_at=?,returned_by_user_id=?,updated_at=?,version=version+1,write_token=? WHERE id=? AND version=? AND return_status<>? AND EXISTS(SELECT 1 FROM finance_settings WHERE id='global' AND version=?) AND EXISTS(SELECT 1 FROM payments WHERE id=settlements.payment_id AND status='received')",
        ).bind(
          input.returnStatus,
          input.returnStatus === 'returned' ? now : null,
          input.returnStatus === 'returned' ? actor.id : null,
          now,
          token,
          row.id,
          input.expectedVersion,
          input.returnStatus,
          settings.version,
        ),
        context.env.DB.prepare(
          "UPDATE finance_settings SET version=version+1,write_token=?,updated_at=? WHERE id='global' AND EXISTS(SELECT 1 FROM settlements WHERE id=? AND write_token=?)",
        ).bind(token, now, row.id, token),
        ...(input.returnStatus === 'returned' &&
        row.collectorId &&
        row.returnAmount > 0
          ? [
              context.env.DB.prepare(
                'INSERT INTO remittances(id,idempotency_key,collector_id,amount,principal_amount,received_date,note,created_by_user_id,created_at,write_token) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM settlements WHERE id=? AND write_token=?)',
              ).bind(
                remittanceId,
                crypto.randomUUID(),
                row.collectorId,
                row.returnAmount,
                row.returnAmount,
                businessToday(),
                '既有回款狀態操作',
                actor.id,
                now,
                token,
                row.id,
                token,
              ),
              context.env.DB.prepare(
                "INSERT INTO remittance_allocations(id,remittance_id,settlement_id,component,amount) SELECT ?,?,?,'principal',? WHERE EXISTS(SELECT 1 FROM remittances WHERE id=? AND write_token=?)",
              ).bind(
                crypto.randomUUID(),
                remittanceId,
                row.id,
                row.returnAmount,
                remittanceId,
                token,
              ),
            ]
          : []),
        ...(input.returnStatus === 'pending' && legacyEvent
          ? [
              context.env.DB.prepare(
                "UPDATE remittances SET voided_at=?,voided_by_user_id=?,void_reason='既有回款狀態改回未回款' WHERE id=? AND voided_at IS NULL AND EXISTS(SELECT 1 FROM settlements WHERE id=? AND write_token=?)",
              ).bind(now, actor.id, legacyEvent.id, row.id, token),
            ]
          : []),
        financeAudit(
          context,
          row.caseId,
          input.returnStatus === 'returned'
            ? 'settlement.marked_returned'
            : 'settlement.marked_pending',
          row.id,
          {
            sql: 'EXISTS(SELECT 1 FROM settlements WHERE id=? AND write_token=?)',
            values: [row.id, token],
          },
        ),
      ]);
      return { id: row.id };
    }),
};
