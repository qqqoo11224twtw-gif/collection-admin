import { ORPCError } from '@orpc/server';
import {
  aiImageJobs,
  auditLogs,
  cases,
  intakeItems,
  intakeMedia,
  reviewItems,
  user,
} from '@saasflare-dev/db';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { enqueueImageExtraction } from './image-extraction-service';
import {
  intakeListSchema,
  intakeProposalSchema,
  intakeReceiveSchema,
  intakeResolveSchema,
} from './intake-contract';
import { processIntake, promoteIntake, resolveIntake } from './intake-resolver';
import {
  intakeMatching,
  intakeVisibility,
  receiveIntake,
  requireIntake,
} from './intake-service';
import { protectedProcedure } from './middleware';
import {
  ImageExtractionFailure,
  imageExtractionProvider,
} from './openai-image-extraction';
import { requirePermission } from './permissions';

const idSchema = z.object({ id: z.string().min(1).max(128) }).strict();
export const intakeApi = {
  extractImages: protectedProcedure
    .input(idSchema)
    .handler(async ({ context, input }) => {
      requirePermission(context, 'intake.resolve');
      requirePermission(context, 'media.view');
      try {
        const provider = imageExtractionProvider(context.env);
        if (!provider)
          throw new ImageExtractionFailure('AI_NOT_CONFIGURED', false);
        return await enqueueImageExtraction(context, input.id, provider);
      } catch (error: unknown) {
        if (error instanceof ImageExtractionFailure)
          throw new ORPCError('BAD_REQUEST', { message: error.code });
        throw error;
      }
    }),
  receive: protectedProcedure
    .input(intakeReceiveSchema)
    .handler(({ context, input }) => receiveIntake(context, input)),
  resolve: protectedProcedure
    .input(intakeResolveSchema)
    .handler(({ context, input }) => resolveIntake(context, input)),
  process: protectedProcedure
    .input(idSchema.extend({ expectedVersion: z.number().int().min(0) }))
    .handler(({ context, input }) => processIntake(context, input)),
  promote: protectedProcedure
    .input(idSchema)
    .handler(({ context, input }) => promoteIntake(context, input.id)),
  detail: protectedProcedure
    .input(idSchema)
    .handler(async ({ context, input }) => {
      const row = await requireIntake(context, input.id);
      const { writeToken: _token, ...safe } = row;
      const extractionJobs = await context.DB.select({
        id: aiImageJobs.id,
        status: aiImageJobs.status,
        provider: aiImageJobs.provider,
        model: aiImageJobs.model,
        errorCode: aiImageJobs.errorCode,
        updatedAt: aiImageJobs.updatedAt,
      })
        .from(aiImageJobs)
        .where(eq(aiImageJobs.intakeId, row.id));
      const media = await context.DB.select({
        id: intakeMedia.id,
        originalFilename: intakeMedia.originalFilename,
        mediaType: intakeMedia.mediaType,
        sortOrder: intakeMedia.sortOrder,
        createdAt: intakeMedia.createdAt,
        isDuplicate: intakeMedia.isDuplicate,
        promotedAt: intakeMedia.promotedAt,
      })
        .from(intakeMedia)
        .where(eq(intakeMedia.intakeId, row.id))
        .orderBy(asc(intakeMedia.sortOrder));
      const [review] = row.reviewItemId
        ? await context.DB.select({
            id: reviewItems.id,
            status: reviewItems.status,
            reviewType: reviewItems.reviewType,
          })
            .from(reviewItems)
            .where(eq(reviewItems.id, row.reviewItemId))
            .limit(1)
        : [];
      const [matchedCase] = row.matchedCaseId
        ? await context.DB.select({
            id: cases.id,
            caseNo: cases.caseNo,
            customerName: cases.customerName,
          })
            .from(cases)
            .where(eq(cases.id, row.matchedCaseId))
            .limit(1)
        : [];
      const audit = await context.DB.select({
        id: auditLogs.id,
        action: auditLogs.action,
        createdAt: auditLogs.createdAt,
        metadata: auditLogs.metadata,
        actor: sql<string>`coalesce(nullif(${user.name},''),${user.email})`,
      })
        .from(auditLogs)
        .leftJoin(user, eq(user.id, auditLogs.userId))
        .where(
          and(
            eq(auditLogs.entityType, 'intake'),
            eq(auditLogs.entityId, row.id),
          ),
        )
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(100);
      return {
        ...safe,
        extractionJobs,
        receivedData: row.receivedData
          ? intakeReceiveSchema.parse(JSON.parse(row.receivedData)).proposedData
          : null,
        proposedData: intakeProposalSchema.parse(JSON.parse(row.proposedData)),
        confirmedData: row.confirmedData
          ? intakeProposalSchema.parse(JSON.parse(row.confirmedData))
          : null,
        media,
        review: review ?? null,
        matchedCase: matchedCase ?? null,
        matching: await intakeMatching(context, row),
        audit,
      };
    }),
  list: protectedProcedure
    .input(intakeListSchema)
    .handler(async ({ context, input }) => {
      const pattern = `%${input.query.replace(/[!%_]/g, (v) => `!${v}`)}%`;
      const where = and(
        intakeVisibility(context),
        input.status ? eq(intakeItems.status, input.status) : undefined,
        input.source ? eq(intakeItems.source, input.source) : undefined,
        input.query
          ? sql`(json_extract(${intakeItems.proposedData},'$.customer_name') LIKE ${pattern} ESCAPE '!' OR json_extract(${intakeItems.proposedData},'$.code') LIKE ${pattern} ESCAPE '!' OR ${intakeItems.externalId} LIKE ${pattern} ESCAPE '!')`
          : undefined,
      );
      const [totals, items] = await context.DB.batch([
        context.DB.select({ total: count() }).from(intakeItems).where(where),
        context.DB.select({
          id: intakeItems.id,
          source: intakeItems.source,
          status: intakeItems.status,
          createdAt: intakeItems.createdAt,
          customerName: sql<
            string | null
          >`json_extract(${intakeItems.proposedData},'$.customer_name')`,
          code: sql<
            string | null
          >`json_extract(${intakeItems.proposedData},'$.code')`,
          matchedCaseId: intakeItems.matchedCaseId,
          reviewItemId: intakeItems.reviewItemId,
          mediaCount: sql<number>`(SELECT count(*) FROM intake_media m WHERE m.intake_id=${intakeItems.id})`,
        })
          .from(intakeItems)
          .where(where)
          .orderBy(desc(intakeItems.createdAt), desc(intakeItems.id))
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
