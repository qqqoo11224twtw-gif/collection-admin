import { ORPCError } from '@orpc/server';
import { reports, reviewItems, user } from '@saasflare-dev/db';
import { desc, eq, sql } from 'drizzle-orm';
import { atomicCaseWrite } from './audit';
import { requireCaseAccess } from './case-access';
import { lookupCase } from './case-lookup';
import type { Context } from './context';
import { resolveIntakeReview } from './intake-resolver';
import { requireIntake } from './intake-service';
import { permissionPolicy, requirePermission } from './permissions';
import { type ReportFields, reportCaseStatus } from './report-classification';
import {
  extractionSchema,
  type ReviewConfirmed,
  type ReviewProposal,
  reviewConfirmedSchema,
  reviewCreateSchema,
  reviewProposalSchema,
  reviewResolveSchema,
} from './review-contract';

type ReviewSource = 'manual' | 'ai' | 'telegram' | 'historical_import';
export function reviewAuditStatement(
  context: Context,
  id: string,
  action: 'created' | 'approved' | 'corrected' | 'rejected',
  caseId: string | null,
  entityId: string | null,
  token?: string,
) {
  return context.env.DB.prepare(
    `INSERT INTO audit_logs (id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM review_items WHERE id=?${token ? ' AND write_token=?' : ''})`,
  ).bind(
    crypto.randomUUID(),
    context.user?.id ?? null,
    `review.${action}`,
    caseId ? 'case' : 'review',
    caseId ?? id,
    JSON.stringify({ reviewId: id, entityId }),
    Date.now(),
    id,
    ...(token ? [token] : []),
  );
}
function reviewInsert(
  context: Context,
  entry: {
    id: string;
    proposal: ReviewProposal;
    caseId: string | null;
    entityId: string | null;
    reason: string;
    priority: string;
    confidence: number | null;
    source: ReviewSource;
    dedupeKey: string;
  },
  caseToken?: string,
) {
  const proposal = reviewProposalSchema.parse(entry.proposal);
  return context.env.DB.prepare(
    `INSERT INTO review_items (id,review_type,entity_type,entity_id,case_id,status,priority,source,proposed_data,reason,confidence,created_by_user_id,created_at,dedupe_key) SELECT ?,?,?,?,?,'pending',?,?,?,?,?,?,?,?${caseToken ? ' WHERE EXISTS (SELECT 1 FROM cases WHERE id=? AND write_token=?)' : ''}`,
  ).bind(
    entry.id,
    proposal.type,
    proposal.type === 'case_match'
      ? 'intake'
      : proposal.type === 'image_extraction'
        ? 'case'
        : 'report',
    entry.entityId,
    entry.caseId,
    entry.priority,
    entry.source,
    JSON.stringify(proposal),
    entry.reason,
    entry.confidence,
    context.user?.id ?? null,
    Date.now(),
    entry.dedupeKey,
    ...(caseToken ? [entry.caseId, caseToken] : []),
  );
}
export function pendingReportReviewStatements(
  context: Context,
  reportId: string,
  caseId: string,
  reportVersion: number,
  fields: ReportFields,
  caseToken: string,
  source: ReviewSource = 'manual',
) {
  const id = crypto.randomUUID();
  const proposal: ReviewProposal = {
    type: 'report_classification',
    reportId,
    reportVersion,
    originalContent: fields.content,
    classification: {
      status: fields.status,
      revisit_status: fields.revisitStatus,
      revisit_reason: fields.revisitReason,
      payment_detected: fields.paymentDetected,
      payment_amount: fields.paymentAmount,
      confidence: 1,
    },
  };
  return [
    reviewInsert(
      context,
      {
        id,
        proposal,
        caseId,
        entityId: reportId,
        reason:
          'Report requires manual classification before updating the case.',
        priority: 'normal',
        confidence: null,
        source,
        dedupeKey: `report_classification:${reportId}:${reportVersion}`,
      },
      caseToken,
    ),
    reviewAuditStatement(context, id, 'created', caseId, reportId),
  ];
}
// Authenticated adapters submit typed proposals; they never receive SQL capability from a provider.
export async function createReview(
  context: Context,
  raw: unknown,
  source: ReviewSource = 'manual',
) {
  requirePermission(context, 'review.view');
  const input = reviewCreateSchema.parse(raw);
  let proposal: ReviewProposal;
  let caseId: string | null = null;
  let entityId: string | null = null;
  if (input.reviewType === 'case_match') {
    const found = await lookupCase(context, input.query);
    if (found.kind !== 'ambiguous' || found.truncated)
      throw new ORPCError('BAD_REQUEST', {
        message:
          'An untruncated ambiguous lookup is required. Narrow the lookup if necessary.',
      });
    proposal = {
      type: 'case_match',
      query: input.query,
      candidateCaseIds: found.candidates.map((c) => c.id),
    };
  } else if (input.reviewType === 'image_extraction') {
    await requireCaseAccess(context, input.caseId, 'case.edit');
    caseId = input.caseId;
    entityId = input.caseId;
    proposal = { type: 'image_extraction', extraction: input.extraction };
  } else {
    requirePermission(context, 'report.edit');
    const [report] = await context.DB.select()
      .from(reports)
      .where(eq(reports.id, input.reportId))
      .limit(1);
    if (!report) throw new ORPCError('NOT_FOUND');
    if (report.workflowStatus === 'awaiting_status')
      throw new ORPCError('CONFLICT', {
        message: 'The collector must select this report status first.',
      });
    await requireCaseAccess(context, report.caseId);
    caseId = report.caseId;
    entityId = report.id;
    proposal =
      input.reviewType === 'report_classification'
        ? {
            type: 'report_classification',
            reportId: report.id,
            reportVersion: report.version,
            originalContent: report.content,
            classification: input.classification,
          }
        : {
            type: 'payment_detection',
            reportId: report.id,
            reportVersion: report.version,
            originalContent: report.content,
            payment: input.payment,
          };
  }
  const id = crypto.randomUUID();
  await atomicCaseWrite(context, [
    reviewInsert(context, {
      id,
      proposal,
      caseId,
      entityId,
      reason: input.reason,
      priority: input.priority,
      confidence: input.confidence,
      source,
      dedupeKey: id,
    }),
    reviewAuditStatement(context, id, 'created', caseId, entityId),
  ]);
  return { id };
}
export async function getReview(context: Context, id: string) {
  requirePermission(context, 'review.view');
  const [row] = await context.DB.select()
    .from(reviewItems)
    .where(eq(reviewItems.id, id))
    .limit(1);
  if (!row) throw new ORPCError('NOT_FOUND');
  const linkedIntake =
    row.entityType === 'intake' && row.entityId
      ? await requireIntake(context, row.entityId)
      : null;
  if (row.caseId) await requireCaseAccess(context, row.caseId);
  const proposal = reviewProposalSchema.parse(JSON.parse(row.proposedData));
  if (proposal.type !== row.reviewType) throw new ORPCError('BAD_REQUEST');
  if (
    (proposal.type === 'report_classification' ||
      proposal.type === 'payment_detection') &&
    (row.entityType !== 'report' ||
      row.entityId !== proposal.reportId ||
      !row.caseId)
  )
    throw new ORPCError('BAD_REQUEST');
  if (
    proposal.type === 'image_extraction' &&
    !linkedIntake &&
    (row.entityType !== 'case' || row.entityId !== row.caseId || !row.caseId)
  )
    throw new ORPCError('BAD_REQUEST');
  const candidates = [];
  if (proposal.type === 'case_match')
    for (const candidateId of proposal.candidateCaseIds) {
      try {
        const c = await requireCaseAccess(context, candidateId);
        candidates.push({
          id: c.id,
          customerName: c.customerName,
          caseNo: c.caseNo,
          code: c.code,
        });
      } catch (error: unknown) {
        if (!(error instanceof ORPCError) || error.code !== 'NOT_FOUND')
          throw error;
      }
    }
  const currentCase = row.caseId
    ? await requireCaseAccess(context, row.caseId)
    : null;
  if (
    proposal.type === 'case_match' &&
    permissionPolicy(context).scope === 'assigned' &&
    !candidates.length
  )
    throw new ORPCError('NOT_FOUND');
  const { writeToken: _token, dedupeKey: _key, ...safeRow } = row;
  const [resolver] = row.resolvedByUserId
    ? await context.DB.select({
        name: sql<string>`coalesce(nullif(${user.name}, ''), ${user.email})`,
      })
        .from(user)
        .where(eq(user.id, row.resolvedByUserId))
        .limit(1)
    : [];
  return {
    ...safeRow,
    resolvedByName: resolver?.name ?? null,
    proposedData:
      proposal.type === 'case_match'
        ? { ...proposal, candidateCaseIds: candidates.map((c) => c.id) }
        : proposal,
    confirmedData: row.confirmedData
      ? reviewConfirmedSchema.parse(JSON.parse(row.confirmedData))
      : null,
    candidates,
    currentCase: currentCase
      ? {
          id: currentCase.id,
          version: currentCase.version,
          customerName: currentCase.customerName,
          caseNo: currentCase.caseNo,
        }
      : null,
  };
}
function defaultConfirmation(proposal: ReviewProposal): ReviewConfirmed {
  switch (proposal.type) {
    case 'report_classification':
      return { type: proposal.type, classification: proposal.classification };
    case 'image_extraction':
      return {
        type: proposal.type,
        extraction: extractionSchema.parse(proposal.extraction),
      };
    case 'payment_detection':
      return { type: proposal.type, payment: proposal.payment };
    case 'case_match':
      throw new ORPCError('BAD_REQUEST', {
        message: 'Select a candidate case.',
      });
  }
}
export async function resolveReview(context: Context, raw: unknown) {
  const input = reviewResolveSchema.parse(raw);
  requirePermission(context, 'review.resolve');
  const row = await getReview(context, input.id);
  if (row.status !== 'pending') {
    if (row.status !== input.decision)
      throw new ORPCError('CONFLICT', {
        message: 'This review is already resolved.',
      });
    if (
      input.confirmedData &&
      JSON.stringify(input.confirmedData) !== JSON.stringify(row.confirmedData)
    )
      throw new ORPCError('CONFLICT');
    return { id: row.id, status: row.status, alreadyResolved: true };
  }
  const proposal = row.proposedData;
  if (row.entityType === 'intake' && row.entityId) {
    let confirmed: ReviewConfirmed | null = null;
    if (input.decision !== 'rejected') {
      if (input.decision === 'corrected' && !input.confirmedData)
        throw new ORPCError('BAD_REQUEST');
      try {
        confirmed = reviewConfirmedSchema.parse(
          input.confirmedData ?? defaultConfirmation(proposal),
        );
      } catch {
        throw new ORPCError('BAD_REQUEST');
      }
      if (confirmed.type !== proposal.type) throw new ORPCError('BAD_REQUEST');
      if (
        input.decision === 'approved' &&
        proposal.type !== 'case_match' &&
        JSON.stringify(confirmed) !==
          JSON.stringify(defaultConfirmation(proposal))
      )
        throw new ORPCError('BAD_REQUEST');
    }
    const [rawReview] = await context.DB.select()
      .from(reviewItems)
      .where(eq(reviewItems.id, row.id))
      .limit(1);
    const processed = await resolveIntakeReview(
      context,
      rawReview,
      input.decision,
      confirmed,
    );
    return {
      id: row.id,
      status: input.decision,
      alreadyResolved: processed.alreadyProcessed,
    };
  }
  let confirmed: ReviewConfirmed | null = null;
  let caseId = row.caseId;
  if (input.decision !== 'rejected') {
    if (input.decision === 'corrected' && !input.confirmedData)
      throw new ORPCError('BAD_REQUEST');
    try {
      confirmed = reviewConfirmedSchema.parse(
        input.confirmedData ?? defaultConfirmation(proposal),
      );
    } catch (error: unknown) {
      if (error instanceof ORPCError) throw error;
      throw new ORPCError('BAD_REQUEST', {
        message: 'Choose valid confirmed values and a final status.',
      });
    }
    if (confirmed.type !== proposal.type) throw new ORPCError('BAD_REQUEST');
    // Approve cannot silently replace the proposal. Corrections require an explicit corrected decision.
    if (
      input.decision === 'approved' &&
      proposal.type !== 'case_match' &&
      JSON.stringify(confirmed) !==
        JSON.stringify(defaultConfirmation(proposal))
    )
      throw new ORPCError('BAD_REQUEST', {
        message: 'Use corrected approval when changing proposed values.',
      });
    if (confirmed.type === 'case_match' && proposal.type === 'case_match') {
      if (!proposal.candidateCaseIds.includes(confirmed.selectedCaseId))
        throw new ORPCError('BAD_REQUEST', {
          message: 'Choose a stored candidate.',
        });
      await requireCaseAccess(context, confirmed.selectedCaseId);
      caseId = confirmed.selectedCaseId;
    } else if (caseId) {
      await requireCaseAccess(
        context,
        caseId,
        confirmed.type === 'image_extraction' ? 'case.edit' : 'report.edit',
      );
      if (input.expectedCaseVersion === undefined)
        throw new ORPCError('BAD_REQUEST', {
          message: 'Refresh the case before resolving.',
        });
    }
  }
  const token = crypto.randomUUID();
  const now = Date.now();
  let guard = '';
  const guards: (string | number | null)[] = [];
  if (confirmed && confirmed.type !== 'case_match' && caseId) {
    guard += ' AND EXISTS (SELECT 1 FROM cases WHERE id=? AND version=?)';
    guards.push(caseId, input.expectedCaseVersion ?? -1);
  }
  if (
    confirmed &&
    (proposal.type === 'report_classification' ||
      proposal.type === 'payment_detection')
  ) {
    guard +=
      ' AND EXISTS (SELECT 1 FROM reports WHERE id=? AND case_id=? AND version=?)';
    guards.push(proposal.reportId, row.caseId ?? '', proposal.reportVersion);
  }
  if (permissionPolicy(context).scope === 'assigned') {
    guard +=
      " AND EXISTS (SELECT 1 FROM assignments a JOIN collectors c ON c.id=a.collector_id WHERE a.unassigned_at IS NULL AND c.is_active=1 AND c.user_id=? AND (a.case_id=? OR (? IS NULL AND a.case_id IN (SELECT value FROM json_each(review_items.proposed_data,'$.candidateCaseIds')))))";
    guards.push(context.user?.id ?? '', caseId ?? '', caseId ?? null);
  }
  const statements = [
    context.env.DB.prepare(
      `UPDATE review_items SET status=?,confirmed_data=?,case_id=?,resolved_by_user_id=?,resolved_at=?,version=version+1,write_token=? WHERE id=? AND status='pending'${guard}`,
    ).bind(
      input.decision,
      confirmed ? JSON.stringify(confirmed) : null,
      caseId,
      context.user?.id,
      now,
      token,
      row.id,
      ...guards,
    ),
  ];
  const authorizedGuard =
    'EXISTS (SELECT 1 FROM review_items WHERE id=? AND write_token=?)';
  if (
    confirmed?.type === 'report_classification' &&
    proposal.type === 'report_classification' &&
    caseId
  ) {
    const c = confirmed.classification;
    const [latest] = await context.DB.select({ id: reports.id })
      .from(reports)
      .where(eq(reports.caseId, caseId))
      .orderBy(desc(reports.createdAt), desc(reports.id))
      .limit(1);
    statements.push(
      context.env.DB.prepare(
        `UPDATE cases SET status=COALESCE(?,status),revisit_status=COALESCE(?,revisit_status),revisit_reason=CASE WHEN ? IS NOT NULL THEN ? ELSE revisit_reason END,updated_at=?,version=version+1,write_token=? WHERE id=? AND ${authorizedGuard}`,
      ).bind(
        latest?.id === proposal.reportId ? reportCaseStatus(c.status) : null,
        latest?.id === proposal.reportId ? c.revisit_status : null,
        latest?.id === proposal.reportId ? c.revisit_status : null,
        c.revisit_reason ?? '',
        now,
        token,
        caseId,
        row.id,
        token,
      ),
    );
    statements.push(
      context.env.DB.prepare(
        `UPDATE reports SET status=?,revisit_status=?,revisit_reason=?,payment_detected=?,payment_amount=?,updated_at=?,version=version+1 WHERE id=? AND ${authorizedGuard}`,
      ).bind(
        c.status,
        c.revisit_status,
        c.revisit_reason,
        Number(c.payment_detected),
        c.payment_amount,
        now,
        proposal.reportId,
        row.id,
        token,
      ),
    );
  } else if (confirmed?.type === 'image_extraction' && caseId) {
    const c = confirmed.extraction;
    statements.push(
      context.env.DB.prepare(
        `UPDATE cases SET code=?,customer_name=?,address=?,amount_due=?,updated_at=?,version=version+1,write_token=? WHERE id=? AND ${authorizedGuard}`,
      ).bind(
        c.code,
        c.customer_name,
        c.address,
        c.amount_due,
        now,
        token,
        caseId,
        row.id,
        token,
      ),
    );
  } else if (
    confirmed?.type === 'payment_detection' &&
    proposal.type === 'payment_detection' &&
    caseId
  ) {
    const p = confirmed.payment;
    statements.push(
      context.env.DB.prepare(
        `UPDATE cases SET updated_at=?,version=version+1,write_token=? WHERE id=? AND ${authorizedGuard}`,
      ).bind(now, token, caseId, row.id, token),
    );
    statements.push(
      context.env.DB.prepare(
        `UPDATE reports SET payment_detected=?,payment_amount=?,updated_at=?,version=version+1 WHERE id=? AND ${authorizedGuard}`,
      ).bind(
        Number(p.payment_detected),
        p.payment_amount,
        now,
        proposal.reportId,
        row.id,
        token,
      ),
    );
  }
  statements.push(
    reviewAuditStatement(
      context,
      row.id,
      input.decision,
      caseId,
      row.entityId,
      token,
    ),
  );
  try {
    await atomicCaseWrite(context, statements);
  } catch (error: unknown) {
    const after = await getReview(context, row.id);
    if (
      after.status === input.decision &&
      JSON.stringify(after.confirmedData) === JSON.stringify(confirmed)
    )
      return { id: row.id, status: after.status, alreadyResolved: true };
    throw error;
  }
  return {
    id: row.id,
    status: input.decision,
    alreadyResolved: false,
  };
}
