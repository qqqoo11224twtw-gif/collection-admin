import { ORPCError } from '@orpc/server';
import { REGIONS, user } from '@saasflare-dev/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { atomicCaseWrite } from './audit';
import { requireCaseAccess } from './case-access';
import type { Context } from './context';
import { protectedProcedure } from './middleware';
import { requirePermission } from './permissions';
import { sanitizeLogText, systemLog } from './system-log';

const ids = z
  .array(z.string().min(1).max(128))
  .min(1)
  .max(100)
  .refine((v) => new Set(v).size === v.length);
const schema = z.strictObject({
  batchId: z.uuid(),
  caseIds: ids,
  fields: z
    .strictObject({
      collectorId: z.string().min(1).max(128).optional(),
      region: z.enum(REGIONS).optional(),
    })
    .refine((v) => Object.keys(v).length > 0),
  mode: z.enum(['fill_empty', 'overwrite']).default('fill_empty'),
  confirmOverwrite: z.boolean().default(false),
  note: z.string().trim().min(1).max(500),
});
type Outcome = {
  caseId: string;
  status: 'success' | 'skipped';
  reason: string;
};
async function apply(
  context: Context,
  input: z.infer<typeof schema>,
  caseId: string,
  hash: string,
): Promise<Outcome> {
  const [latest] = await context.DB.select()
    .from(user)
    .where(eq(user.id, context.user?.id ?? ''));
  if (!latest?.active) throw new ORPCError('FORBIDDEN');
  context = { ...context, user: latest };
  const record = await requireCaseAccess(context, caseId, 'case.edit');
  const actor = requirePermission(context, 'case.edit');
  const auditId = `bulk-edit:${input.batchId}:${caseId}`;
  const prior = await context.env.DB.prepare(
    'SELECT user_id,metadata FROM audit_logs WHERE id=?',
  )
    .bind(auditId)
    .first<{ user_id: string; metadata: string }>();
  if (prior) {
    if (
      prior.user_id !== actor.id ||
      JSON.parse(prior.metadata).requestHash !== hash
    )
      throw new ORPCError('CONFLICT');
    return { caseId, status: 'success', reason: 'ALREADY_APPLIED' };
  }
  const current = await context.env.DB.prepare(
    'SELECT id,collector_id,assigned_at FROM assignments WHERE case_id=? AND unassigned_at IS NULL',
  )
    .bind(caseId)
    .first<{ id: string; collector_id: string; assigned_at: number }>();
  const keepCollector =
    !!input.fields.collectorId && !!current && input.mode === 'fill_empty';
  if (keepCollector && !input.fields.region)
    return { caseId, status: 'skipped', reason: 'COLLECTOR_PRESENT' };
  const collectorId = keepCollector ? undefined : input.fields.collectorId;
  if (collectorId) requirePermission(context, 'assignment.correct');
  const collector = collectorId
    ? await context.env.DB.prepare(
        'SELECT id,user_id FROM collectors WHERE id=? AND is_active=1',
      )
        .bind(collectorId)
        .first<{ id: string; user_id: string | null }>()
    : null;
  if (collectorId && !collector)
    return { caseId, status: 'skipped', reason: 'COLLECTOR_UNAVAILABLE' };
  const now = Date.now(),
    token = crypto.randomUUID(),
    assignmentId = crypto.randomUUID();
  const statements = [
    context.env.DB.prepare(
      `UPDATE cases SET region=?,assigned_agent_id=?,updated_at=?,version=version+1,write_token=? WHERE id=? AND version=? AND voided_at IS NULL${collectorId ? ' AND EXISTS(SELECT 1 FROM collectors WHERE id=? AND is_active=1)' : ''}${collectorId && input.mode === 'fill_empty' ? ' AND NOT EXISTS(SELECT 1 FROM assignments WHERE case_id=cases.id AND unassigned_at IS NULL)' : ''}`,
    ).bind(
      input.fields.region ?? record.region,
      collector ? collector.user_id : record.assignedAgentId,
      now,
      token,
      caseId,
      record.version,
      ...(collectorId ? [collectorId] : []),
    ),
  ];
  if (collectorId) {
    statements.push(
      context.env.DB.prepare(
        'UPDATE assignments SET unassigned_at=? WHERE case_id=? AND unassigned_at IS NULL AND EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)',
      ).bind(now, caseId, caseId, token),
    );
    statements.push(
      context.env.DB.prepare(
        'INSERT INTO assignments(id,case_id,collector_id,assigned_by_user_id,assigned_at,record_type,corrected_from_id,correction_reason) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)',
      ).bind(
        assignmentId,
        caseId,
        collectorId,
        actor.id,
        current?.assigned_at ?? now,
        current ? 'correction' : 'historical',
        current?.id ?? null,
        sanitizeLogText(input.note),
        caseId,
        token,
      ),
    );
  }
  statements.push(
    context.env.DB.prepare(
      "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,'case.bulk_edited','case',?,?,? WHERE EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)",
    ).bind(
      auditId,
      actor.id,
      caseId,
      JSON.stringify({
        batchId: input.batchId,
        requestHash: hash,
        fields: Object.keys(input.fields).filter(
          (v) => v !== 'collectorId' || !!collectorId,
        ),
        recordType: collectorId ? 'historical/manual correction' : null,
        before: {
          region: record.region,
          collectorId: current?.collector_id ?? null,
        },
        after: {
          region: input.fields.region ?? record.region,
          collectorId: collectorId ?? current?.collector_id ?? null,
        },
        note: sanitizeLogText(input.note),
      }),
      now,
      caseId,
      token,
    ),
  );
  await atomicCaseWrite(context, statements);
  return { caseId, status: 'success', reason: 'UPDATED' };
}
export const bulkCaseEditApi = {
  bulkEditCollectors: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'case.edit');
    requirePermission(context, 'assignment.correct');
    return (
      await context.env.DB.prepare(
        'SELECT id,display_name AS displayName FROM collectors WHERE is_active=1 ORDER BY display_name',
      ).all<{ id: string; displayName: string }>()
    ).results;
  }),
  bulkEditPreview: protectedProcedure
    .input(z.strictObject({ caseIds: ids }))
    .handler(async ({ context, input }) => {
      requirePermission(context, 'case.edit');
      let existingCollectorCount = 0,
        linkedCount = 0;
      for (const id of input.caseIds) {
        await requireCaseAccess(context, id, 'case.edit');
        const row = await context.env.DB.prepare(
          'SELECT EXISTS(SELECT 1 FROM assignments WHERE case_id=? AND unassigned_at IS NULL) AS assigned, (EXISTS(SELECT 1 FROM assignments WHERE case_id=?) OR EXISTS(SELECT 1 FROM reports WHERE case_id=?) OR EXISTS(SELECT 1 FROM installment_plans WHERE case_id=?) OR EXISTS(SELECT 1 FROM payments WHERE case_id=?)) AS linked',
        )
          .bind(id, id, id, id, id)
          .first<{ assigned: number; linked: number }>();
        existingCollectorCount += row?.assigned ?? 0;
        linkedCount += row?.linked ?? 0;
      }
      return { existingCollectorCount, linkedCount };
    }),
  bulkEdit: protectedProcedure
    .input(schema)
    .handler(async ({ context, input }) => {
      requirePermission(context, 'case.edit');
      if (input.fields.collectorId)
        requirePermission(context, 'assignment.correct');
      if (
        input.fields.collectorId &&
        input.mode === 'overwrite' &&
        !input.confirmOverwrite
      )
        throw new ORPCError('BAD_REQUEST', {
          message: '覆蓋外收人員前必須明確確認。',
        });
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(input)),
      );
      const hash = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      const items: Outcome[] = [];
      for (const id of input.caseIds) {
        try {
          items.push(await apply(context, input, id, hash));
        } catch (error: unknown) {
          const reason =
            error instanceof ORPCError
              ? error.code === 'FORBIDDEN'
                ? 'PERMISSION_DENIED'
                : error.code === 'NOT_FOUND'
                  ? 'CASE_UNAVAILABLE'
                  : 'RECORD_CHANGED'
              : 'SAVE_FAILED';
          items.push({ caseId: id, status: 'skipped', reason });
          await systemLog(context.env.DB, {
            category: 'database',
            event: input.fields.collectorId
              ? 'HISTORICAL_ASSIGNMENT_CORRECTION_FAILED'
              : 'BULK_CASE_EDIT_FAILED',
            status: 'failed',
            level: 'warning',
            relatedUserId: context.user?.id,
            errorCode: reason,
          });
        }
      }
      return {
        items,
        success: items.filter((v) => v.status === 'success').length,
        skipped: items.filter((v) => v.status === 'skipped').length,
      };
    }),
  bulkVoid: protectedProcedure
    .input(
      z.strictObject({
        caseIds: ids,
        note: z.string().trim().min(1).max(500),
        confirmed: z.literal(true),
      }),
    )
    .handler(async ({ context, input }) => {
      const actor = requirePermission(context, 'case.delete');
      const items: Outcome[] = [];
      for (const id of input.caseIds)
        try {
          const record = await requireCaseAccess(context, id, 'case.delete');
          if (record.voidedAt) {
            items.push({
              caseId: id,
              status: 'skipped',
              reason: 'ALREADY_VOIDED',
            });
            continue;
          }
          const now = Date.now(),
            token = crypto.randomUUID();
          await atomicCaseWrite(context, [
            context.env.DB.prepare(
              'UPDATE cases SET voided_at=?,voided_by=?,void_note=?,version=version+1,updated_at=?,write_token=? WHERE id=? AND version=? AND voided_at IS NULL',
            ).bind(
              now,
              actor.id,
              sanitizeLogText(input.note),
              now,
              token,
              id,
              record.version,
            ),
            context.env.DB.prepare(
              "UPDATE telegram_outbound_jobs SET status='failed',last_error_code='CASE_VOIDED',next_attempt_at=NULL WHERE status='pending' AND assignment_id IN (SELECT id FROM assignments WHERE case_id=?) AND EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)",
            ).bind(id, id, token),
            context.env.DB.prepare(
              "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,'case.voided','case',?,?,? WHERE EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)",
            ).bind(
              crypto.randomUUID(),
              actor.id,
              id,
              JSON.stringify({
                before: { voidedAt: null },
                after: { voidedAt: now },
                note: sanitizeLogText(input.note),
              }),
              now,
              id,
              token,
            ),
          ]);
          items.push({ caseId: id, status: 'success', reason: 'VOIDED' });
        } catch {
          items.push({
            caseId: id,
            status: 'skipped',
            reason: 'CASE_UNAVAILABLE',
          });
          await systemLog(context.env.DB, {
            category: 'database',
            event: 'CASE_VOID_FAILED',
            status: 'failed',
            level: 'warning',
            relatedUserId: actor.id,
          });
        }
      return {
        items,
        success: items.filter((v) => v.status === 'success').length,
        skipped: items.filter((v) => v.status === 'skipped').length,
      };
    }),
};
