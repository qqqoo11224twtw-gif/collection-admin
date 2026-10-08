import { ORPCError } from '@orpc/server';
import { intakeItems } from '@saasflare-dev/db';
import { and, eq, or, type SQL, sql } from 'drizzle-orm';
import { CaseMatchingService } from './case-matching';
import type { Context } from './context';
import { intakeProposalSchema, intakeReceiveSchema } from './intake-contract';
import { permissionPolicy, requirePermission } from './permissions';
import { type ReviewProposal, reviewProposalSchema } from './review-contract';
export function intakeVisibility(context: Context): SQL | undefined {
  requirePermission(context, 'intake.view');
  return permissionPolicy(context).scope === 'all'
    ? undefined
    : sql`${intakeItems.createdByUserId}=${context.user?.id} AND (${intakeItems.matchedCaseId} IS NULL OR EXISTS(SELECT 1 FROM assignments a JOIN collectors c ON c.id=a.collector_id WHERE a.case_id=${intakeItems.matchedCaseId} AND a.unassigned_at IS NULL AND c.is_active=1 AND c.user_id=${context.user?.id}))`;
}
export async function requireIntake(
  context: Context,
  id: string,
  permission:
    | 'intake.view'
    | 'intake.create'
    | 'intake.resolve'
    | 'intake.reject' = 'intake.view',
) {
  requirePermission(context, permission);
  const [row] = await context.DB.select()
    .from(intakeItems)
    .where(and(eq(intakeItems.id, id), intakeVisibility(context)))
    .limit(1);
  if (!row) throw new ORPCError('NOT_FOUND');
  return row;
}
export function intakeAudit(
  context: Context,
  id: string,
  action: string,
  metadata: {
    mediaIds?: string[];
    count?: number;
    caseId?: string | null;
    reviewId?: string;
    entityId?: string | null;
  },
  token?: string,
) {
  return context.env.DB.prepare(
    `INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,?,'intake',?,?,? WHERE EXISTS(SELECT 1 FROM intake_items WHERE id=?${token ? ' AND write_token=?' : ''})`,
  ).bind(
    crypto.randomUUID(),
    context.user?.id ?? null,
    action,
    id,
    JSON.stringify(metadata),
    Date.now(),
    id,
    ...(token ? [token] : []),
  );
}
export async function receiveIntake(context: Context, raw: unknown) {
  requirePermission(context, 'intake.create');
  const input = intakeReceiveSchema.parse(raw);
  if (input.source !== 'manual' && input.source !== 'api')
    requirePermission(context, 'intake.resolve');
  const find = async () => {
    if (!input.externalId && !input.dedupeKey) return [];
    return context.DB.select()
      .from(intakeItems)
      .where(
        and(
          eq(intakeItems.source, input.source),
          or(
            input.externalId
              ? eq(intakeItems.externalId, input.externalId)
              : undefined,
            input.dedupeKey
              ? eq(intakeItems.dedupeKey, input.dedupeKey)
              : undefined,
          ),
        ),
      )
      .limit(2);
  };
  const replay = async (existing: (typeof intakeItems.$inferSelect)[]) => {
    if (existing.length !== 1) throw new ORPCError('CONFLICT');
    const row = await requireIntake(context, existing[0].id);
    if (
      JSON.stringify(
        intakeProposalSchema.parse(JSON.parse(row.proposedData)),
      ) !== JSON.stringify(input.proposedData) ||
      row.caseNoHint !== input.caseNo ||
      row.confidence !== input.confidence
    )
      throw new ORPCError('CONFLICT', {
        message: 'The dedupe identity has different content.',
      });
    await context.env.DB.batch([
      intakeAudit(context, row.id, 'intake.duplicate_detected', {}),
    ]);
    return { id: row.id, duplicate: true };
  };
  const existing = await find();
  if (existing.length) return replay(existing);
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const now = Date.now();
  const result = await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO intake_items(id,source,external_id,dedupe_key,status,proposed_data,created_by_user_id,created_at,updated_at,write_token,case_no_hint,confidence) VALUES(?,?,?,?,'received',?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    ).bind(
      id,
      input.source,
      input.externalId,
      input.dedupeKey,
      JSON.stringify(input.proposedData),
      context.user?.id ?? null,
      now,
      now,
      token,
      input.caseNo,
      input.confidence,
    ),
    intakeAudit(context, id, 'intake.received', {}, token),
  ]);
  if (result[0].meta.changes !== 1) return replay(await find());
  return { id, duplicate: false };
}
export async function intakeMatching(
  context: Context,
  row: typeof intakeItems.$inferSelect,
  proposal = intakeProposalSchema.parse(JSON.parse(row.proposedData)),
) {
  return new CaseMatchingService().match(context, proposal, row.caseNoHint);
}
export function intakeReviewBatch(
  context: Context,
  row: typeof intakeItems.$inferSelect,
  proposal: ReviewProposal,
  token: string,
) {
  proposal = reviewProposalSchema.parse(proposal);
  const reviewId = crypto.randomUUID();
  const now = Date.now();
  const reason =
    proposal.type === 'case_match'
      ? 'Case identity or address requires a human choice.'
      : 'Incomplete or uncertain extraction requires confirmation.';
  const source =
    row.source === 'telegram'
      ? 'telegram'
      : row.source === 'historical_import'
        ? 'historical_import'
        : 'manual';
  return {
    reviewId,
    statements: [
      context.env.DB.prepare(
        "INSERT INTO review_items(id,review_type,entity_type,entity_id,status,priority,source,proposed_data,reason,confidence,created_by_user_id,created_at,dedupe_key) SELECT ?,?,'intake',?,'pending','normal',?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM intake_items WHERE id=? AND write_token=?)",
      ).bind(
        reviewId,
        proposal.type,
        row.id,
        source,
        JSON.stringify(proposal),
        reason,
        row.confidence,
        context.user?.id ?? null,
        now,
        `intake:${row.id}:${row.version + 1}`,
        row.id,
        token,
      ),
      context.env.DB.prepare(
        'UPDATE intake_items SET review_item_id=? WHERE id=? AND write_token=?',
      ).bind(reviewId, row.id, token),
      intakeAudit(
        context,
        row.id,
        'intake.sent_to_review',
        { reviewId },
        token,
      ),
      context.env.DB.prepare(
        "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,'review.created','review',?,?,? WHERE EXISTS(SELECT 1 FROM review_items WHERE id=?)",
      ).bind(
        crypto.randomUUID(),
        context.user?.id ?? null,
        reviewId,
        JSON.stringify({ reviewId, entityId: row.id }),
        now,
        reviewId,
      ),
    ],
  };
}
