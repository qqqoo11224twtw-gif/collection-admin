import { ORPCError } from '@orpc/server';
import {
  assignments,
  collectors,
  reports,
  reviewItems,
  user,
} from '@saasflare-dev/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { atomicCaseWrite, auditStatement } from './audit';
import { requireCaseAccess } from './case-access';
import { caseIdSchema } from './case-contract';
import { caseLookupSchema, lookupCase } from './case-lookup';
import type { Context } from './context';
import { protectedProcedure } from './middleware';
import { permissionPolicy, requirePermission } from './permissions';
import {
  classifyReport,
  ManualClassifier,
  type ReportFields,
  reportCaseStatus,
  reportCreateSchema,
  reportEditSchema,
} from './report-classification';
import { pendingReportReviewStatements } from './review-service';

async function validatedFields(input: ReportFields) {
  const classification = await classifyReport(new ManualClassifier(), {
    content: input.content,
    manual: {
      status: input.status,
      revisit_status: input.revisitStatus,
      revisit_reason: input.revisitReason,
      payment_detected: input.paymentDetected,
      payment_amount: input.paymentAmount,
      confidence: 1,
    },
  });
  return { ...input, status: classification.status };
}
function caseWrite(
  context: Context,
  id: string,
  version: number,
  token: string,
  fields: ReportFields,
  sync: boolean,
  report?: { id: string; version: number },
) {
  const scope =
    permissionPolicy(context).scope === 'all'
      ? ''
      : ' AND EXISTS (SELECT 1 FROM assignments a JOIN collectors c ON c.id=a.collector_id WHERE a.case_id=cases.id AND a.unassigned_at IS NULL AND c.is_active=1 AND c.user_id=?)';
  const reportGuard = report
    ? ' AND EXISTS (SELECT 1 FROM reports WHERE id=? AND version=?)'
    : '';
  return context.env.DB.prepare(
    `UPDATE cases SET status=COALESCE(?,status), revisit_status=COALESCE(?,revisit_status), revisit_reason=CASE WHEN ? IS NOT NULL THEN ? ELSE revisit_reason END, updated_at=?,version=version+1,write_token=? WHERE id=? AND version=?${scope}${reportGuard}`,
  ).bind(
    sync ? reportCaseStatus(fields.status) : null,
    sync ? fields.revisitStatus : null,
    sync ? fields.revisitStatus : null,
    fields.revisitReason ?? '',
    Date.now(),
    token,
    id,
    version,
    ...(scope ? [context.user?.id ?? ''] : []),
    ...(report ? [report.id, report.version] : []),
  );
}
// Shared service is callable by future authenticated adapters; origin comes from the adapter, never client input.
export async function createReport(
  context: Context,
  input: ReturnType<typeof reportCreateSchema.parse>,
  source: 'admin' | 'collector_portal' | 'telegram' | 'api',
) {
  requirePermission(context, 'report.create');
  input = reportCreateSchema.parse(input);
  await requireCaseAccess(context, input.caseId);
  const fields = await validatedFields(input);
  const [current] = await context.DB.select({
    id: assignments.id,
    collectorId: assignments.collectorId,
  })
    .from(assignments)
    .innerJoin(collectors, eq(collectors.id, assignments.collectorId))
    .where(
      and(
        eq(assignments.caseId, input.caseId),
        isNull(assignments.unassignedAt),
        eq(collectors.isActive, true),
      ),
    )
    .limit(1);
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const now = Date.now();
  await atomicCaseWrite(context, [
    caseWrite(
      context,
      input.caseId,
      input.expectedCaseVersion,
      token,
      fields,
      fields.status !== 'needs_review',
    ),
    context.env.DB.prepare(
      `INSERT INTO reports (id,case_id,assignment_id,collector_id,created_by_user_id,content,status,revisit_status,revisit_reason,payment_detected,payment_amount,source,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM cases WHERE id=? AND write_token=?)`,
    ).bind(
      id,
      input.caseId,
      current?.id ?? null,
      current?.collectorId ?? null,
      context.user?.id,
      fields.content,
      fields.status,
      fields.revisitStatus,
      fields.revisitReason,
      Number(fields.paymentDetected),
      fields.paymentAmount,
      source,
      now,
      now,
      input.caseId,
      token,
    ),
    auditStatement(
      context,
      'report.created',
      'case',
      input.caseId,
      { reportId: id },
      token,
    ),
    ...(fields.status === 'needs_review'
      ? pendingReportReviewStatements(
          context,
          id,
          input.caseId,
          0,
          fields,
          token,
          source === 'telegram' ? 'telegram' : 'manual',
        )
      : []),
  ]);
  return { id };
}
export const reportsApi = {
  create: protectedProcedure
    .input(reportCreateSchema)
    .handler(({ context, input }) =>
      createReport(
        context,
        input,
        permissionPolicy(context).scope === 'all'
          ? 'admin'
          : 'collector_portal',
      ),
    ),
  list: protectedProcedure
    .input(caseIdSchema)
    .handler(async ({ context, input }) => {
      requirePermission(context, 'report.view');
      await requireCaseAccess(context, input.id);
      return context.DB.select({
        id: reports.id,
        caseId: reports.caseId,
        assignmentId: reports.assignmentId,
        collectorId: reports.collectorId,
        createdByUserId: reports.createdByUserId,
        content: reports.content,
        status: reports.status,
        revisitStatus: reports.revisitStatus,
        revisitReason: reports.revisitReason,
        paymentDetected: reports.paymentDetected,
        paymentAmount: reports.paymentAmount,
        source: reports.source,
        createdAt: reports.createdAt,
        updatedAt: reports.updatedAt,
        version: reports.version,
        author: sql<string>`coalesce(nullif(${user.name}, ''), ${user.email})`,
      })
        .from(reports)
        .innerJoin(user, eq(user.id, reports.createdByUserId))
        .where(eq(reports.caseId, input.id))
        .orderBy(desc(reports.createdAt), desc(reports.id));
    }),
  edit: protectedProcedure
    .input(reportEditSchema)
    .handler(async ({ context, input }) => {
      requirePermission(context, 'report.edit');
      await requireCaseAccess(context, input.caseId);
      const [record] = await context.DB.select()
        .from(reports)
        .where(and(eq(reports.id, input.id), eq(reports.caseId, input.caseId)))
        .limit(1);
      if (!record) throw new ORPCError('NOT_FOUND');
      if (record.version !== input.expectedVersion)
        throw new ORPCError('CONFLICT');
      const [latest] = await context.DB.select({ id: reports.id })
        .from(reports)
        .where(eq(reports.caseId, input.caseId))
        .orderBy(desc(reports.createdAt), desc(reports.id))
        .limit(1);
      const fields = await validatedFields(input);
      const [pendingReview] = await context.DB.select({ id: reviewItems.id })
        .from(reviewItems)
        .where(
          and(
            eq(reviewItems.entityType, 'report'),
            eq(reviewItems.entityId, record.id),
            eq(reviewItems.reviewType, 'report_classification'),
            eq(reviewItems.status, 'pending'),
          ),
        )
        .limit(1);
      const needsReview = fields.status === 'needs_review' || !!pendingReview;
      const token = crypto.randomUUID();
      // Older report edits never overwrite the current case summary.
      await atomicCaseWrite(context, [
        caseWrite(
          context,
          input.caseId,
          input.expectedCaseVersion,
          token,
          fields,
          latest.id === input.id && !needsReview,
          { id: record.id, version: input.expectedVersion },
        ),
        context.env.DB.prepare(
          `UPDATE reports SET content=?,status=?,revisit_status=?,revisit_reason=?,payment_detected=?,payment_amount=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND EXISTS (SELECT 1 FROM cases WHERE id=? AND write_token=?)`,
        ).bind(
          fields.content,
          needsReview ? 'needs_review' : fields.status,
          fields.revisitStatus,
          fields.revisitReason,
          Number(fields.paymentDetected),
          fields.paymentAmount,
          Date.now(),
          input.id,
          input.expectedVersion,
          input.caseId,
          token,
        ),
        auditStatement(
          context,
          'report.edited',
          'case',
          input.caseId,
          {
            reportId: input.id,
            fields: [
              'content',
              'status',
              'revisitStatus',
              'revisitReason',
              'paymentDetected',
              'paymentAmount',
            ],
          },
          token,
        ),
        ...(needsReview
          ? pendingReportReviewStatements(
              context,
              input.id,
              input.caseId,
              record.version + 1,
              fields,
              token,
              record.source === 'telegram' ? 'telegram' : 'manual',
            )
          : []),
      ]);
      return { id: input.id };
    }),
};
export const caseLookupApi = protectedProcedure
  .input(caseLookupSchema)
  .handler(({ context, input }) => lookupCase(context, input));
