import {
  CASE_SOURCES,
  CASE_STATUSES,
  REGIONS,
  REVISIT_STATUSES,
} from '@saasflare-dev/db';
import { z } from 'zod';

export const caseInputSchema = z.object({
  caseNo: z.string().trim().min(1).max(60),
  code: z.string().trim().min(1).max(60),
  region: z.enum(REGIONS).nullable().default(null),
  customerName: z.string().trim().min(1).max(120),
  address: z.string().trim().min(1).max(500),
  amountDue: z.number().int().min(0).max(1_000_000_000_000),
  status: z.enum(CASE_STATUSES),
  revisitStatus: z.enum(REVISIT_STATUSES),
  revisitReason: z.string().trim().max(2000),
  source: z.enum(CASE_SOURCES),
  assignedAgentId: z.string().min(1).max(128).nullable(),
});

export const caseListSchema = z.object({
  voided: z.boolean().default(false),
  page: z.number().int().min(1).max(100000).default(1),
  pageSize: z.number().int().min(1).max(50).default(10),
  query: z.string().trim().max(120).default(''),
  region: z.enum(REGIONS).optional(),
  regionMissing: z.boolean().optional(),
  collectorId: z.string().min(1).max(128).optional(),
  assignmentStatus: z.enum(['assigned', 'unassigned']).optional(),
  status: z.enum(CASE_STATUSES).optional(),
});
export const caseIdSchema = z.object({ id: z.string().min(1).max(128) });
export const caseMediaInputSchema = z.object({
  caseId: z.string().min(1).max(128),
  storageKey: z
    .string()
    .min(1)
    .max(500)
    .refine(
      (key) =>
        !key.includes('..') && !key.startsWith('/') && !key.includes('://'),
    ),
  originalFilename: z.string().min(1).max(255),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  sortOrder: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const caseCreateSchema = caseInputSchema
  .omit({ caseNo: true, assignedAgentId: true })
  .extend({ duplicateOverride: z.boolean().default(false) })
  .strict();
export const caseEditSchema = caseCreateSchema
  .omit({ source: true, duplicateOverride: true })
  .extend({
    id: z.string().min(1).max(128),
    expectedVersion: z.number().int().min(0),
  })
  .strict();

export const manualCaseSchema = z
  .object({
    code: z.string().trim().min(1).max(60),
    customerName: z.string().trim().min(1).max(120),
    region: z.enum(REGIONS),
    idempotencyKey: z.string().uuid(),
    duplicateOverride: z.boolean().default(false),
    address: z.string().trim().min(1).max(500).default('Not recorded'),
    amountDue: z.number().int().min(0).max(1_000_000_000_000).default(0),
  })
  .strict();
export const assignmentCorrectionSchema = z
  .object({
    caseId: z.string().min(1).max(128),
    collectorId: z.string().min(1).max(128),
    expectedVersion: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export const collectorCreateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    code: z.string().trim().min(1).max(60),
    isActive: z.boolean(),
    userId: z.string().min(1).max(128).nullable(),
  })
  .strict();
export const collectorEditSchema = collectorCreateSchema
  .extend({
    id: z.string().min(1).max(128),
    expectedVersion: z.number().int().min(0),
  })
  .strict();
export const assignmentSchema = z
  .object({
    caseId: z.string().min(1).max(128),
    collectorId: z.string().min(1).max(128).nullable(),
    expectedVersion: z.number().int().min(0),
    note: z.string().trim().max(1000).nullable(),
  })
  .strict();
export const mediaDeleteSchema = z
  .object({
    caseId: z.string().min(1).max(128),
    mediaId: z.string().min(1).max(128),
    expectedVersion: z.number().int().min(0),
  })
  .strict();
export const mediaOrderSchema = z
  .object({
    caseId: z.string().min(1).max(128),
    ids: z.array(z.string().min(1).max(128)).min(1).max(100),
    expectedVersion: z.number().int().min(0),
  })
  .strict();
