import { caseMedia, cases } from '@saasflare-dev/db';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { caseVisibility, requireCaseAccess } from './case-access';
import { caseIdSchema, caseListSchema } from './case-contract';
import { protectedProcedure } from './middleware';

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
  )`,
  );
}

export const casesApi = {
  list: protectedProcedure
    .input(caseListSchema)
    .handler(async ({ context, input }) => {
      const where = and(caseVisibility(context), searchCondition(input.query));
      const [totals, items] = await context.DB.batch([
        context.DB.select({ total: count() }).from(cases).where(where),
        context.DB.select()
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
    .handler(({ context, input }) => requireCaseAccess(context, input.id)),
  media: protectedProcedure
    .input(caseIdSchema)
    .handler(async ({ context, input }) => {
      await requireCaseAccess(context, input.id);
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
};
