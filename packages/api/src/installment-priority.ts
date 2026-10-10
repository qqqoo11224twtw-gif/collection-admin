import { ORPCError } from '@orpc/server';
import { cases, installmentPlans } from '@saasflare-dev/db';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { caseVisibility } from './case-access';
import type { Context } from './context';
import { businessToday } from './finance-contract';
import { protectedProcedure } from './middleware';
import { permissionPolicy, requirePermission } from './permissions';

const nextDue = sql<string>`(SELECT MIN(s.due_date) FROM installment_schedules s JOIN installment_plans p ON p.id=s.plan_id WHERE p.case_id=cases.id AND p.status='active' AND s.status IN ('pending','partial','overdue') AND s.paid_amount<s.expected_amount)`;
export const priorityListSchema = z.strictObject({
  page: z.number().int().min(1).max(100000).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
  query: z.string().trim().max(120).default(''),
  filter: z
    .enum(['all', 'overdue', 'today', 'within3', 'within7'])
    .default('all'),
  collectorId: z.string().min(1).max(128).optional(),
});
export function duePriority(dueDate: string, today: string) {
  const days = Math.round(
    (Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
      86400000,
  );
  return {
    days,
    group:
      days < 0
        ? ('overdue' as const)
        : days === 0
          ? ('today' as const)
          : days <= 3
            ? ('within3' as const)
            : days <= 7
              ? ('within7' as const)
              : ('later' as const),
  };
}
function addDays(today: string, days: number) {
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
function criteria(
  context: Context,
  input: z.infer<typeof priorityListSchema>,
  today: string,
) {
  requirePermission(context, 'case.view');
  requirePermission(context, 'installment.view');
  if (input.collectorId && permissionPolicy(context).scope !== 'all')
    throw new ORPCError('FORBIDDEN');
  const pattern = `%${input.query.replace(/[!%_]/g, (v) => `!${v}`)}%`;
  return and(
    caseVisibility(context),
    isNull(cases.voidedAt),
    sql`${nextDue} IS NOT NULL`,
    input.filter === 'overdue'
      ? sql`${nextDue}<${today}`
      : input.filter === 'today'
        ? sql`${nextDue}=${today}`
        : input.filter === 'within3' || input.filter === 'within7'
          ? sql`${nextDue}>=${today} AND ${nextDue}<=${addDays(today, input.filter === 'within3' ? 3 : 7)}`
          : undefined,
    input.query
      ? sql`(${cases.customerName} LIKE ${pattern} ESCAPE '!' OR ${cases.code} LIKE ${pattern} ESCAPE '!')`
      : undefined,
    input.collectorId
      ? sql`EXISTS(SELECT 1 FROM assignments a JOIN collectors co ON co.id=a.collector_id WHERE a.case_id=cases.id AND a.unassigned_at IS NULL AND co.is_active=1 AND co.id=${input.collectorId})`
      : undefined,
  );
}
export async function listInstallmentPriority(
  context: Context,
  raw: z.infer<typeof priorityListSchema>,
  now = new Date(),
) {
  const input = priorityListSchema.parse(raw);
  const today = businessToday(
    now,
    context.env.BUSINESS_TIMEZONE ?? 'Asia/Taipei',
  );
  const where = criteria(context, input, today);
  const [totals, rows] = await context.DB.batch([
    context.DB.select({ total: count() })
      .from(cases)
      .innerJoin(
        installmentPlans,
        and(
          eq(installmentPlans.caseId, cases.id),
          sql`${installmentPlans.status}='active'`,
        ),
      )
      .where(where),
    context.DB.select({
      id: cases.id,
      code: cases.code,
      customerName: cases.customerName,
      nextDueDate: nextDue,
      paymentAmount: sql<number>`(SELECT s.expected_amount-s.paid_amount FROM installment_schedules s JOIN installment_plans p ON p.id=s.plan_id WHERE p.case_id=cases.id AND p.status='active' AND s.status IN ('pending','partial','overdue') AND s.paid_amount<s.expected_amount ORDER BY s.due_date,s.sequence LIMIT 1)`,
      remainingAmount: sql<number>`(SELECT SUM(s.expected_amount-s.paid_amount) FROM installment_schedules s JOIN installment_plans p ON p.id=s.plan_id WHERE p.case_id=cases.id AND p.status='active' AND s.status<>'cancelled')`,
      paidCount: sql<number>`(SELECT COUNT(*) FROM installment_schedules s JOIN installment_plans p ON p.id=s.plan_id WHERE p.case_id=cases.id AND p.status='active' AND s.status='paid')`,
      totalCount: sql<number>`(SELECT COUNT(*) FROM installment_schedules s JOIN installment_plans p ON p.id=s.plan_id WHERE p.case_id=cases.id AND p.status='active' AND s.status<>'cancelled')`,
      lastReportAt: sql<
        number | null
      >`(SELECT MAX(r.created_at) FROM reports r WHERE r.case_id=cases.id AND r.workflow_status='completed')`,
    })
      .from(cases)
      .innerJoin(
        installmentPlans,
        and(
          eq(installmentPlans.caseId, cases.id),
          sql`${installmentPlans.status}='active'`,
        ),
      )
      .where(where)
      .orderBy(nextDue, cases.id)
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize),
  ]);
  return {
    today,
    total: totals[0].total,
    items: rows.map((row) => ({
      ...row,
      ...duePriority(row.nextDueDate, today),
      planStatus: 'active' as const,
    })),
  };
}
export async function installmentPriorityCount(
  context: Context,
  now = new Date(),
) {
  const today = businessToday(
    now,
    context.env.BUSINESS_TIMEZONE ?? 'Asia/Taipei',
  );
  const base = criteria(context, priorityListSchema.parse({}), today);
  const [row] = await context.DB.select({ total: count() })
    .from(cases)
    .innerJoin(
      installmentPlans,
      and(
        eq(installmentPlans.caseId, cases.id),
        sql`${installmentPlans.status}='active'`,
      ),
    )
    .where(and(base, sql`${nextDue}<=${addDays(today, 3)}`));
  return row.total;
}
export const installmentPriorityApi = {
  priorityList: protectedProcedure
    .input(priorityListSchema)
    .handler(({ context, input }) => {
      requirePermission(context, 'installment.view');
      void input;
      throw new ORPCError('BAD_REQUEST', {
        message: '舊分期期程清單已退役，請使用分期客追蹤。',
      });
    }),
  priorityCount: protectedProcedure.handler(({ context }) =>
    installmentPriorityCount(context),
  ),
};
