import { ORPCError } from '@orpc/server';
import { assignments, auditLogs, collectors, user } from '@saasflare-dev/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { queueAssignmentDispatch } from './assignment-outbound';
import { atomicCaseWrite, auditStatement } from './audit';
import { requireCaseAccess } from './case-access';
import {
  assignmentSchema,
  caseCreateSchema,
  caseEditSchema,
  caseIdSchema,
  collectorCreateSchema,
  collectorEditSchema,
} from './case-contract';
import { generateCaseNumber } from './case-number';
import { protectedProcedure } from './middleware';
import { requirePermission } from './permissions';
import { systemLog } from './system-log';

export const caseManagementApi = {
  create: protectedProcedure
    .input(caseCreateSchema)
    .handler(async ({ context, input }) => {
      const actor = requirePermission(context, 'case.create');
      const duplicate = await context.env.DB.prepare(
        'SELECT max(created_at) AS latest FROM cases WHERE code=? COLLATE NOCASE',
      )
        .bind(input.code)
        .first<{ latest: number | null }>();
      if (
        input.source === 'manual' &&
        duplicate?.latest !== null &&
        duplicate?.latest !== undefined &&
        !input.duplicateOverride
      ) {
        await context.env.DB.prepare(
          "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) VALUES(?,?,'duplicate_warning_detected','manual_case',?,'{}',?)",
        )
          .bind(crypto.randomUUID(), actor.id, crypto.randomUUID(), Date.now())
          .run();
        return {
          kind: 'duplicate_warning' as const,
          lastCreatedAt: new Date(duplicate.latest),
        };
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      const caseNo = generateCaseNumber(id, now);
      await atomicCaseWrite(context, [
        context.env.DB.prepare(
          "INSERT INTO cases (id,case_no,code,customer_name,address,amount_due,status,revisit_status,revisit_reason,source,created_at,updated_at,region,write_token) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ?<>'manual' OR ?=1 OR NOT EXISTS(SELECT 1 FROM cases WHERE code=? COLLATE NOCASE)",
        ).bind(
          id,
          caseNo,
          input.code,
          input.customerName,
          input.address,
          input.amountDue,
          input.status,
          input.revisitStatus,
          input.revisitReason,
          input.source,
          now,
          now,
          input.region,
          id,
          input.source,
          Number(input.duplicateOverride),
          input.code,
        ),
        auditStatement(
          context,
          'case.created',
          'case',
          id,
          {
            fields: Object.keys(input),
            version: 0,
          },
          id,
        ),
        ...(input.duplicateOverride &&
        input.source === 'manual' &&
        duplicate?.latest
          ? [
              context.env.DB.prepare(
                "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,'duplicate_warning_overridden','case',?,'{}',? WHERE EXISTS(SELECT 1 FROM cases WHERE id=?)",
              ).bind(crypto.randomUUID(), actor.id, id, now, id),
            ]
          : []),
      ]);
      return { kind: 'created' as const, id, caseNo, createdBy: actor.id };
    }),
  edit: protectedProcedure
    .input(caseEditSchema)
    .handler(async ({ context, input }) => {
      const record = await requireCaseAccess(context, input.id, 'case.edit');
      if (record.version !== input.expectedVersion)
        throw new ORPCError('CONFLICT');
      const token = crypto.randomUUID();
      const { id, expectedVersion, ...fields } = input;
      const changed = (Object.keys(fields) as (keyof typeof fields)[]).filter(
        (key) => fields[key] !== record[key],
      );
      if (!changed.length) return { id, version: record.version };
      await atomicCaseWrite(context, [
        context.env.DB.prepare(
          'UPDATE cases SET current_status=NULL,customer_name=?,report_name=NULL,code=?,address=?,amount_due=?,status=?,revisit_status=?,revisit_reason=?,region=?,updated_at=?,version=version+1,write_token=? WHERE id=? AND version=?',
        ).bind(
          input.customerName,
          input.code,
          input.address,
          input.amountDue,
          input.status,
          input.revisitStatus,
          input.revisitReason,
          input.region,
          Date.now(),
          token,
          id,
          expectedVersion,
        ),
        ...(record.status === 'settled' &&
        record.currentStatus === 'direct_to_principal' &&
        input.status === 'settled'
          ? [
              context.env.DB.prepare(
                'UPDATE cases SET current_status=? WHERE id=? AND write_token=?',
              ).bind('direct_to_principal', id, token),
            ]
          : []),
        auditStatement(
          context,
          'case.edited',
          'case',
          id,
          { fields: changed, version: expectedVersion + 1 },
          token,
        ),
        ...(changed.includes('region')
          ? [
              auditStatement(
                context,
                'case.region_changed',
                'case',
                id,
                { fields: ['region'] },
                token,
              ),
            ]
          : []),
        ...(changed.includes('customerName') || changed.includes('code')
          ? [
              auditStatement(
                context,
                'case.customer_code_corrected',
                'case',
                id,
                {
                  fields: changed.filter(
                    (field) => field === 'customerName' || field === 'code',
                  ),
                },
                token,
              ),
            ]
          : []),
      ]);
      return { id, version: expectedVersion + 1 };
    }),
  assign: protectedProcedure
    .input(assignmentSchema)
    .handler(async ({ context, input }) => {
      await requireCaseAccess(context, input.caseId);
      const actor = requirePermission(
        context,
        input.collectorId ? 'assignment.create' : 'assignment.reassign',
      );
      const [current] = await context.DB.select()
        .from(assignments)
        .where(
          and(
            eq(assignments.caseId, input.caseId),
            isNull(assignments.unassignedAt),
          ),
        )
        .limit(1);
      if (current) requirePermission(context, 'assignment.reassign');
      if (
        (current?.collectorId === input.collectorId &&
          current.recordType === 'assignment') ||
        (!current && !input.collectorId)
      )
        throw new ORPCError('CONFLICT', {
          message: 'Assignment is unchanged.',
        });
      const [collector] = input.collectorId
        ? await context.DB.select()
            .from(collectors)
            .where(eq(collectors.id, input.collectorId))
            .limit(1)
        : [];
      if (input.collectorId && (!collector || !collector.isActive))
        throw new ORPCError('BAD_REQUEST', {
          message: 'Choose an active collector.',
        });
      const now = Date.now();
      const token = crypto.randomUUID();
      const activeGuard = input.collectorId
        ? ' AND EXISTS (SELECT 1 FROM collectors WHERE id=? AND is_active=1)'
        : '';
      const first = context.env.DB.prepare(
        `UPDATE cases SET assigned_agent_id=?,updated_at=?,version=version+1,write_token=? WHERE id=? AND version=?${activeGuard}`,
      ).bind(
        collector?.userId ?? null,
        now,
        token,
        input.caseId,
        input.expectedVersion,
        ...(input.collectorId ? [input.collectorId] : []),
      );
      const close = context.env.DB.prepare(
        'UPDATE assignments SET unassigned_at=? WHERE case_id=? AND unassigned_at IS NULL AND EXISTS (SELECT 1 FROM cases WHERE id=? AND write_token=?)',
      ).bind(now, input.caseId, input.caseId, token);
      const assignmentId = crypto.randomUUID();
      const next = input.collectorId
        ? [
            context.env.DB.prepare(
              'INSERT INTO assignments (id,case_id,collector_id,assigned_by_user_id,assigned_at,note) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM cases WHERE id=? AND write_token=?)',
            ).bind(
              assignmentId,
              input.caseId,
              input.collectorId,
              actor.id,
              now,
              input.note,
              input.caseId,
              token,
            ),
          ]
        : [];
      const action = !input.collectorId
        ? 'assignment.unassigned'
        : current
          ? 'assignment.reassigned'
          : 'assignment.created';
      await atomicCaseWrite(context, [
        first,
        close,
        ...next,
        auditStatement(
          context,
          action,
          'case',
          input.caseId,
          {
            collectorId: input.collectorId,
            previousCollectorId: current?.collectorId ?? null,
            version: input.expectedVersion + 1,
          },
          token,
        ),
      ]);
      let telegramWarning: string | null = null;
      if (input.collectorId)
        try {
          const delivery = await queueAssignmentDispatch(context, assignmentId);
          telegramWarning = delivery?.warning ?? null;
        } catch {
          telegramWarning = 'DISPATCH_QUEUE_FAILED';
          await systemLog(context.env.DB, {
            category: 'outbound',
            event: 'DISPATCH_QUEUE_FAILED',
            level: 'error',
            status: 'failed',
            relatedCaseId: input.caseId,
            relatedCollectorId: input.collectorId,
            errorCode: 'DISPATCH_QUEUE_FAILED',
          });
        }
      return {
        id: input.caseId,
        version: input.expectedVersion + 1,
        telegramWarning,
      };
    }),
  assignments: protectedProcedure
    .input(caseIdSchema)
    .handler(async ({ context, input }) => {
      await requireCaseAccess(context, input.id);
      return context.DB.select({
        id: assignments.id,
        collectorId: assignments.collectorId,
        displayName: collectors.displayName,
        collectorCode: collectors.code,
        collectorActive: collectors.isActive,
        assignedBy: sql<string>`coalesce(nullif(${user.name}, ''), ${user.email})`,
        assignedByUserId: assignments.assignedByUserId,
        assignedAt: assignments.assignedAt,
        unassignedAt: assignments.unassignedAt,
        note: assignments.note,
        recordType: assignments.recordType,
        correctedFromId: assignments.correctedFromId,
        correctionReason: assignments.correctionReason,
      })
        .from(assignments)
        .innerJoin(collectors, eq(collectors.id, assignments.collectorId))
        .innerJoin(user, eq(user.id, assignments.assignedByUserId))
        .where(eq(assignments.caseId, input.id))
        .orderBy(desc(assignments.assignedAt), desc(assignments.id));
    }),
  audit: protectedProcedure
    .input(caseIdSchema)
    .handler(async ({ context, input }) => {
      await requireCaseAccess(context, input.id, 'audit_log.view');
      return context.DB.select({
        id: auditLogs.id,
        action: auditLogs.action,
        metadata: auditLogs.metadata,
        createdAt: auditLogs.createdAt,
        userId: auditLogs.userId,
        actor: sql<
          string | null
        >`coalesce(nullif(${user.name}, ''), ${user.email})`,
      })
        .from(auditLogs)
        .leftJoin(user, eq(user.id, auditLogs.userId))
        .where(
          and(
            eq(auditLogs.entityType, 'case'),
            eq(auditLogs.entityId, input.id),
          ),
        )
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(100);
    }),
};

export const collectorsApi = {
  list: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'collector.manage');
    return context.DB.select({
      id: collectors.id,
      displayName: collectors.displayName,
      code: collectors.code,
      isActive: collectors.isActive,
      userId: collectors.userId,
      createdAt: collectors.createdAt,
      updatedAt: collectors.updatedAt,
      version: collectors.version,
    })
      .from(collectors)
      .orderBy(collectors.displayName);
  }),
  choices: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'assignment.create');
    return context.DB.select({
      id: collectors.id,
      displayName: collectors.displayName,
      code: collectors.code,
    })
      .from(collectors)
      .where(eq(collectors.isActive, true))
      .orderBy(collectors.displayName);
  }),
  users: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'collector.manage');
    return context.DB.select({
      id: user.id,
      name: user.name,
      email: user.email,
    })
      .from(user)
      .orderBy(user.name)
      .limit(200);
  }),
  create: protectedProcedure
    .input(collectorCreateSchema)
    .handler(async ({ context, input }) => {
      requirePermission(context, 'collector.manage');
      const id = crypto.randomUUID();
      const now = Date.now();
      await atomicCaseWrite(context, [
        context.env.DB.prepare(
          'INSERT INTO collectors (id,display_name,code,is_active,user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        ).bind(
          id,
          input.displayName,
          input.code,
          input.isActive ? 1 : 0,
          input.userId,
          now,
          now,
        ),
        auditStatement(context, 'collector.created', 'collector', id, {
          fields: Object.keys(input),
        }),
      ]);
      return { id };
    }),
  edit: protectedProcedure
    .input(collectorEditSchema)
    .handler(async ({ context, input }) => {
      requirePermission(context, 'collector.manage');
      const [record] = await context.DB.select()
        .from(collectors)
        .where(eq(collectors.id, input.id))
        .limit(1);
      if (!record) throw new ORPCError('NOT_FOUND');
      const token = crypto.randomUUID();
      // A login link is stable while assignments are active; changing it would transfer access.
      const guard =
        record.userId !== input.userId
          ? ' AND NOT EXISTS (SELECT 1 FROM assignments WHERE collector_id=? AND unassigned_at IS NULL)'
          : '';
      await atomicCaseWrite(context, [
        context.env.DB.prepare(
          `UPDATE collectors SET display_name=?,code=?,is_active=?,user_id=?,updated_at=?,version=version+1,write_token=? WHERE id=? AND version=?${guard}`,
        ).bind(
          input.displayName,
          input.code,
          input.isActive ? 1 : 0,
          input.userId,
          Date.now(),
          token,
          input.id,
          input.expectedVersion,
          ...(guard ? [input.id] : []),
        ),
        auditStatement(
          context,
          record.isActive !== input.isActive
            ? input.isActive
              ? 'collector.activated'
              : 'collector.deactivated'
            : 'collector.edited',
          'collector',
          input.id,
          {
            fields: ['displayName', 'code', 'isActive', 'userId'],
            version: input.expectedVersion + 1,
          },
          token,
        ),
      ]);
      return { id: input.id, version: input.expectedVersion + 1 };
    }),
};
