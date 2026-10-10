import { ORPCError } from '@orpc/server';
import { cases } from '@saasflare-dev/db';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { caseVisibility } from './case-access';
import type { Context } from './context';
import { dateSchema } from './finance-contract';
import { protectedProcedure } from './middleware';
import { permissionPolicy, requirePermission } from './permissions';

export const trackingSchema = z.strictObject({
  page: z.number().int().min(1).max(100000).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
  query: z.string().trim().max(120).default(''),
  region: z.string().trim().max(120).default(''),
  collectorId: z.string().min(1).max(128).optional(),
  dateFrom: dateSchema.optional(),
  dateTo: dateSchema.optional(),
});
const latestAt = sql<
  number | null
>`(SELECT r.created_at FROM reports r WHERE r.case_id=cases.id AND r.workflow_status='completed' ORDER BY r.completed_at DESC,r.created_at DESC,r.id DESC LIMIT 1)`;
function criteria(context: Context, input: z.infer<typeof trackingSchema>) {
  requirePermission(context, 'case.view');
  requirePermission(context, 'installment.view');
  if (input.collectorId && permissionPolicy(context).scope !== 'all')
    throw new ORPCError('FORBIDDEN');
  return and(
    caseVisibility(context),
    isNull(cases.voidedAt),
    eq(cases.status, 'installment'),
    sql`EXISTS(SELECT 1 FROM assignments a JOIN collectors co ON co.id=a.collector_id WHERE a.case_id=cases.id AND a.unassigned_at IS NULL AND co.is_active=1)`,
    input.collectorId
      ? sql`EXISTS(SELECT 1 FROM assignments a WHERE a.case_id=cases.id AND a.unassigned_at IS NULL AND a.collector_id=${input.collectorId})`
      : undefined,
    input.query
      ? sql`(instr(lower(${cases.customerName}),lower(${input.query}))>0 OR instr(lower(${cases.code}),lower(${input.query}))>0)`
      : undefined,
    input.region ? sql`${cases.region}=${input.region}` : undefined,
    input.dateFrom
      ? sql`${latestAt}>=${Date.parse(`${input.dateFrom}T00:00:00+08:00`)}`
      : undefined,
    input.dateTo
      ? sql`${latestAt}<${Date.parse(`${input.dateTo}T00:00:00+08:00`) + 86400000}`
      : undefined,
  );
}
export async function listTracking(
  context: Context,
  raw: z.input<typeof trackingSchema>,
) {
  const input = trackingSchema.parse(raw),
    where = criteria(context, input);
  const [totals, items] = await context.DB.batch([
    context.DB.select({ total: count() }).from(cases).where(where),
    context.DB.select({
      id: cases.id,
      code: cases.code,
      customerName: cases.customerName,
      region: cases.region,
      status: sql<'installment'>`'installment'`,
      lastReportAt: latestAt,
      collectorName: sql<string>`(SELECT co.display_name FROM assignments a JOIN collectors co ON co.id=a.collector_id WHERE a.case_id=cases.id AND a.unassigned_at IS NULL LIMIT 1)`,
      latestReport: sql<
        string | null
      >`(SELECT r.content FROM reports r WHERE r.case_id=cases.id AND r.workflow_status='completed' ORDER BY r.completed_at DESC,r.created_at DESC,r.id DESC LIMIT 1)`,
    })
      .from(cases)
      .where(where)
      .orderBy(desc(latestAt), cases.id)
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize),
  ]);
  return { total: totals[0].total, items };
}
export async function trackingCount(context: Context) {
  const [row] = await context.DB.select({ total: count() })
    .from(cases)
    .where(criteria(context, trackingSchema.parse({})));
  return row.total;
}
export const installmentTrackingApi = {
  trackingList: protectedProcedure
    .input(trackingSchema)
    .handler(({ context, input }) => listTracking(context, input)),
  priorityCount: protectedProcedure.handler(({ context }) =>
    trackingCount(context),
  ),
};
