import { cases } from '@saasflare-dev/db';
import { and, asc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { caseVisibility } from './case-access';
import type { Context } from './context';
import { requirePermission } from './permissions';

export const caseLookupSchema = z
  .object({
    field: z.enum(['customer_name', 'code', 'case_no']),
    value: z.string().trim().min(1).max(120),
  })
  .strict();
// Exact, parameterized lookup within the caller's case scope. Never pick the first match.
export async function lookupCase(
  context: Context,
  input: z.infer<typeof caseLookupSchema>,
) {
  requirePermission(context, 'case.view');
  input = caseLookupSchema.parse(input);
  const column = {
    customer_name: cases.customerName,
    code: cases.code,
    case_no: cases.caseNo,
  }[input.field];
  const candidates = await context.DB.select({
    id: cases.id,
    customerName: cases.customerName,
    code: cases.code,
    caseNo: cases.caseNo,
  })
    .from(cases)
    .where(
      and(
        caseVisibility(context),
        sql`${column} = ${input.value} COLLATE NOCASE`,
      ),
    )
    .orderBy(asc(cases.id))
    .limit(51);
  if (!candidates.length)
    return { kind: 'not_found' as const, candidates: [], truncated: false };
  return {
    kind:
      candidates.length === 1 ? ('matched' as const) : ('ambiguous' as const),
    candidates: candidates.slice(0, 50),
    truncated: candidates.length > 50,
  };
}
