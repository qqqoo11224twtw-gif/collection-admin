import { ORPCError } from '@orpc/server';
import { REGIONS } from '@saasflare-dev/db';
import { z } from 'zod';
import { queueAssignmentDispatch } from './assignment-outbound';
import { auditStatement } from './audit';
import { requireCaseAccess } from './case-access';
import { generateCaseNumber } from './case-number';
import type { Context } from './context';
import { protectedProcedure } from './middleware';
import { permissionPolicy, requirePermission } from './permissions';
import { normalizeReportName } from './telegram-name-index';

const rowSchema = z.strictObject({
  code: z.string().trim().max(60),
  customerName: z.string().trim().max(120),
  region: z.string().trim().max(30),
  address: z.string().trim().max(500).default(''),
  collector: z.string().trim().max(128).default(''),
  duplicateOverride: z.boolean().default(false),
  imageCount: z.number().int().min(0).max(100).default(0),
});
export const bulkCreateSchema = z.strictObject({
  batchId: z.string().uuid(),
  mode: z.enum(['new', 'historical']),
  formalDispatch: z.boolean().default(false),
  rows: z.array(rowSchema).min(1).max(20),
});
type Input = z.infer<typeof bulkCreateSchema>;
type Row = Input['rows'][number];
type Collector = { id: string; user_id: string | null };
type Result = {
  row: number;
  status: 'created' | 'duplicate' | 'invalid' | 'failed';
  reason: string | null;
  caseId: string | null;
  warning: string | null;
};

function authorize(context: Context, input: Input) {
  requirePermission(context, 'case.create');
  if (input.rows.some((row) => row.collector)) {
    requirePermission(context, 'assignment.create');
    requirePermission(context, 'assignment.bulk');
  }
}
async function validateRow(context: Context, input: Input, row: Row) {
  const reasons: string[] = [];
  if (!row.code || !row.customerName || !row.region)
    reasons.push('缺少代號、客戶姓名或地區');
  if (row.region && !REGIONS.includes(row.region as (typeof REGIONS)[number]))
    reasons.push('地區無效');
  let collector: Collector | null = null;
  if (row.collector) {
    const candidates = await context.env.DB.prepare(
      'SELECT id,user_id FROM collectors WHERE is_active=1 AND (id=? OR code=? COLLATE NOCASE OR display_name=?) LIMIT 2',
    )
      .bind(row.collector, row.collector, row.collector)
      .all<Collector>();
    if (candidates.results.length !== 1)
      reasons.push('外收人員無效或無法唯一辨識');
    else collector = candidates.results[0];
    if (
      collector &&
      permissionPolicy(context).scope !== 'all' &&
      collector.user_id !== context.user?.id
    )
      reasons.push('無權限委外給此人員');
    if (input.mode === 'new' && !input.formalDispatch)
      reasons.push('指定外收人員時，必須確認正式派件');
    if (collector && input.mode === 'new') {
      const routes = await context.env.DB.prepare(
        "SELECT r.id FROM telegram_routes r WHERE r.collector_id=? AND r.route_type IN ('collector','collector_dispatch') AND r.is_active=1 AND (r.bot_id IS NULL OR EXISTS(SELECT 1 FROM telegram_bots b WHERE b.id=r.bot_id AND b.is_active=1)) LIMIT 2",
      )
        .bind(collector.id)
        .all();
      if (routes.results.length !== 1)
        reasons.push('缺少唯一有效的 Telegram 收單群組');
    }
  }
  const duplicate = !!(await context.env.DB.prepare(
    "SELECT id FROM cases WHERE code=? COLLATE NOCASE AND customer_name=? AND coalesce(manual_entry_key,'') NOT LIKE ? LIMIT 1",
  )
    .bind(row.code, row.customerName, `${input.batchId}:%`)
    .first());
  const sameBatch =
    input.rows.filter(
      (other) =>
        other.code.toLocaleLowerCase() === row.code.toLocaleLowerCase() &&
        other.customerName === row.customerName,
    ).length > 1;
  const sameName =
    !row.code &&
    !!(await context.env.DB.prepare(
      'SELECT id FROM cases WHERE customer_name=? LIMIT 1',
    )
      .bind(row.customerName)
      .first());
  if (sameName) reasons.push('同名案件已存在，請補上代號並人工確認');
  return { reasons, duplicate: duplicate || sameBatch, collector };
}

export async function previewBulkCases(context: Context, raw: Input) {
  const input = bulkCreateSchema.parse(raw);
  authorize(context, input);
  const results = [];
  for (const [index, row] of input.rows.entries()) {
    const checked = await validateRow(context, input, row);
    results.push({
      row: index + 1,
      status: checked.reasons.length
        ? ('invalid' as const)
        : checked.duplicate && !row.duplicateOverride
          ? ('duplicate' as const)
          : ('ready' as const),
      reasons: checked.reasons.length
        ? checked.reasons
        : checked.duplicate && !row.duplicateOverride
          ? ['同姓名與同代號，需人工確認後才可建立']
          : [],
    });
  }
  return results;
}

export async function createBulkCases(context: Context, raw: Input) {
  const input = bulkCreateSchema.parse(raw);
  authorize(context, input);
  const results: Result[] = [];
  for (const [index, row] of input.rows.entries()) {
    const result: Result = {
      row: index + 1,
      status: 'failed',
      reason: null,
      caseId: null,
      warning: null,
    };
    try {
      const checked = await validateRow(context, input, row);
      if (checked.reasons.length) {
        result.status = 'invalid';
        result.reason = checked.reasons.join('；');
        results.push(result);
        continue;
      }
      const key = `${input.batchId}:${index}`;
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify({
            mode: input.mode,
            formalDispatch: input.formalDispatch,
            code: row.code,
            name: row.customerName,
            region: row.region,
            address: row.address,
            collectorId: checked.collector?.id ?? null,
            imageCount: row.imageCount,
          }),
        ),
      );
      const fingerprint = Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join('');
      const source =
        input.mode === 'historical' ? 'historical_import' : 'manual';
      let existing = await context.env.DB.prepare(
        'SELECT id,code,customer_name,region,address,source FROM cases WHERE manual_entry_key=?',
      )
        .bind(key)
        .first<{
          id: string;
          code: string;
          customer_name: string;
          region: string;
          address: string;
          source: string;
        }>();
      if (!existing && checked.duplicate && !row.duplicateOverride) {
        result.status = 'duplicate';
        result.reason = '同姓名與同代號，需人工確認';
        results.push(result);
        continue;
      }
      const now = Date.now();
      const id = existing?.id ?? crypto.randomUUID();
      const address = row.address || '未提供';
      if (!existing) {
        const assignmentId = crypto.randomUUID();
        await context.env.DB.batch([
          context.env.DB.prepare(
            "INSERT INTO cases(id,case_no,code,customer_name,report_name,region,address,amount_due,status,revisit_status,revisit_reason,source,created_at,updated_at,manual_entry_key,write_token,assigned_agent_id) SELECT ?,?,?,?,?,?,?,0,'pending','not_needed','',?,?,?,?,?,? WHERE (?=1 OR NOT EXISTS(SELECT 1 FROM cases WHERE code=? COLLATE NOCASE AND customer_name=?)) AND (? IS NULL OR EXISTS(SELECT 1 FROM collectors WHERE id=? AND is_active=1 AND (?=1 OR user_id=?))) ON CONFLICT(manual_entry_key) DO NOTHING",
          ).bind(
            id,
            generateCaseNumber(id, now),
            row.code,
            row.customerName,
            normalizeReportName(row.customerName),
            row.region,
            address,
            source,
            now,
            now,
            key,
            id,
            input.mode === 'historical'
              ? (checked.collector?.user_id ?? null)
              : null,
            Number(row.duplicateOverride),
            row.code,
            row.customerName,
            checked.collector?.id ?? null,
            checked.collector?.id ?? null,
            Number(permissionPolicy(context).scope === 'all'),
            context.user?.id ?? null,
          ),
          auditStatement(
            context,
            'case.created',
            'case',
            id,
            {
              fields: ['code', 'customerName', 'region', 'address', 'source'],
              version: 0,
              bulkCollectorId: checked.collector?.id ?? null,
              bulkMode: input.mode,
              bulkFormalDispatch: input.formalDispatch,
              bulkImageCount: row.imageCount,
              inputFingerprint: fingerprint,
            },
            id,
          ),
          ...(checked.collector && input.mode === 'historical'
            ? [
                context.env.DB.prepare(
                  'INSERT INTO assignments(id,case_id,collector_id,assigned_by_user_id,assigned_at,record_type,note,correction_reason) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)',
                ).bind(
                  assignmentId,
                  id,
                  checked.collector.id,
                  context.user?.id,
                  now,
                  input.mode === 'historical' ? 'historical' : 'assignment',
                  input.mode === 'historical'
                    ? '歷史批量建檔'
                    : '新案件批量正式派件',
                  input.mode === 'historical' ? '歷史批量建檔' : null,
                  id,
                  id,
                ),
                auditStatement(
                  context,
                  'assignment.created',
                  'case',
                  id,
                  { collectorId: checked.collector.id, assignmentId },
                  id,
                ),
              ]
            : []),
        ]);
        existing = await context.env.DB.prepare(
          'SELECT id,code,customer_name,region,address,source FROM cases WHERE manual_entry_key=?',
        )
          .bind(key)
          .first<typeof existing>();
      }
      if (
        !existing ||
        existing.code !== row.code ||
        existing.customer_name !== row.customerName ||
        existing.region !== row.region ||
        existing.address !== address ||
        existing.source !== source
      )
        throw new ORPCError('CONFLICT');
      const received = await context.env.DB.prepare(
        "SELECT user_id,json_extract(metadata,'$.inputFingerprint') AS fingerprint FROM audit_logs WHERE entity_id=? AND action='case.created' ORDER BY created_at,id LIMIT 1",
      )
        .bind(existing.id)
        .first<{ fingerprint: string; user_id: string }>();
      if (received?.fingerprint !== fingerprint)
        throw new ORPCError('CONFLICT');
      if (received.user_id !== context.user?.id)
        await requireCaseAccess(context, existing.id);
      result.caseId = existing.id;
      const record = await context.env.DB.prepare(
        'SELECT voided_at AS voidedAt FROM cases WHERE id=?',
      )
        .bind(existing.id)
        .first<{ voidedAt: number | null }>();
      if (!record) throw new ORPCError('CONFLICT');
      if (record.voidedAt) throw new ORPCError('CONFLICT');
      const assignment = await context.env.DB.prepare(
        'SELECT id,collector_id,record_type FROM assignments WHERE case_id=? AND unassigned_at IS NULL',
      )
        .bind(existing.id)
        .first<{ id: string; collector_id: string; record_type: string }>();
      if (checked.collector) {
        if (
          assignment &&
          (assignment.collector_id !== checked.collector.id ||
            assignment.record_type !==
              (input.mode === 'historical' ? 'historical' : 'assignment'))
        )
          throw new ORPCError('CONFLICT');
        if (input.mode === 'new') {
          result.warning = '待補圖片；圖片全部成功後才建立正式委外。';
        }
      } else if (assignment) throw new ORPCError('CONFLICT');
      result.status = 'created';
    } catch (error: unknown) {
      result.reason =
        error instanceof ORPCError && error.code === 'CONFLICT'
          ? '資料已變更或批次識別與原內容衝突，請檢查案件後重試'
          : '此列無法完成，請檢查資料與權限';
    }
    results.push(result);
  }
  return {
    batchId: input.batchId,
    results,
    succeeded: results.filter((r) => r.status === 'created').length,
    failed: results.filter((r) => r.status !== 'created').length,
  };
}

export const bulkCaseCreateApi = {
  finalizeBulkMedia: protectedProcedure
    .input(
      z.strictObject({
        batchId: z.string().uuid(),
        row: z.number().int().min(1).max(20),
        expectedImageCount: z.number().int().min(1).max(100),
      }),
    )
    .handler(async ({ context, input }) => {
      requirePermission(context, 'assignment.create');
      requirePermission(context, 'assignment.bulk');
      const record = await context.env.DB.prepare(
        'SELECT id,version FROM cases WHERE manual_entry_key=? AND voided_at IS NULL',
      )
        .bind(`${input.batchId}:${input.row - 1}`)
        .first<{ id: string; version: number }>();
      if (!record) throw new ORPCError('NOT_FOUND');
      await requireCaseAccess(context, record.id, 'assignment.create');
      const origin = await context.env.DB.prepare(
        "SELECT json_extract(metadata,'$.bulkCollectorId') collector_id,json_extract(metadata,'$.bulkImageCount') image_count FROM audit_logs WHERE entity_id=? AND action='case.created' AND json_extract(metadata,'$.bulkMode')='new' AND json_extract(metadata,'$.bulkFormalDispatch')=1 LIMIT 1",
      )
        .bind(record.id)
        .first<{ collector_id: string | null; image_count: number }>();
      if (!origin?.collector_id) throw new ORPCError('BAD_REQUEST');
      if (
        origin.image_count > 0 &&
        origin.image_count !== input.expectedImageCount
      )
        throw new ORPCError('CONFLICT');
      const activeCollector = await context.env.DB.prepare(
        'SELECT id FROM collectors WHERE id=? AND is_active=1',
      )
        .bind(origin.collector_id)
        .first();
      if (!activeCollector)
        throw new ORPCError('BAD_REQUEST', { message: '外收人員已停用。' });
      const count = await context.env.DB.prepare(
        'SELECT count(*) count FROM case_media WHERE case_id=?',
      )
        .bind(record.id)
        .first<{ count: number }>();
      if (!count || count.count < input.expectedImageCount)
        throw new ORPCError('CONFLICT', {
          message: '圖片尚未完成，不能正式派件。',
        });
      let assignment = await context.env.DB.prepare(
        'SELECT id,collector_id FROM assignments WHERE case_id=? AND unassigned_at IS NULL',
      )
        .bind(record.id)
        .first<{ id: string; collector_id: string }>();
      if (assignment && assignment.collector_id !== origin.collector_id)
        throw new ORPCError('CONFLICT');
      if (!assignment) {
        const id = crypto.randomUUID(),
          now = Date.now();
        await context.env.DB.batch([
          context.env.DB.prepare(
            "UPDATE cases SET status=CASE WHEN status='pending' THEN 'assigned' ELSE status END,updated_at=?,version=version+1,write_token=?,assigned_agent_id=(SELECT user_id FROM collectors WHERE id=?) WHERE id=? AND version=? AND voided_at IS NULL AND NOT EXISTS(SELECT 1 FROM assignments WHERE case_id=cases.id AND unassigned_at IS NULL) AND EXISTS(SELECT 1 FROM collectors WHERE id=? AND is_active=1) AND EXISTS(SELECT 1 FROM telegram_routes r WHERE r.collector_id=? AND r.route_type IN ('collector','collector_dispatch') AND r.is_active=1 AND (r.bot_id IS NULL OR EXISTS(SELECT 1 FROM telegram_bots b WHERE b.id=r.bot_id AND b.is_active=1)))",
          ).bind(
            now,
            id,
            origin.collector_id,
            record.id,
            record.version,
            origin.collector_id,
            origin.collector_id,
          ),
          context.env.DB.prepare(
            "INSERT INTO assignments(id,case_id,collector_id,assigned_by_user_id,assigned_at,record_type,note) SELECT ?,?,?,?,?,'assignment','批量建檔圖片完成後正式派件' WHERE EXISTS(SELECT 1 FROM cases WHERE id=? AND write_token=?)",
          ).bind(
            id,
            record.id,
            origin.collector_id,
            context.user?.id,
            now,
            record.id,
            id,
          ),
          auditStatement(
            context,
            'assignment.created',
            'case',
            record.id,
            { collectorId: origin.collector_id, assignmentId: id },
            id,
          ),
        ]);
        assignment = await context.env.DB.prepare(
          'SELECT id,collector_id FROM assignments WHERE case_id=? AND unassigned_at IS NULL',
        )
          .bind(record.id)
          .first<{ id: string; collector_id: string }>();
        if (!assignment || assignment.collector_id !== origin.collector_id)
          throw new ORPCError('CONFLICT');
      }
      return {
        assignmentId: assignment.id,
        warning:
          (await queueAssignmentDispatch(context, assignment.id))?.warning ??
          null,
      };
    }),
  previewBulkCreate: protectedProcedure
    .input(bulkCreateSchema)
    .handler(({ context, input }) => previewBulkCases(context, input)),
  bulkCreate: protectedProcedure
    .input(bulkCreateSchema)
    .handler(({ context, input }) => createBulkCases(context, input)),
};
