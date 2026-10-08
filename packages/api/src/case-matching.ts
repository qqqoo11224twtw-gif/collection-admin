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
          and(caseVisibility(context), sql`${column}=${value} COLLATE NOCASE`),
        )
        .orderBy(asc(cases.id))
        .limit(51);
      if (!rows.length) {
        continue;
      }
      const truncated = rows.length > 50;
      const addressMatches = proposal.address
        ? rows.filter(
            (row) =>
              normalizedAddress(row.address) ===
              normalizedAddress(proposal.address ?? ''),
          )
        : [];
      const candidates =
        rows.length > 1 && addressMatches.length > 0 && !truncated
          ? addressMatches
          : rows;
      return {
        kind:
          candidates.length === 1 && !truncated
            ? ('unique_match' as const)
            : ('ambiguous' as const),
        candidates: candidates.slice(0, 50),
        method:
          addressMatches.length > 0 && rows.length > 1
            ? `${method}+address`
            : method,
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
