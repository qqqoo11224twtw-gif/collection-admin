import {
  CASE_SOURCES,
  CASE_STATUSES,
  REVISIT_STATUSES,
} from '@saasflare-dev/db';
import { z } from 'zod';

export const caseInputSchema = z.object({
  caseNo: z.string().trim().min(1).max(60),
  code: z.string().trim().min(1).max(60),
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
  page: z.number().int().min(1).max(100000).default(1),
  pageSize: z.number().int().min(1).max(50).default(10),
  query: z.string().trim().max(120).default(''),
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
