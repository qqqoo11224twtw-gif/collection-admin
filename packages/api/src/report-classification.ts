import { REPORT_REVISIT_STATUSES, REPORT_STATUSES } from '@saasflare-dev/db';
import { z } from 'zod';

export const reportClassificationSchema = z
  .object({
    status: z.enum(REPORT_STATUSES),
    revisit_status: z.enum(REPORT_REVISIT_STATUSES).nullable(),
    revisit_reason: z.string().trim().max(2000).nullable(),
    payment_detected: z.boolean(),
    payment_amount: z.number().int().min(0).max(1_000_000_000_000).nullable(),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .refine((value) => value.payment_detected || value.payment_amount === null, {
    message: 'Payment amount requires a payment marker.',
  });
export type ReportClassification = z.infer<typeof reportClassificationSchema>;
export interface ReportClassificationProvider {
  classify(input: {
    content: string;
    manual: ReportClassification;
  }): Promise<unknown>;
}
// Providers return data only. Validation is mandatory before any persistence.
export class ManualClassifier implements ReportClassificationProvider {
  async classify(input: { content: string; manual: ReportClassification }) {
    return reportClassificationSchema.parse(input.manual);
  }
}
export async function classifyReport(
  provider: ReportClassificationProvider,
  input: { content: string; manual: ReportClassification },
) {
  return reportClassificationSchema.parse(await provider.classify(input));
}
export const reportFieldsSchema = z.object({
  content: z.string().trim().min(1).max(10000),
  status: z.enum(REPORT_STATUSES),
  revisitStatus: z.enum(REPORT_REVISIT_STATUSES).nullable(),
  revisitReason: z.string().trim().max(2000).nullable(),
  paymentDetected: z.boolean(),
  paymentAmount: z.number().int().min(0).max(1_000_000_000_000).nullable(),
});
const paymentValid = (value: {
  paymentDetected: boolean;
  paymentAmount: number | null;
}) => value.paymentDetected || value.paymentAmount === null;
export const reportCreateSchema = reportFieldsSchema
  .extend({
    caseId: z.string().min(1).max(128),
    expectedCaseVersion: z.number().int().min(0),
  })
  .strict()
  .refine(paymentValid, {
    message: 'Payment amount requires a payment marker.',
  });
export const reportEditSchema = reportFieldsSchema
  .extend({
    id: z.string().min(1).max(128),
    caseId: z.string().min(1).max(128),
    expectedVersion: z.number().int().min(0),
    expectedCaseVersion: z.number().int().min(0),
  })
  .strict()
  .refine(paymentValid, {
    message: 'Payment amount requires a payment marker.',
  });
export type ReportFields = z.infer<typeof reportFieldsSchema>;
const STATUS_MAPPING = {
  cannot_find: 'follow_up',
  follow_up: 'follow_up',
  installment: 'installment',
  settled: 'settled',
  unresolved: 'unresolved',
  needs_review: null,
} as const;
export function reportCaseStatus(status: ReportClassification['status']) {
  return STATUS_MAPPING[status];
}
