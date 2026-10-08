import { INTAKE_SOURCES, INTAKE_STATUSES } from '@saasflare-dev/db';
import { z } from 'zod';
export const intakeProposalSchema = z
  .object({
    code: z.string().trim().min(1).max(60).nullable(),
    customer_name: z.string().trim().min(1).max(120).nullable(),
    address: z.string().trim().min(1).max(500).nullable(),
    amount_due: z.number().int().min(0).max(1_000_000_000_000).nullable(),
  })
  .strict();
export type IntakeProposal = z.infer<typeof intakeProposalSchema>;
export const intakeConfirmedSchema = z
  .object({
    code: z.string().trim().min(1).max(60),
    customer_name: z.string().trim().min(1).max(120),
    address: z.string().trim().min(1).max(500),
    amount_due: z.number().int().min(0).max(1_000_000_000_000),
  })
  .strict();
export const intakeReceiveSchema = z
  .object({
    source: z.enum(INTAKE_SOURCES).default('manual'),
    externalId: z.string().trim().min(1).max(200).nullable().default(null),
    dedupeKey: z.string().trim().min(1).max(200).nullable().default(null),
    proposedData: intakeProposalSchema,
    caseNo: z.string().trim().min(1).max(60).nullable().default(null),
    confidence: z.number().min(0).max(1).nullable().default(null),
  })
  .strict();
export const intakeResolveSchema = z
  .object({
    id: z.string().min(1).max(128),
    expectedVersion: z.number().int().min(0),
    action: z.enum(['create', 'match', 'review', 'reject']),
    caseId: z.string().min(1).max(128).optional(),
    confirmedData: intakeConfirmedSchema.optional(),
  })
  .strict()
  .refine((value) => value.action === 'match' || value.caseId === undefined, {
    message: 'Only matching accepts a candidate case ID.',
  });
export const intakeListSchema = z
  .object({
    page: z.number().int().min(1).max(100000).default(1),
    pageSize: z.number().int().min(1).max(50).default(10),
    status: z.enum(INTAKE_STATUSES).optional(),
    source: z.enum(INTAKE_SOURCES).optional(),
    query: z.string().trim().max(120).default(''),
  })
  .strict();
export const extractionOutputSchema = intakeProposalSchema
  .extend({ confidence: z.number().min(0).max(1) })
  .strict();
export interface ImageExtractionProvider {
  extract(input: { mediaId: string }): Promise<unknown>;
}
export async function validatedExtraction(
  provider: ImageExtractionProvider,
  input: { mediaId: string },
) {
  return extractionOutputSchema.parse(await provider.extract(input));
}
export interface IntakeSourceAdapter {
  readonly source: (typeof INTAKE_SOURCES)[number];
  normalize(event: unknown): Promise<unknown>;
}
// The adapter's only write capability is a receiver, never a database connection.
export interface IntakeReceiver {
  receive(
    input: z.infer<typeof intakeReceiveSchema>,
  ): Promise<{ id: string; duplicate: boolean }>;
}
export async function receiveFromAdapter(
  adapter: IntakeSourceAdapter,
  event: unknown,
  receiver: IntakeReceiver,
) {
  const payload = intakeReceiveSchema.parse({
    ...intakeReceiveSchema.parse(await adapter.normalize(event)),
    source: adapter.source,
  });
  return receiver.receive(payload);
}

export function extractionToIntake(
  raw: unknown,
  source: z.infer<typeof intakeReceiveSchema>['source'] = 'api',
  externalId: string | null = null,
) {
  const { confidence, ...proposedData } = extractionOutputSchema.parse(raw);
  return intakeReceiveSchema.parse({
    source,
    externalId,
    proposedData,
    confidence,
  });
}

export const INTAKE_DRAFT_CONFIDENCE_THRESHOLD = 0.8;
