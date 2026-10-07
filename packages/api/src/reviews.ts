import { cases, reviewItems } from '@saasflare-dev/db';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Context } from './context';
import { protectedProcedure } from './middleware';
import { permissionPolicy, requirePermission } from './permissions';
import {
  reviewCreateSchema,
  reviewListSchema,
  reviewResolveSchema,
} from './review-contract';
import { createReview, getReview, resolveReview } from './review-service';
export function reviewVisibility(context: Context) {
  requirePermission(context, 'review.view');
  requirePermission(context, 'case.view');
  if (permissionPolicy(context).scope === 'all') return undefined;
  return sql`EXISTS (SELECT 1 FROM assignments a JOIN collectors c ON c.id=a.collector_id WHERE a.unassigned_at IS NULL AND c.is_active=1 AND c.user_id=${context.user?.id} AND (a.case_id=${reviewItems.caseId} OR (${reviewItems.caseId} IS NULL AND a.case_id IN (SELECT value FROM json_each(${reviewItems.proposedData},'$.candidateCaseIds')))))`;
}
export const reviewsApi = {
  create: protectedProcedure
    .input(reviewCreateSchema)
    .handler(({ context, input }) => createReview(context, input)),
  detail: protectedProcedure
    .input(z.object({ id: z.string().min(1).max(128) }).strict())
    .handler(({ context, input }) => getReview(context, input.id)),
  resolve: protectedProcedure
    .input(reviewResolveSchema)
    .handler(({ context, input }) => resolveReview(context, input)),
  pendingCount: protectedProcedure.handler(async ({ context }) => {
    const [row] = await context.DB.select({ count: count() })
      .from(reviewItems)
      .where(and(reviewVisibility(context), eq(reviewItems.status, 'pending')));
    return row.count;
  }),
  list: protectedProcedure
    .input(reviewListSchema)
    .handler(async ({ context, input }) => {
      const escaped = input.query.replace(/[!%_]/g, (x) => `!${x}`);
      const pattern = `%${escaped}%`;
      const where = and(
        reviewVisibility(context),
        input.status ? eq(reviewItems.status, input.status) : undefined,
        input.reviewType
          ? eq(reviewItems.reviewType, input.reviewType)
          : undefined,
        input.query
          ? sql`(${reviewItems.reason} LIKE ${pattern} ESCAPE '!' OR ${cases.customerName} LIKE ${pattern} ESCAPE '!' OR ${cases.caseNo} LIKE ${pattern} ESCAPE '!' OR ${cases.code} LIKE ${pattern} ESCAPE '!' OR ${reviewItems.entityId} LIKE ${pattern} ESCAPE '!' OR json_extract(${reviewItems.proposedData},'$.query.value') LIKE ${pattern} ESCAPE '!')`
          : undefined,
      );
      const [totals, items] = await context.DB.batch([
        context.DB.select({ total: count() })
          .from(reviewItems)
          .leftJoin(cases, eq(cases.id, reviewItems.caseId))
          .where(where),
        context.DB.select({
          id: reviewItems.id,
          reviewType: reviewItems.reviewType,
          entityType: reviewItems.entityType,
          entityId: reviewItems.entityId,
          caseId: reviewItems.caseId,
          status: reviewItems.status,
          priority: reviewItems.priority,
          source: reviewItems.source,
          reason: reviewItems.reason,
          confidence: reviewItems.confidence,
          createdAt: reviewItems.createdAt,
          resolvedAt: reviewItems.resolvedAt,
          customerName: cases.customerName,
          caseNo: cases.caseNo,
          lookupValue: sql<
            string | null
          >`json_extract(${reviewItems.proposedData},'$.query.value')`,
        })
          .from(reviewItems)
          .leftJoin(cases, eq(cases.id, reviewItems.caseId))
          .where(where)
          .orderBy(
            sql`CASE ${reviewItems.priority} WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END`,
            desc(reviewItems.createdAt),
            desc(reviewItems.id),
          )
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
      ]);
      return {
        items,
        total: totals[0].total,
        page: input.page,
        pageSize: input.pageSize,
      };
    }),
};
