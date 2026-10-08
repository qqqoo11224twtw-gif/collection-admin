import { ORPCError } from '@orpc/server';
import { assignments, collectors } from '@saasflare-dev/db';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { atomicCaseWrite } from './audit';
import { requireCaseAccess } from './case-access';
import { assignmentCorrectionSchema, manualCaseSchema } from './case-contract';
import {
  detectedImageType,
  limitedFormData,
  sha256,
} from './case-media-management';
import { generateCaseNumber } from './case-number';
import { privateCaseStorage } from './case-storage';
import type { Context } from './context';
import { financeAudit } from './finance-audit';
import { protectedProcedure } from './middleware';
import { requirePermission } from './permissions';

export async function duplicateCaseWarning(context: Context, code: string) {
  requirePermission(context, 'case.create');
  const row = await context.env.DB.prepare(
    'SELECT max(created_at) AS last_created_at FROM cases WHERE code=? COLLATE NOCASE',
  )
    .bind(code.trim())
    .first<{ last_created_at: number | null }>();
  return {
    duplicate:
      row?.last_created_at !== null && row?.last_created_at !== undefined,
    lastCreatedAt:
      row?.last_created_at === null || row?.last_created_at === undefined
        ? null
        : new Date(row.last_created_at),
  };
}
export async function createManualCase(context: Context, request: Request) {
  const actor = requirePermission(context, 'case.create');
  requirePermission(context, 'media.upload');
  if (
    !(context.env.CORS_ORIGIN ?? '')
      .split(',')
      .map((s) => s.trim())
      .includes(request.headers.get('Origin') ?? '')
  )
    throw new ORPCError('FORBIDDEN');
  const form = await limitedFormData(request);
  if ([...form.keys()].some((key) => !['input', 'files'].includes(key)))
    throw new ORPCError('BAD_REQUEST');
  let input: z.infer<typeof manualCaseSchema>;
  try {
    input = manualCaseSchema.parse(JSON.parse(String(form.get('input'))));
  } catch {
    throw new ORPCError('BAD_REQUEST');
  }
  const prior = await context.env.DB.prepare(
    'SELECT id,case_no,code,customer_name,region FROM cases WHERE manual_entry_key=?',
  )
    .bind(input.idempotencyKey)
    .first<{
      id: string;
      case_no: string;
      code: string;
      customer_name: string;
      region: string;
    }>();
  if (prior) {
    await requireCaseAccess(context, prior.id, 'case.create');
    if (
      prior.code !== input.code ||
      prior.customer_name !== input.customerName ||
      prior.region !== input.region
    )
      throw new ORPCError('CONFLICT');
    return {
      kind: 'created' as const,
      id: prior.id,
      caseNo: prior.case_no,
      duplicate: true,
    };
  }
  const warning = await duplicateCaseWarning(context, input.code);
  if (warning.duplicate && !input.duplicateOverride) {
    await context.env.DB.prepare(
      "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) VALUES(?,?,'duplicate_warning_detected','manual_case',?,'{}',?)",
    )
      .bind(crypto.randomUUID(), actor.id, input.idempotencyKey, Date.now())
      .run();
    return { kind: 'duplicate_warning' as const, ...warning };
  }
  const files = form.getAll('files');
  if (files.length > 5)
    throw new ORPCError('BAD_REQUEST', {
      message: 'Choose one to five finished images.',
    });
  const id = crypto.randomUUID(),
    now = Date.now(),
    caseNo = generateCaseNumber(id, now),
    token = crypto.randomUUID();
  const images = [];
  for (const file of files) {
    if (typeof file === 'string' || !file.size || file.size > 5 * 1024 * 1024)
      throw new ORPCError('BAD_REQUEST');
    const bytes = await file.arrayBuffer();
    const type = detectedImageType(new Uint8Array(bytes));
    if (!type || type !== file.type) throw new ORPCError('BAD_REQUEST');
    const filename = file.name
      .split(/[\\/]/)
      .at(-1)
      ?.split('')
      .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
      .join('')
      .trim();
    if (!filename || filename.length > 255) throw new ORPCError('BAD_REQUEST');
    const mediaId = crypto.randomUUID();
    images.push({
      id: mediaId,
      bytes,
      type,
      filename,
      key: `cases/${id}/${mediaId}`,
      hash: await sha256(bytes),
    });
  }
  const storage = privateCaseStorage(context.env),
    written: string[] = [];
  try {
    for (const image of images) {
      await storage.write(image.key, image.bytes, image.type);
      written.push(image.key);
    }
    await atomicCaseWrite(context, [
      context.env.DB.prepare(
        "INSERT INTO cases(id,case_no,code,customer_name,region,address,amount_due,status,revisit_status,revisit_reason,source,created_at,updated_at,manual_entry_key,write_token) SELECT ?,?,?,?,?,?,?,'pending','pending','','manual',?,?,?,? WHERE ?=1 OR NOT EXISTS(SELECT 1 FROM cases WHERE code=? COLLATE NOCASE)",
      ).bind(
        id,
        caseNo,
        input.code,
        input.customerName,
        input.region,
        input.address,
        input.amountDue,
        now,
        now,
        input.idempotencyKey,
        token,
        Number(input.duplicateOverride),
        input.code,
      ),
      ...images.map((image, index) =>
        context.env.DB.prepare(
          'INSERT INTO case_media(id,case_id,storage_key,original_filename,media_type,sort_order,sha256,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)',
        ).bind(
          image.id,
          id,
          image.key,
          image.filename,
          image.type,
          index + 1,
          image.hash,
          now,
          id,
          token,
        ),
      ),
      financeAudit(context, id, 'manual.case_created', id, {
        sql: 'EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)',
        values: [id, token],
      }),
      ...(images.length
        ? [
            financeAudit(context, id, 'manual.image_uploaded', id, {
              sql: 'EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)',
              values: [id, token],
            }),
          ]
        : []),
      ...(input.duplicateOverride
        ? [
            financeAudit(context, id, 'duplicate_warning_overridden', id, {
              sql: 'EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?) AND EXISTS(SELECT 1 FROM cases WHERE id<>? AND code=? COLLATE NOCASE)',
              values: [id, token, id, input.code],
            }),
          ]
        : []),
    ]);
  } catch (error: unknown) {
    await Promise.allSettled(written.map((key) => storage.delete(key)));
    const repeated = await context.env.DB.prepare(
      'SELECT id,case_no,code,customer_name,region FROM cases WHERE manual_entry_key=?',
    )
      .bind(input.idempotencyKey)
      .first<{
        id: string;
        case_no: string;
        code: string;
        customer_name: string;
        region: string;
      }>();
    if (repeated) {
      if (
        repeated.code !== input.code ||
        repeated.customer_name !== input.customerName ||
        repeated.region !== input.region
      )
        throw new ORPCError('CONFLICT');
      return {
        kind: 'created' as const,
        id: repeated.id,
        caseNo: repeated.case_no,
        duplicate: true,
      };
    }
    const latest = await duplicateCaseWarning(context, input.code);
    if (latest.duplicate && !input.duplicateOverride)
      return { kind: 'duplicate_warning' as const, ...latest };
    throw error;
  }
  return { kind: 'created' as const, id, caseNo, duplicate: false };
}
export const manualCaseApi = {
  duplicateWarning: protectedProcedure
    .input(z.object({ code: z.string().trim().min(1).max(60) }).strict())
    .handler(({ context, input }) => duplicateCaseWarning(context, input.code)),
  correctAssignment: protectedProcedure
    .input(assignmentCorrectionSchema)
    .handler(async ({ context, input }) => {
      const actor = requirePermission(context, 'assignment.correct');
      const record = await requireCaseAccess(
        context,
        input.caseId,
        'assignment.correct',
      );
      const [current] = await context.DB.select()
        .from(assignments)
        .where(
          and(
            eq(assignments.caseId, record.id),
            isNull(assignments.unassignedAt),
          ),
        );
      const [collector] = await context.DB.select()
        .from(collectors)
        .where(eq(collectors.id, input.collectorId));
      if (
        !current ||
        !collector?.isActive ||
        current.collectorId === collector.id
      )
        throw new ORPCError('BAD_REQUEST');
      const now = Date.now(),
        token = crypto.randomUUID(),
        id = crypto.randomUUID();
      await atomicCaseWrite(context, [
        context.env.DB.prepare(
          'UPDATE cases SET assigned_agent_id=?,updated_at=?,version=version+1,write_token=? WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM assignments WHERE id=? AND unassigned_at IS NULL) AND EXISTS(SELECT 1 FROM collectors WHERE id=? AND is_active=1)',
        ).bind(
          collector.userId,
          now,
          token,
          record.id,
          input.expectedVersion,
          current.id,
          collector.id,
        ),
        context.env.DB.prepare(
          'UPDATE assignments SET unassigned_at=? WHERE id=? AND unassigned_at IS NULL AND EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)',
        ).bind(now, current.id, record.id, token),
        context.env.DB.prepare(
          "INSERT INTO assignments(id,case_id,collector_id,assigned_by_user_id,assigned_at,note,record_type,corrected_from_id,correction_reason) SELECT ?,?,?,?,? ,?,'correction',?,? WHERE EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)",
        ).bind(
          id,
          record.id,
          collector.id,
          actor.id,
          current.assignedAt.getTime(),
          current.note,
          current.id,
          input.reason,
          record.id,
          token,
        ),
        financeAudit(context, record.id, 'assignment.corrected', id, {
          sql: 'EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)',
          values: [record.id, token],
        }),
      ]);
      return { id };
    }),
};
