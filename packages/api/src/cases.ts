import { caseMedia, cases } from '@saasflare-dev/db';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { caseVisibility, requireCaseAccess } from './case-access';
import { caseIdSchema, caseListSchema } from './case-contract';
import { protectedProcedure } from './middleware';
import { permissionPolicy, requirePermission } from './permissions';

function searchCondition(query: string) {
  if (!query) return undefined;
  // Escape LIKE metacharacters; user text is always bound as a parameter.
  const escaped = query.replace(/[!%_]/g, (value) => `!${value}`);
  const prefix = `${escaped}%`;
  // UNION lets the three prefix branches use their NOCASE indexes, while
  // address substring matching intentionally scans D1 in phase one.
  return inArray(
    cases.id,
    sql`(
    SELECT id FROM cases WHERE customer_name LIKE ${prefix} ESCAPE '!'
    UNION SELECT id FROM cases WHERE code LIKE ${prefix} ESCAPE '!'
    UNION SELECT id FROM cases WHERE case_no LIKE ${prefix} ESCAPE '!'
    UNION SELECT id FROM cases WHERE address LIKE ${`%${escaped}%`} ESCAPE '!'
    UNION SELECT id FROM cases WHERE region LIKE ${prefix} ESCAPE '!'
  )`,
  );
}

export const casesApi = {
  list: protectedProcedure
    .input(caseListSchema)
    .handler(async ({ context, input }) => {
      requirePermission(context, 'case.view');
      if (input.query) requirePermission(context, 'case.search');
      const assigned = sql`EXISTS(SELECT 1 FROM assignments a WHERE a.case_id=cases.id AND a.unassigned_at IS NULL)`;
      const where = and(
        caseVisibility(context),
        searchCondition(input.query),
        input.region ? eq(cases.region, input.region) : undefined,
        input.regionMissing ? isNull(cases.region) : undefined,
        input.status ? eq(cases.status, input.status) : undefined,
        input.collectorId
          ? sql`EXISTS(SELECT 1 FROM assignments a WHERE a.case_id=cases.id AND a.unassigned_at IS NULL AND a.collector_id=${input.collectorId})`
          : undefined,
        input.assignmentStatus === 'assigned'
          ? assigned
          : input.assignmentStatus === 'unassigned'
            ? sql`NOT ${assigned}`
            : undefined,
      );
      const [totals, items] = await context.DB.batch([
        context.DB.select({ total: count() }).from(cases).where(where),
        context.DB.select({
          id: cases.id,
          caseNo: cases.caseNo,
          code: cases.code,
          customerName: cases.customerName,
          address: cases.address,
          amountDue: cases.amountDue,
          status: cases.status,
          region: cases.region,
          source: cases.source,
          revisitStatus: cases.revisitStatus,
          revisitReason: cases.revisitReason,
          assignedAgentId: cases.assignedAgentId,
          createdAt: cases.createdAt,
          updatedAt: cases.updatedAt,
          version: cases.version,
          currentCollectorName: sql<
            string | null
          >`(SELECT c.display_name FROM assignments a JOIN collectors c ON c.id=a.collector_id WHERE a.case_id=cases.id AND a.unassigned_at IS NULL LIMIT 1)`,
          isAssigned: sql<number>`CASE WHEN ${assigned} THEN 1 ELSE 0 END`,
        })
          .from(cases)
          .where(where)
          .orderBy(desc(cases.updatedAt), asc(cases.id))
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
  detail: protectedProcedure
    .input(caseIdSchema)
    .handler(async ({ context, input }) => {
      const { writeToken: _writeToken, ...record } = await requireCaseAccess(
        context,
        input.id,
      );
      return record;
    }),
  regions: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'case.view');
    return context.DB.select({
      region: cases.region,
      total: count(),
      assigned: sql<number>`sum(CASE WHEN EXISTS(SELECT 1 FROM assignments a WHERE a.case_id=cases.id AND a.unassigned_at IS NULL) THEN 1 ELSE 0 END)`,
      unassigned: sql<number>`sum(CASE WHEN EXISTS(SELECT 1 FROM assignments a WHERE a.case_id=cases.id AND a.unassigned_at IS NULL) THEN 0 ELSE 1 END)`,
    })
      .from(cases)
      .where(caseVisibility(context))
      .groupBy(cases.region)
      .orderBy(asc(cases.region));
  }),
  media: protectedProcedure
    .input(caseIdSchema)
    .handler(async ({ context, input }) => {
      await requireCaseAccess(context, input.id, 'media.view');
      // Storage keys and hashes stay on the server. The browser only gets media IDs.
      return context.DB.select({
        id: caseMedia.id,
        caseId: caseMedia.caseId,
        originalFilename: caseMedia.originalFilename,
        mediaType: caseMedia.mediaType,
        sortOrder: caseMedia.sortOrder,
        createdAt: caseMedia.createdAt,
      })
        .from(caseMedia)
        .where(eq(caseMedia.caseId, input.id))
        .orderBy(asc(caseMedia.sortOrder), asc(caseMedia.id));
    }),
  permissions: protectedProcedure.handler(
    ({ context }) => permissionPolicy(context).permissions,
  ),
};
