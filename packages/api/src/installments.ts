import { ORPCError } from '@orpc/server';
import { installmentPlans, installmentSchedules } from '@saasflare-dev/db';
import { asc, desc, eq } from 'drizzle-orm';
import { atomicCaseWrite } from './audit';
import { requireCaseAccess } from './case-access';
import { caseIdSchema } from './case-contract';
import type { Context } from './context';
import { customerPaymentSummary } from './customer-payments';
import { financeAudit } from './finance-audit';
import {
  businessToday,
  generateSchedule,
  ledgerVersionSchema,
  type PlanInput,
  planCreateSchema,
} from './finance-contract';
import { INSTALLMENT_SCOPE_SQL } from './installment-scope';
import { protectedProcedure } from './middleware';
import { requirePermission } from './permissions';

export async function createInstallmentPlan(
  context: Context,
  raw: PlanInput,
  workflow?: { id: string; version: number },
) {
  const actor = requirePermission(context, 'installment.create');
  const input = planCreateSchema.parse(raw);
  const record = await requireCaseAccess(
    context,
    input.caseId,
    'installment.create',
  );
  if (input.reportId) {
    const report = await context.env.DB.prepare(
      "SELECT id FROM reports WHERE id=? AND case_id=? AND workflow_status='completed' AND status='installment'",
    )
      .bind(input.reportId, record.id)
      .first();
    if (!report) throw new ORPCError('BAD_REQUEST');
    const prior = await context.env.DB.prepare(
      'SELECT id FROM installment_plans WHERE report_id=?',
    )
      .bind(input.reportId)
      .first<{ id: string }>();
    if (prior) return { id: prior.id, duplicate: true };
  }
  let schedule: ReturnType<typeof generateSchedule>;
  try {
    schedule = generateSchedule(
      input,
      businessToday(new Date(), context.env.BUSINESS_TIMEZONE ?? 'Asia/Taipei'),
    );
  } catch {
    throw new ORPCError('BAD_REQUEST');
  }
  const now = Date.now(),
    id = crypto.randomUUID(),
    token = crypto.randomUUID();
  const guard = workflow
    ? ` AND EXISTS(SELECT 1 FROM installment_workflows WHERE id=? AND version=? AND status='active' AND expires_at>? AND case_id=cases.id AND ${INSTALLMENT_SCOPE_SQL})`
    : '';
  const statements = [
    context.env.DB.prepare(
      `UPDATE cases SET status='installment',updated_at=?,version=version+1,write_token=? WHERE id=? AND version=?${guard}`,
    ).bind(
      now,
      token,
      record.id,
      record.version,
      ...(workflow ? [workflow.id, workflow.version, now] : []),
    ),
    context.env.DB.prepare(
      "INSERT INTO installment_plans(id,case_id,report_id,collector_id,plan_type,total_amount,per_payment_amount,weekday,day_of_month,deadline_date,status,created_by_user_id,created_at,updated_at,write_token) SELECT ?,?,?,(SELECT collector_id FROM assignments WHERE case_id=? AND unassigned_at IS NULL),?,?,?,?,?,?,'active',?,?,?,? WHERE EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)",
    ).bind(
      id,
      record.id,
      input.reportId,
      record.id,
      input.planType,
      input.totalAmount,
      input.planType === 'deadline' || input.planType === 'custom'
        ? null
        : input.perPaymentAmount,
      input.planType === 'weekly' ? input.weekday : null,
      input.planType === 'monthly' ? input.dayOfMonth : null,
      input.planType === 'deadline' ? input.deadlineDate : null,
      actor.id,
      now,
      now,
      token,
      record.id,
      token,
    ),
    ...schedule.map((s) =>
      context.env.DB.prepare(
        "INSERT INTO installment_schedules(id,plan_id,case_id,sequence,due_date,expected_amount,paid_amount,status,created_at,updated_at) SELECT ?,?,?,?,?,?,0,'pending',?,? WHERE EXISTS(SELECT 1 FROM installment_plans WHERE id=? AND write_token=?)",
      ).bind(
        crypto.randomUUID(),
        id,
        record.id,
        s.sequence,
        s.dueDate,
        s.expectedAmount,
        now,
        now,
        id,
        token,
      ),
    ),
    financeAudit(context, record.id, 'installment.plan_created', id, {
      sql: 'EXISTS(SELECT 1 FROM installment_plans WHERE id=? AND write_token=?)',
      values: [id, token],
    }),
    ...(workflow
      ? [
          context.env.DB.prepare(
            "UPDATE installment_workflows SET status='completed',step='completed',plan_id=?,version=version+1,updated_at=? WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM installment_plans WHERE id=? AND write_token=?)",
          ).bind(id, now, workflow.id, workflow.version, id, token),
        ]
      : []),
  ];
  try {
    await atomicCaseWrite(context, statements);
  } catch (error: unknown) {
    if (input.reportId) {
      const prior = await context.env.DB.prepare(
        'SELECT id FROM installment_plans WHERE report_id=?',
      )
        .bind(input.reportId)
        .first<{ id: string }>();
      if (prior) return { id: prior.id, duplicate: true };
    }
    throw error;
  }
  return { id, duplicate: false };
}
export const installmentsApi = {
  list: protectedProcedure
    .input(caseIdSchema)
    .handler(async ({ context, input }) => {
      await requireCaseAccess(context, input.id, 'installment.view');
      const plans = await context.DB.select()
        .from(installmentPlans)
        .where(eq(installmentPlans.caseId, input.id))
        .orderBy(desc(installmentPlans.createdAt));
      const schedules = await context.DB.select()
        .from(installmentSchedules)
        .where(eq(installmentSchedules.caseId, input.id))
        .orderBy(
          asc(installmentSchedules.dueDate),
          asc(installmentSchedules.sequence),
        );
      const today = businessToday(
        new Date(),
        context.env.BUSINESS_TIMEZONE ?? 'Asia/Taipei',
      );
      const actual = await customerPaymentSummary(context, input.id);
      return {
        actualReceived: actual.actualReceived,
        unappliedAmount: actual.unappliedAmount,
        plans: plans.map(({ writeToken: _token, ...plan }) => {
          const rows = schedules.filter((s) => s.planId === plan.id),
            allocated = rows.reduce((sum, s) => sum + s.paidAmount, 0),
            pending = rows.filter(
              (s) =>
                s.status !== 'cancelled' && s.paidAmount < s.expectedAmount,
            ),
            next = pending[0];
          return {
            ...plan,
            allocatedAmount: allocated,
            remainingPlannedAmount: Math.max(
              0,
              rows.reduce((sum, s) => sum + s.expectedAmount - s.paidAmount, 0),
            ),
            remainingInstallmentCount: pending.length,
            nextDueDate: next?.dueDate ?? null,
            nextDueAmount: next ? next.expectedAmount - next.paidAmount : 0,
          };
        }),
        schedules: schedules.map((s) => ({
          ...s,
          status:
            s.status !== 'cancelled' &&
            s.paidAmount < s.expectedAmount &&
            s.dueDate < today
              ? ('overdue' as const)
              : s.status,
        })),
      };
    }),
  create: protectedProcedure
    .input(planCreateSchema)
    .handler(({ context, input }) => {
      requirePermission(context, 'installment.manage');
      void input;
      throw new ORPCError('BAD_REQUEST', {
        message: '分期計畫已退役，請使用分期客追蹤。',
      });
    }),
  cancel: protectedProcedure
    .input(ledgerVersionSchema)
    .handler(async ({ context, input }) => {
      requirePermission(context, 'installment.cancel');
      const [plan] = await context.DB.select()
        .from(installmentPlans)
        .where(eq(installmentPlans.id, input.id));
      if (!plan) throw new ORPCError('NOT_FOUND');
      await requireCaseAccess(context, plan.caseId, 'installment.cancel');
      throw new ORPCError('BAD_REQUEST', {
        message: '歷史分期計畫為唯讀，請更新案件追蹤狀態。',
      });
    }),
};
