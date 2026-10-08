import { ORPCError } from '@orpc/server';
import type { reviewItems } from '@saasflare-dev/db';

import { atomicCaseWrite } from './audit';
import { requireCaseAccess } from './case-access';
import { generateCaseNumber } from './case-number';
import type { Context } from './context';
import {
  INTAKE_DRAFT_CONFIDENCE_THRESHOLD,
  intakeConfirmedSchema,
  intakeProposalSchema,
  intakeResolveSchema,
} from './intake-contract';
import { prepareIntakePromotion } from './intake-promotion';
import {
  intakeAudit,
  intakeMatching,
  intakeReviewBatch,
  requireIntake,
} from './intake-service';
import { requirePermission } from './permissions';
import type { ReviewConfirmed, ReviewProposal } from './review-contract';

const sourceMap = {
  manual: 'manual',
  api: 'manual',
  line: 'manual',
  telegram: 'telegram_ai',
  poster_builder: 'poster_builder',
  historical_import: 'historical_import',
} as const;
function pendingReviewFinal(
  context: Context,
  reviewId: string,
  decision: string,
  confirmed: ReviewConfirmed | null,
  token: string,
  caseId: string | null,
  entityId: string,
) {
  const now = Date.now();
  return [
    context.env.DB.prepare(
      "UPDATE review_items SET status=?,confirmed_data=?,case_id=?,resolved_by_user_id=?,resolved_at=?,version=version+1,write_token=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM intake_items WHERE review_item_id=? AND write_token=?)",
    ).bind(
      decision,
      confirmed ? JSON.stringify(confirmed) : null,
      caseId,
      context.user?.id,
      now,
      token,
      reviewId,
      reviewId,
      token,
    ),
    context.env.DB.prepare(
      "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,?,'review',?,?,? WHERE EXISTS(SELECT 1 FROM review_items WHERE id=? AND write_token=?)",
    ).bind(
      crypto.randomUUID(),
      context.user?.id,
      `review.${decision}`,
      reviewId,
      JSON.stringify({ reviewId, entityId }),
      now,
      reviewId,
      token,
    ),
  ];
}
export async function resolveIntake(
  context: Context,
  raw: unknown,
  review?: {
    id: string;
    decision: 'approved' | 'corrected' | 'rejected';
    confirmed: ReviewConfirmed | null;
  },
) {
  const input = intakeResolveSchema.parse(raw);
  const row = await requireIntake(
    context,
    input.id,
    input.action === 'reject' ? 'intake.reject' : 'intake.resolve',
  );
  if (input.action === 'reject' && row.reviewItemId)
    requirePermission(context, 'review.resolve');
  if (['created', 'matched', 'rejected'].includes(row.status)) {
    const same =
      row.status === 'created'
        ? input.action === 'create'
        : row.status === 'matched'
          ? input.action === 'match' &&
            (!input.caseId || row.matchedCaseId === input.caseId)
          : input.action === 'reject';
    if (!same) throw new ORPCError('CONFLICT');
    if (
      input.confirmedData &&
      JSON.stringify(input.confirmedData) !==
        JSON.stringify(row.confirmedData ? JSON.parse(row.confirmedData) : null)
    )
      throw new ORPCError('CONFLICT');
    return {
      id: row.id,
      status: row.status,
      caseId: row.matchedCaseId,
      alreadyProcessed: true,
    };
  }
  if (row.version !== input.expectedVersion) throw new ORPCError('CONFLICT');
  if (row.source === 'telegram' && input.action !== 'reject') {
    const collecting = await context.env.DB.prepare(
      "SELECT id FROM telegram_albums WHERE intake_id=? AND finalized_at IS NULL UNION ALL SELECT id FROM telegram_updates WHERE intake_id=? AND status<>'done' LIMIT 1",
    )
      .bind(row.id, row.id)
      .first();
    if (collecting)
      throw new ORPCError('CONFLICT', {
        message: 'Telegram intake is still collecting attachments.',
      });
  }
  if (row.status === 'needs_review' && !review && input.action !== 'reject')
    throw new ORPCError('CONFLICT', {
      message: 'Resolve this item in the review center.',
    });
  if (
    review &&
    (row.reviewItemId !== review.id || row.status !== 'needs_review')
  )
    throw new ORPCError('CONFLICT');
  const token = crypto.randomUUID();
  const now = Date.now();
  const proposed = intakeProposalSchema.parse(JSON.parse(row.proposedData));
  const confirmed =
    input.confirmedData ?? intakeConfirmedSchema.safeParse(proposed).data;
  const matching = await intakeMatching(context, row, confirmed ?? proposed);
  const originalMatching =
    !review && input.confirmedData
      ? await intakeMatching(context, row, proposed)
      : matching;
  if (
    (matching.truncated || originalMatching.truncated) &&
    input.action !== 'reject'
  )
    throw new ORPCError('CONFLICT', {
      message: 'Too many candidates. Narrow the draft before resolving.',
    });
  const refreshed = await requireIntake(context, row.id);
  if (
    refreshed.version !== row.version &&
    ['created', 'matched', 'rejected'].includes(refreshed.status)
  )
    return resolveIntake(context, input, review);
  let reviewProposal: ReviewProposal | undefined;
  if (
    input.action === 'review' ||
    (input.action !== 'reject' &&
      (matching.kind === 'ambiguous' ||
        originalMatching.kind === 'ambiguous') &&
      !review)
  ) {
    if (matching.truncated)
      throw new ORPCError('CONFLICT', {
        message: 'Too many candidates. Narrow the intake before matching.',
      });
    const ambiguousMatching =
      originalMatching.kind === 'ambiguous' ? originalMatching : matching;
    reviewProposal =
      ambiguousMatching.kind === 'ambiguous'
        ? {
            type: 'case_match' as const,
            query: {
              field: 'customer_name' as const,
              value:
                proposed.customer_name ?? proposed.code ?? 'Uncertain intake',
            },
            candidateCaseIds: ambiguousMatching.candidates.map((c) => c.id),
          }
        : {
            type: 'image_extraction' as const,
            extraction: proposed,
            intakeId: row.id,
          };
  }
  if (
    input.action !== 'reject' &&
    (!confirmed ||
      (row.confidence !== null &&
        row.confidence < INTAKE_DRAFT_CONFIDENCE_THRESHOLD &&
        !review)) &&
    !reviewProposal
  )
    reviewProposal = {
      type: 'image_extraction' as const,
      extraction: proposed,
      intakeId: row.id,
    };
  if (
    review &&
    review.confirmed?.type === 'image_extraction' &&
    matching.kind === 'ambiguous'
  )
    reviewProposal = {
      type: 'case_match' as const,
      query: {
        field: 'customer_name' as const,
        value: confirmed?.customer_name ?? 'Intake',
      },
      candidateCaseIds: matching.candidates.map((c) => c.id),
    };
  if (reviewProposal) {
    const pending = intakeReviewBatch(context, row, reviewProposal, token);
    const statements = [
      context.env.DB.prepare(
        "UPDATE intake_items SET status='needs_review',updated_at=?,version=version+1,write_token=? WHERE id=? AND version=?",
      ).bind(now, token, row.id, row.version),
    ];
    if (review)
      statements.push(
        ...pendingReviewFinal(
          context,
          review.id,
          review.decision,
          review.confirmed,
          token,
          null,
          row.id,
        ),
      );
    statements.push(...pending.statements);
    await atomicCaseWrite(context, statements);
    return {
      id: row.id,
      status: 'needs_review',
      reviewId: pending.reviewId,
      caseId: null,
      alreadyProcessed: false,
    };
  }
  if (input.action === 'reject') {
    const statements = [
      context.env.DB.prepare(
        "UPDATE intake_items SET status='rejected',processed_at=?,updated_at=?,version=version+1,write_token=? WHERE id=? AND version=?",
      ).bind(now, now, token, row.id, row.version),
    ];
    if (review)
      statements.push(
        ...pendingReviewFinal(
          context,
          review.id,
          'rejected',
          null,
          token,
          null,
          row.id,
        ),
      );
    else if (row.reviewItemId)
      statements.push(
        ...pendingReviewFinal(
          context,
          row.reviewItemId,
          'rejected',
          null,
          token,
          null,
          row.id,
        ),
      );
    statements.push(intakeAudit(context, row.id, 'intake.rejected', {}, token));
    await atomicCaseWrite(context, statements);
    return {
      id: row.id,
      status: 'rejected',
      caseId: null,
      alreadyProcessed: false,
    };
  }
  if (!confirmed) throw new ORPCError('BAD_REQUEST');
  intakeConfirmedSchema.parse(confirmed);
  const create = input.action === 'create';
  if (create && matching.kind !== 'no_match')
    throw new ORPCError('CONFLICT', {
      message: 'A matching case exists. Confirm a match instead.',
    });
  if (!create && !input.caseId) throw new ORPCError('BAD_REQUEST');
  if (!create && matching.kind === 'ambiguous' && !review)
    throw new ORPCError('CONFLICT');
  if (!create && !matching.candidates.some((c) => c.id === input.caseId))
    throw new ORPCError('BAD_REQUEST', {
      message: 'Select an authorized matching candidate.',
    });
  if (create) requirePermission(context, 'case.create');
  const caseId = create ? crypto.randomUUID() : (input.caseId ?? '');
  const existing = create ? null : await requireCaseAccess(context, caseId);
  const media = await context.env.DB.prepare(
    'SELECT count(*) AS n FROM intake_media WHERE intake_id=? AND promoted_at IS NULL',
  )
    .bind(row.id)
    .first<{ n: number }>();
  if ((media?.n ?? 0) > 0) requirePermission(context, 'media.upload');
  const promotion = await prepareIntakePromotion(
    context,
    row.id,
    caseId,
    token,
    create,
  );
  const guard = existing
    ? ' AND EXISTS(SELECT 1 FROM cases WHERE id=? AND version=?)'
    : '';
  const status = create ? 'created' : 'matched';
  const collectionGuard =
    row.source === 'telegram'
      ? " AND NOT EXISTS(SELECT 1 FROM telegram_albums collecting WHERE collecting.intake_id=intake_items.id AND collecting.finalized_at IS NULL) AND NOT EXISTS(SELECT 1 FROM telegram_updates pending WHERE pending.intake_id=intake_items.id AND pending.status<>'done')"
      : '';
  // Insert the case before setting the FK in intake, while the case insert is guarded by the draft version.
  const statements: D1PreparedStatement[] = [];
  if (create)
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO cases(id,case_no,code,customer_name,address,amount_due,status,revisit_status,revisit_reason,source,created_at,updated_at,write_token) SELECT ?,?,?,?,?,?,'pending','pending','',?,?,?,? WHERE EXISTS(SELECT 1 FROM intake_items WHERE id=? AND version=? AND status IN ('received','processing','failed','needs_review')${collectionGuard})`,
      ).bind(
        caseId,
        generateCaseNumber(caseId, now),
        confirmed.code,
        confirmed.customer_name,
        confirmed.address,
        confirmed.amount_due,
        sourceMap[row.source],
        now,
        now,
        token,
        row.id,
        row.version,
      ),
    );
  statements.push(
    context.env.DB.prepare(
      `UPDATE intake_items SET status=?,confirmed_data=?,matched_case_id=?,processed_at=?,updated_at=?,version=version+1,write_token=? WHERE id=? AND version=?${guard}${collectionGuard}`,
    ).bind(
      status,
      JSON.stringify(confirmed),
      caseId,
      now,
      now,
      token,
      row.id,
      row.version,
      ...(existing ? [caseId, existing.version] : []),
    ),
  );
  if (existing && promotion.count > 0)
    statements.push(
      context.env.DB.prepare(
        'UPDATE cases SET version=version+1,updated_at=?,write_token=? WHERE id=? AND EXISTS(SELECT 1 FROM intake_items WHERE id=? AND write_token=?)',
      ).bind(now, token, caseId, row.id, token),
    );
  statements.push(...promotion.statements);
  if (review)
    statements.push(
      ...pendingReviewFinal(
        context,
        review.id,
        review.decision,
        review.confirmed,
        token,
        caseId,
        row.id,
      ),
    );
  statements.push(
    intakeAudit(
      context,
      row.id,
      create ? 'intake.created_case' : 'intake.matched',
      { caseId },
      token,
    ),
  );
  if (promotion.count)
    statements.push(
      intakeAudit(
        context,
        row.id,
        'media.promoted',
        { caseId, count: promotion.count },
        token,
      ),
    );
  try {
    await atomicCaseWrite(context, statements);
  } catch (error: unknown) {
    await promotion.cleanup();
    const after = await requireIntake(context, row.id);
    if (
      after.status === status &&
      (create || after.matchedCaseId === caseId) &&
      (!input.confirmedData ||
        after.confirmedData === JSON.stringify(input.confirmedData))
    )
      return {
        id: row.id,
        status: after.status,
        caseId: after.matchedCaseId,
        alreadyProcessed: true,
      };
    throw error;
  }
  return { id: row.id, status, caseId, alreadyProcessed: false };
}
export async function resolveIntakeReview(
  context: Context,
  review: typeof reviewItems.$inferSelect,
  decision: 'approved' | 'corrected' | 'rejected',
  confirmed: ReviewConfirmed | null,
) {
  requirePermission(context, 'review.resolve');
  const row = await requireIntake(
    context,
    review.entityId ?? '',
    decision === 'rejected' ? 'intake.reject' : 'intake.resolve',
  );
  const proposal = intakeProposalSchema.parse(JSON.parse(row.proposedData));
  const matching = await intakeMatching(
    context,
    row,
    confirmed?.type === 'image_extraction' ? confirmed.extraction : proposal,
  );
  if (confirmed?.type === 'case_match') {
    const original = JSON.parse(review.proposedData) as {
      candidateCaseIds?: unknown;
    };
    if (
      !Array.isArray(original.candidateCaseIds) ||
      !original.candidateCaseIds.includes(confirmed.selectedCaseId)
    )
      throw new ORPCError('BAD_REQUEST');
    await requireCaseAccess(context, confirmed.selectedCaseId);
    if (!matching.candidates.some((c) => c.id === confirmed.selectedCaseId))
      throw new ORPCError('CONFLICT');
  }
  const action =
    decision === 'rejected'
      ? 'reject'
      : confirmed?.type === 'case_match' || matching.kind === 'unique_match'
        ? 'match'
        : matching.kind === 'ambiguous'
          ? 'review'
          : 'create';
  return resolveIntake(
    context,
    {
      id: row.id,
      expectedVersion: row.version,
      action,
      caseId:
        action !== 'match'
          ? undefined
          : confirmed?.type === 'case_match'
            ? confirmed.selectedCaseId
            : matching.candidates[0]?.id,
      confirmedData:
        confirmed?.type === 'image_extraction'
          ? confirmed.extraction
          : undefined,
    },
    { id: review.id, decision, confirmed },
  );
}

export async function processIntake(
  context: Context,
  input: { id: string; expectedVersion: number },
) {
  const row = await requireIntake(context, input.id, 'intake.resolve');
  if (row.version !== input.expectedVersion) throw new ORPCError('CONFLICT');
  const matching = await intakeMatching(context, row);
  if (['needs_review', 'created', 'matched', 'rejected'].includes(row.status))
    return { id: row.id, status: row.status, matching };
  if (
    matching.kind === 'ambiguous' ||
    !intakeConfirmedSchema.safeParse(JSON.parse(row.proposedData)).success ||
    (row.confidence !== null &&
      row.confidence < INTAKE_DRAFT_CONFIDENCE_THRESHOLD)
  )
    return {
      ...(await resolveIntake(context, {
        id: row.id,
        expectedVersion: row.version,
        action: 'review',
      })),
      matching,
    };
  const token = crypto.randomUUID();
  await atomicCaseWrite(context, [
    context.env.DB.prepare(
      "UPDATE intake_items SET status='processing',version=version+1,updated_at=?,write_token=? WHERE id=? AND version=?",
    ).bind(Date.now(), token, row.id, row.version),
    intakeAudit(context, row.id, 'intake.processing', {}, token),
  ]);
  return { id: row.id, status: 'processing', matching };
}
export async function promoteIntake(context: Context, id: string) {
  const row = await requireIntake(context, id, 'intake.resolve');
  if (!row.matchedCaseId || !['created', 'matched'].includes(row.status))
    throw new ORPCError('CONFLICT');
  await requireCaseAccess(context, row.matchedCaseId, 'media.upload');
  const count = await context.env.DB.prepare(
    'SELECT count(*) AS n FROM intake_media WHERE intake_id=? AND promoted_at IS NULL',
  )
    .bind(id)
    .first<{ n: number }>();
  if (!count?.n) return { count: 0, alreadyPromoted: true };
  const token = crypto.randomUUID();
  const c = await requireCaseAccess(context, row.matchedCaseId);
  const p = await prepareIntakePromotion(context, id, c.id, token);
  try {
    await atomicCaseWrite(context, [
      context.env.DB.prepare(
        'UPDATE intake_items SET version=version+1,updated_at=?,write_token=? WHERE id=? AND version=? AND matched_case_id=? AND EXISTS(SELECT 1 FROM cases WHERE id=? AND version=?)',
      ).bind(Date.now(), token, id, row.version, c.id, c.id, c.version),
      context.env.DB.prepare(
        'UPDATE cases SET version=version+1,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM intake_items WHERE id=? AND write_token=?)',
      ).bind(Date.now(), c.id, id, token),
      ...p.statements,
      intakeAudit(
        context,
        id,
        'media.promoted',
        { caseId: c.id, count: p.count },
        token,
      ),
    ]);
  } catch (error: unknown) {
    await p.cleanup();
    throw error;
  }
  return { count: p.count, alreadyPromoted: false };
}
