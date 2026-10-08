import { cases } from '@saasflare-dev/db';
import { and, asc, sql } from 'drizzle-orm';
import { caseVisibility } from './case-access';
import type { Context } from './context';
import { type IntakeProposal, intakeProposalSchema } from './intake-contract';
import { requirePermission } from './permissions';
export function normalizedAddress(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}
export class CaseMatchingService {
  async match(
    context: Context,
    proposal: IntakeProposal,
    caseNo: string | null = null,
  ) {
    requirePermission(context, 'case.view');
    proposal = intakeProposalSchema.parse(proposal);
    const fields = [
      ['case_no', caseNo, cases.caseNo],
      ['code', proposal.code, cases.code],
      ['customer_name', proposal.customer_name, cases.customerName],
    ] as const;
    for (const [method, value, column] of fields) {
      if (!value) continue;
      const rows = await context.DB.select({
        id: cases.id,
        caseNo: cases.caseNo,
        code: cases.code,
        customerName: cases.customerName,
        address: cases.address,
        version: cases.version,
      })
        .from(cases)
        .where(
          and(
            caseVisibility(context),
            sql`${column}=${value} COLLATE NOCASE`,
            method === 'customer_name' && proposal.code
              ? sql`(trim(${cases.code})='' OR ${cases.code}=${proposal.code} COLLATE NOCASE)`
              : undefined,
          ),
        )
        .orderBy(asc(cases.id))
        .limit(51);
      if (!rows.length) continue;
      const truncated = rows.length > 50;
      // Address is advisory: disagreement or missing code requires explicit review.
      const strong =
        method === 'case_no' ||
        (method === 'code' &&
          rows.every(
            (row) =>
              (!proposal.customer_name ||
                row.customerName.toLowerCase() ===
                  proposal.customer_name.toLowerCase()) &&
              (!proposal.address ||
                normalizedAddress(row.address) ===
                  normalizedAddress(proposal.address)),
          ));
      return {
        kind:
          rows.length === 1 && !truncated && strong
            ? ('unique_match' as const)
            : ('ambiguous' as const),
        candidates: rows.slice(0, 50),
        method,
        truncated,
      };
    }
    return {
      kind: 'no_match' as const,
      candidates: [],
      method: 'none',
      truncated: false,
    };
  }
}
