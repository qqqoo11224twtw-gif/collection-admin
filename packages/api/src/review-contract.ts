import { REVIEW_STATUSES, REVIEW_TYPES } from '@saasflare-dev/db';
import { z } from 'zod';
import { caseLookupSchema } from './case-lookup';
import { reportClassificationSchema } from './report-classification';

const id = z.string().min(1).max(128);
const amount = z.number().int().min(0).max(1_000_000_000_000);
export const extractionSchema = z
  .object({
    code: z.string().trim().min(1).max(60),
    customer_name: z.string().trim().min(1).max(120),
    address: z.string().trim().min(1).max(500),
    amount_due: amount,
  })
  .strict();
export type ImageExtractionProposal = z.infer<typeof extractionSchema>;
export interface ImageExtractionReviewProvider {
  extract(input: { mediaId: string }): Promise<unknown>;
}
export const paymentProposalSchema = z
  .object({ payment_detected: z.boolean(), payment_amount: amount.nullable() })
  .strict()
  .refine((x) => x.payment_detected || x.payment_amount === null, {
    message: 'Payment amount requires a payment marker.',
  });
export const reviewProposalSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('report_classification'),
      reportId: id,
      reportVersion: z.number().int().min(0),
      originalContent: z.string().min(1).max(10000),
      classification: reportClassificationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('case_match'),
      query: caseLookupSchema,
      candidateCaseIds: z.array(id).min(2).max(50),
    })
    .strict(),
  z
    .object({
      type: z.literal('image_extraction'),
      extraction: extractionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('payment_detection'),
      reportId: id,
      reportVersion: z.number().int().min(0),
      originalContent: z.string().min(1).max(10000),
      payment: paymentProposalSchema,
    })
    .strict(),
]);
export type ReviewProposal = z.infer<typeof reviewProposalSchema>;
export const reviewConfirmedSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('report_classification'),
      classification: reportClassificationSchema.refine(
        (x) => x.status !== 'needs_review',
        { message: 'Choose a final report status before approving.' },
      ),
    })
    .strict(),
  z.object({ type: z.literal('case_match'), selectedCaseId: id }).strict(),
  z
    .object({
      type: z.literal('image_extraction'),
      extraction: extractionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('payment_detection'),
      payment: paymentProposalSchema,
    })
    .strict(),
]);
export type ReviewConfirmed = z.infer<typeof reviewConfirmedSchema>;
const meta = {
  reason: z.string().trim().min(1).max(2000),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  confidence: z.number().min(0).max(1).nullable().default(null),
};
export const reviewCreateSchema = z.discriminatedUnion('reviewType', [
  z
    .object({
      ...meta,
      reviewType: z.literal('report_classification'),
      reportId: id,
      classification: reportClassificationSchema,
    })
    .strict(),
  z
    .object({
      ...meta,
      reviewType: z.literal('case_match'),
      query: caseLookupSchema,
    })
    .strict(),
  z
    .object({
      ...meta,
      reviewType: z.literal('image_extraction'),
      caseId: id,
      extraction: extractionSchema,
    })
    .strict(),
  z
    .object({
      ...meta,
      reviewType: z.literal('payment_detection'),
      reportId: id,
      payment: paymentProposalSchema,
    })
    .strict(),
]);
export const reviewResolveSchema = z
  .object({
    id,
    decision: z.enum(['approved', 'corrected', 'rejected']),
    expectedCaseVersion: z.number().int().min(0).optional(),
    confirmedData: reviewConfirmedSchema.optional(),
  })
  .strict();
export const reviewListSchema = z
  .object({
    page: z.number().int().min(1).max(100000).default(1),
    pageSize: z.number().int().min(1).max(50).default(10),
    reviewType: z.enum(REVIEW_TYPES).optional(),
    status: z.enum(REVIEW_STATUSES).optional().default('pending'),
    query: z.string().trim().max(120).default(''),
  })
  .strict();
