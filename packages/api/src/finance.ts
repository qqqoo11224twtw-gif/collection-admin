import { ORPCError } from '@orpc/server';
import { cases, payments, settlements } from '@saasflare-dev/db';
import { and, count, desc, eq, gte, lte } from 'drizzle-orm';
import { atomicCaseWrite } from './audit';
import { caseVisibility, requireCaseAccess } from './case-access';
import { caseIdSchema } from './case-contract';
import type { Context } from './context';
import { financeAudit } from './finance-audit';
import {
  businessToday,
  calculateCommission,
  financeRangeSchema,
  ledgerVersionSchema,
  paymentCreateSchema,
  settlementStateSchema,
} from './finance-contract';
import { protectedProcedure } from './middleware';
import { requirePermission } from './permissions';

function scheduleRefresh(context: Context, paymentId: string, token: string) {
  const now = Date.now(),
    today = businessToday(
      new Date(),
      context.env.BUSINESS_TIMEZONE ?? 'Asia/Taipei',
    );
  return [
    context.env.DB.prepare(
      "UPDATE installment_schedules SET paid_amount=coalesce((SELECT sum(received_amount) FROM payments WHERE installment_schedule_id=installment_schedules.id AND status='received'),0),updated_at=? WHERE id=(SELECT installment_schedule_id FROM payments WHERE id=? AND write_token=?)",
    ).bind(now, paymentId, token),
    context.env.DB.prepare(
      "UPDATE installment_schedules SET status=CASE WHEN EXISTS(SELECT 1 FROM installment_plans p WHERE p.id=plan_id AND p.status='cancelled') THEN 'cancelled' WHEN paid_amount>=expected_amount THEN 'paid' WHEN due_date<? THEN 'overdue' WHEN paid_amount>0 THEN 'partial' ELSE 'pending' END WHERE id=(SELECT installment_schedule_id FROM payments WHERE id=? AND write_token=?) AND status<>'cancelled'",
    ).bind(today, paymentId, token),
    context.env.DB.prepare(
      "UPDATE installment_plans SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM installment_schedules WHERE plan_id=installment_plans.id AND paid_amount<expected_amount) THEN 'completed' ELSE 'active' END,updated_at=?,version=version+1 WHERE id=(SELECT installment_plan_id FROM payments WHERE id=? AND write_token=?) AND status<>'cancelled'",
    ).bind(now, paymentId, token),
  ];
}
export async function createPayment(context: Context, raw: unknown) {
  const actor = requirePermission(context, 'payment.create'),
    input = paymentCreateSchema.parse(raw);
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
      'SELECT id,case_id,received_amount,received_date,installment_schedule_id,created_by_user_id FROM payments WHERE idempotency_key=?',
    )
      .bind(input.idempotencyKey)
      .first<{
        id: string;
        case_id: string;
        received_amount: number;
        received_date: string;
        installment_schedule_id: string | null;
        created_by_user_id: string;
      }>();
    if (!prior) return null;
    if (
      prior.case_id !== input.caseId ||
      prior.received_amount !== input.receivedAmount ||
      prior.received_date !== input.receivedDate ||
      prior.installment_schedule_id !== input.installmentScheduleId ||
      prior.created_by_user_id !== actor.id
    )
      throw new ORPCError('CONFLICT');
    return { id: prior.id, duplicate: true };
  };
  const existing = await replay();
  if (existing) return existing;
  let planId: string | null = null;
  if (input.installmentScheduleId) {
    const schedule = await context.env.DB.prepare(
      "SELECT s.plan_id FROM installment_schedules s JOIN installment_plans p ON p.id=s.plan_id WHERE s.id=? AND s.case_id=? AND p.status='active' AND s.status<>'cancelled' AND s.expected_amount-s.paid_amount>=?",
    )
      .bind(input.installmentScheduleId, input.caseId, input.receivedAmount)
      .first<{ plan_id: string }>();
    if (!schedule) throw new ORPCError('BAD_REQUEST');
    planId = schedule.plan_id;
  }
  let amounts: ReturnType<typeof calculateCommission>;
  try {
    amounts = calculateCommission(
      input.receivedAmount,
      Number(context.env.COMMISSION_RATE ?? '0.50'),
    );
  } catch {
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      message: 'Commission configuration is invalid.',
    });
  }
  const id = crypto.randomUUID(),
    settlementId = crypto.randomUUID(),
    token = crypto.randomUUID(),
    now = Date.now();
  const scheduleGuard = input.installmentScheduleId
    ? " AND EXISTS(SELECT 1 FROM installment_schedules s JOIN installment_plans p ON p.id=s.plan_id WHERE s.id=? AND s.case_id=cases.id AND p.status='active' AND s.status<>'cancelled' AND s.expected_amount-coalesce((SELECT sum(received_amount) FROM payments WHERE installment_schedule_id=s.id AND status='received'),0)>=?)"
    : '';
  try {
    await atomicCaseWrite(context, [
      context.env.DB.prepare(
        `UPDATE cases SET updated_at=?,version=version+1,write_token=? WHERE id=? AND version=? AND NOT EXISTS(SELECT 1 FROM payments WHERE idempotency_key=?)${scheduleGuard}`,
      ).bind(
        now,
        token,
        record.id,
        record.version,
        input.idempotencyKey,
        ...(input.installmentScheduleId
          ? [input.installmentScheduleId, input.receivedAmount]
          : []),
      ),
      context.env.DB.prepare(
        "INSERT INTO payments(id,idempotency_key,case_id,installment_plan_id,installment_schedule_id,collector_id,received_date,received_amount,status,source,created_by_user_id,created_at,updated_at,write_token) SELECT ?,?,?,?,?,(SELECT collector_id FROM assignments WHERE case_id=? AND unassigned_at IS NULL),?,?,'received',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)",
      ).bind(
        id,
        input.idempotencyKey,
        record.id,
        planId,
        input.installmentScheduleId,
        record.id,
        input.receivedDate,
        input.receivedAmount,
        input.installmentScheduleId
          ? 'installment'
          : context.user?.role === 'user'
            ? 'manual'
            : 'admin',
        actor.id,
        now,
        now,
        token,
        record.id,
        token,
      ),
      context.env.DB.prepare(
        "INSERT INTO settlements(id,payment_id,case_id,collector_id,received_date,agent_code_snapshot,customer_name_snapshot,received_amount,commission_rate,commission_amount,return_amount,return_status,created_at,updated_at) SELECT ?,id,case_id,collector_id,received_date,?,?,?,?,?,?,'pending',?,? FROM payments WHERE id=? AND write_token=?",
      ).bind(
        settlementId,
        record.code,
        record.customerName,
        input.receivedAmount,
        amounts.commissionRate,
        amounts.commissionAmount,
        amounts.returnAmount,
        now,
        now,
        id,
        token,
      ),
      ...scheduleRefresh(context, id, token),
      financeAudit(context, record.id, 'payment.received', id, {
        sql: 'EXISTS(SELECT 1 FROM payments WHERE id=? AND write_token=?)',
        values: [id, token],
      }),
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
    receivedAmount: settlements.receivedAmount,
    commissionRate: settlements.commissionRate,
    commissionAmount: settlements.commissionAmount,
    returnAmount: settlements.returnAmount,
    returnStatus: settlements.returnStatus,
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
        source: payments.source,
        installmentScheduleId: payments.installmentScheduleId,
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
      const token = crypto.randomUUID();
      await atomicCaseWrite(context, [
        context.env.DB.prepare(
          "UPDATE payments SET status='voided',version=version+1,updated_at=?,write_token=? WHERE id=? AND version=? AND status='received' AND EXISTS(SELECT 1 FROM settlements WHERE payment_id=payments.id AND return_status='pending')",
        ).bind(Date.now(), token, payment.id, input.expectedVersion),
        ...scheduleRefresh(context, payment.id, token),
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
      await requireCaseAccess(
        context,
        row.caseId,
        input.returnStatus === 'returned'
          ? 'settlement.mark_returned'
          : 'settlement.mark_pending',
      );
      const token = crypto.randomUUID(),
        now = Date.now();
      await atomicCaseWrite(context, [
        context.env.DB.prepare(
          "UPDATE settlements SET return_status=?,returned_at=?,returned_by_user_id=?,updated_at=?,version=version+1,write_token=? WHERE id=? AND version=? AND return_status<>? AND EXISTS(SELECT 1 FROM payments WHERE id=settlements.payment_id AND status='received')",
        ).bind(
          input.returnStatus,
          input.returnStatus === 'returned' ? now : null,
          input.returnStatus === 'returned' ? actor.id : null,
          now,
          token,
          row.id,
          input.expectedVersion,
          input.returnStatus,
        ),
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
