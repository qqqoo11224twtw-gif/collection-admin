import { ORPCError } from '@orpc/server';
import { z } from 'zod';
import {
  AccessFailure,
  type AccessGroup,
  type AccessProvider,
  accessEmailSchema,
  CloudflareAccessClient,
  groupEmails,
  groupRevision,
} from './cloudflare-access-client';
import type { Context } from './context';
import { protectedProcedure } from './middleware';
import { requirePermission } from './permissions';

export const accessMutationSchema = z.strictObject({
  email: accessEmailSchema,
  action: z.enum(['add', 'enable', 'disable', 'remove']),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  confirmAccountWideRevocation: z.boolean().default(false),
});
type Mutation = z.infer<typeof accessMutationSchema>;
type LocalEmail = {
  id: string;
  email: string;
  active: number;
  sync_status: string;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  updated_by: string | null;
  modified_by: string | null;
};
const messages: Record<string, string> = {
  ACCESS_NOT_CONFIGURED: '尚未設定 Cloudflare Access 連線。',
  ACCESS_PROVIDER_FAILED: 'Cloudflare API 失敗，請重新讀取實際狀態。',
  ACCESS_UNSAFE_GROUP: 'Group 包含非精確 Email 規則，請先由管理員核對設定。',
  ACCESS_CONFLICT: 'Cloudflare 設定已變更，請重新整理後再操作。',
  ACCESS_BUSY: '同步作業尚未完成，請稍後重新同步；不會盲目覆寫 Cloudflare。',
  ACCESS_LAST_EMAIL: '不可停用或移除最後一個有效授權信箱。',
  ACCESS_DUPLICATE: '此授權信箱已存在。',
  ACCESS_CONFIRM_REQUIRED:
    '請確認撤銷此信箱在整個 Cloudflare 帳號下所有 Access 應用的 Session。',
  ACCESS_NOT_FOUND: '找不到授權信箱。',
};
function error(code: string): never {
  throw new ORPCError(
    code === 'ACCESS_CONFLICT' || code === 'ACCESS_BUSY'
      ? 'CONFLICT'
      : 'BAD_REQUEST',
    {
      message: messages[code] ?? 'Access 同步未完成，請重新核對。',
      data: { code },
    },
  );
}
function provider(context: Context) {
  try {
    return new CloudflareAccessClient(
      context.env.ACCESS_ACCOUNT_ID ?? '',
      context.env.ACCESS_GROUP_ID ?? '',
      context.env.ACCESS_API_TOKEN ?? '',
    );
  } catch {
    return error('ACCESS_NOT_CONFIGURED');
  }
}
export class AccessManagementService {
  constructor(
    private readonly db: D1Database,
    private readonly remote: AccessProvider,
    private readonly groupId: string,
    private readonly actor: string,
  ) {}
  private audit(action: string, id: string, metadata: Record<string, unknown>) {
    return this.db
      .prepare(
        "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) VALUES(?,?,?,'access_email',?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        this.actor,
        action,
        id,
        JSON.stringify(metadata),
        Date.now(),
      );
  }
  private async locals() {
    return (
      await this.db
        .prepare(
          'SELECT e.*,u.name AS modified_by FROM access_emails e LEFT JOIN user u ON u.id=e.updated_by WHERE group_id=? ORDER BY e.created_at',
        )
        .bind(this.groupId)
        .all<LocalEmail>()
    ).results;
  }
  async list() {
    const group = await this.remote.getGroup(),
      emails = groupEmails(group);
    const local = await this.locals();
    const items = local.map((row) => ({
      ...row,
      cloudActive: emails.includes(row.email),
      sync_status:
        Boolean(row.active) !== emails.includes(row.email)
          ? 'drift'
          : row.sync_status,
    }));
    for (const email of emails)
      if (!local.some((row) => row.email === email))
        items.push({
          id: email,
          email,
          active: 1,
          cloudActive: true,
          sync_status: 'drift',
          deleted_at: null,
          created_at: 0,
          updated_at: 0,
          updated_by: null,
          modified_by: null,
        });
    return {
      revision: await groupRevision(group),
      items,
      busy: !!(await this.db
        .prepare('SELECT operation_id FROM access_group_locks WHERE group_id=?')
        .bind(this.groupId)
        .first()),
      activeCount: emails.length,
    };
  }
  private async begin(action: string, email: string, revision: string) {
    const id = crypto.randomUUID(),
      now = Date.now();
    const result = await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO access_operations(id,group_id,email,action,status,expected_revision,user_id,created_at) VALUES(?,?,?,?,'pending',?,?,?)",
        )
        .bind(id, this.groupId, email, action, revision, this.actor, now),
      this.db
        .prepare(
          'INSERT OR IGNORE INTO access_group_locks(group_id,operation_id,created_at) VALUES(?,?,?)',
        )
        .bind(this.groupId, id, now),
    ]);
    if (!result[1].meta.changes) {
      await this.db
        .prepare(
          "UPDATE access_operations SET status='failed',error_code='ACCESS_BUSY',finished_at=? WHERE id=?",
        )
        .bind(now, id)
        .run();
      error('ACCESS_BUSY');
    }
    return id;
  }
  private localWrite(
    email: string,
    active: boolean,
    status: string,
    removed: boolean,
  ) {
    const now = Date.now();
    return this.db
      .prepare(
        `INSERT INTO access_emails(id,group_id,email,active,sync_status,deleted_at,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(group_id,email) DO UPDATE SET active=excluded.active,sync_status=excluded.sync_status,deleted_at=excluded.deleted_at,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
      )
      .bind(
        crypto.randomUUID(),
        this.groupId,
        email,
        Number(active),
        status,
        removed ? now : null,
        now,
        now,
        this.actor,
      );
  }
  async mutate(raw: Mutation) {
    const input = accessMutationSchema.parse(raw);
    const removing = input.action === 'disable' || input.action === 'remove';
    if (removing && !input.confirmAccountWideRevocation)
      error('ACCESS_CONFIRM_REQUIRED');
    const operation = await this.begin(
      input.action,
      input.email,
      input.expectedRevision,
    );
    let remoteWriteStarted = false;
    try {
      const group = await this.remote.getGroup();
      if ((await groupRevision(group)) !== input.expectedRevision)
        error('ACCESS_CONFLICT');
      const emails = groupEmails(group),
        local = (await this.locals()).find((row) => row.email === input.email);
      if (
        input.action === 'add' &&
        (emails.includes(input.email) || (local && !local.deleted_at))
      )
        error('ACCESS_DUPLICATE');
      if (input.action !== 'add' && !local && !emails.includes(input.email))
        error('ACCESS_NOT_FOUND');
      if (removing && emails.includes(input.email) && emails.length <= 1)
        error('ACCESS_LAST_EMAIL');
      const desired = removing
        ? emails.filter((email) => email !== input.email)
        : [...new Set([...emails, input.email])].sort();
      const target: AccessGroup = {
        ...group,
        include: desired.map((email) => ({ email: { email } })),
      };
      // Recheck after local validation, before the provider's non-conditional PUT.
      if (
        (await groupRevision(await this.remote.getGroup())) !==
        input.expectedRevision
      )
        error('ACCESS_CONFLICT');
      remoteWriteStarted = true;
      if (JSON.stringify(desired) !== JSON.stringify(emails))
        await this.remote.updateGroup(target);
      const actual = await this.remote.getGroup();
      if (
        JSON.stringify(groupEmails(actual)) !== JSON.stringify(desired) ||
        JSON.stringify(actual.exclude) !== JSON.stringify(group.exclude) ||
        JSON.stringify(actual.require) !== JSON.stringify(group.require) ||
        actual.name !== group.name
      )
        error('ACCESS_CONFLICT');
      let revoked = !removing;
      if (removing) {
        try {
          await this.remote.revokeUser(input.email);
          revoked = true;
        } catch {
          revoked = false;
        }
      }
      await this.db.batch([
        this.localWrite(
          input.email,
          !removing,
          revoked ? 'synced' : 'revoke_failed',
          input.action === 'remove',
        ),
        this.db
          .prepare(
            'UPDATE access_operations SET status=?,error_code=?,finished_at=? WHERE id=?',
          )
          .bind(
            revoked ? 'success' : 'partial',
            revoked ? null : 'ACCESS_REVOKE_FAILED',
            Date.now(),
            operation,
          ),
        this.audit(`ACCESS_EMAIL_${input.action.toUpperCase()}`, operation, {
          email: input.email,
          before: emails.includes(input.email),
          after: !removing,
          revocation: removing
            ? revoked
              ? 'provider_confirmed'
              : 'failed'
            : 'not_requested',
        }),
        this.db
          .prepare(
            'DELETE FROM access_group_locks WHERE group_id=? AND operation_id=?',
          )
          .bind(this.groupId, operation),
      ]);
      return {
        success: revoked,
        partial: !revoked,
        message: revoked
          ? 'Cloudflare 白名單已讀回確認。'
          : '白名單已移除，但 Session 撤銷失敗。請再次停用以安全重試撤銷。',
        revocation:
          removing && revoked ? 'provider_confirmed' : 'not_confirmed',
      };
    } catch (cause) {
      const code =
        cause instanceof AccessFailure
          ? cause.code
          : cause instanceof ORPCError
            ? ((cause.data as { code?: string } | undefined)?.code ??
              'ACCESS_SYNC_FAILED')
            : 'ACCESS_SYNC_FAILED';
      // A timed-out PUT may have succeeded: retain the lock and journal for read-only reconciliation.
      await this.db.batch([
        this.db
          .prepare(
            'UPDATE access_operations SET status=?,error_code=?,finished_at=? WHERE id=?',
          )
          .bind(
            remoteWriteStarted ? 'partial' : 'failed',
            code,
            Date.now(),
            operation,
          ),
        this.audit('ACCESS_EMAIL_SYNC_FAILED', operation, {
          code,
          remoteWriteStarted,
        }),
        ...(!remoteWriteStarted
          ? [
              this.db
                .prepare(
                  'DELETE FROM access_group_locks WHERE group_id=? AND operation_id=?',
                )
                .bind(this.groupId, operation),
            ]
          : []),
      ]);
      return error(code);
    }
  }
  async sync(confirmRecovery: boolean) {
    const lock = await this.db
      .prepare(
        'SELECT operation_id,created_at FROM access_group_locks WHERE group_id=?',
      )
      .bind(this.groupId)
      .first<{ operation_id: string; created_at: number }>();
    // Never steal an in-flight lock. Recovery only reconciles real provider state; no PUT or implicit revoke.
    if (lock && (!confirmRecovery || Date.now() - lock.created_at < 120000))
      error('ACCESS_BUSY');
    const group = await this.remote.getGroup(),
      revision = await groupRevision(group);
    let operation: string;
    if (lock) {
      operation = crypto.randomUUID();
      const recovered = await this.db.batch([
        this.db
          .prepare(
            "INSERT INTO access_operations(id,group_id,email,action,status,expected_revision,user_id,created_at) VALUES(?,?,'','sync','pending',?,?,?)",
          )
          .bind(operation, this.groupId, revision, this.actor, Date.now()),
        this.db
          .prepare(
            'UPDATE access_group_locks SET operation_id=?,created_at=? WHERE group_id=? AND operation_id=? AND created_at=?',
          )
          .bind(
            operation,
            Date.now(),
            this.groupId,
            lock.operation_id,
            lock.created_at,
          ),
      ]);
      if (!recovered[1].meta.changes) {
        await this.db
          .prepare(
            "UPDATE access_operations SET status='failed',error_code='ACCESS_BUSY',finished_at=? WHERE id=?",
          )
          .bind(Date.now(), operation)
          .run();
        error('ACCESS_BUSY');
      }
    } else operation = await this.begin('sync', '', revision);
    try {
      if ((await groupRevision(await this.remote.getGroup())) !== revision)
        error('ACCESS_CONFLICT');
      const emails = groupEmails(group),
        local = await this.locals();
      const pending = lock
        ? await this.db
            .prepare('SELECT email,action FROM access_operations WHERE id=?')
            .bind(lock.operation_id)
            .first<{ email: string; action: string }>()
        : null;
      const all = [...new Set([...emails, ...local.map((row) => row.email)])];
      await this.db.batch([
        ...all.map((email) => {
          const prior = local.find((row) => row.email === email),
            active = emails.includes(email);
          const needsRevoke =
            !active &&
            (prior?.active ||
              prior?.sync_status === 'revoke_failed' ||
              prior?.sync_status === 'revoke_pending' ||
              (pending?.email === email &&
                ['disable', 'remove'].includes(pending.action)));
          return this.localWrite(
            email,
            active,
            needsRevoke ? 'revoke_pending' : 'synced',
            !active &&
              (Boolean(prior?.deleted_at) ||
                (pending?.email === email && pending.action === 'remove')),
          );
        }),
        this.db
          .prepare(
            "UPDATE access_operations SET status='reconciled',finished_at=? WHERE id=?",
          )
          .bind(Date.now(), operation),
        ...(lock
          ? [
              this.db
                .prepare(
                  "UPDATE access_operations SET status='reconciled',finished_at=? WHERE id=?",
                )
                .bind(Date.now(), lock.operation_id),
            ]
          : []),
        this.audit('ACCESS_EMAIL_RECONCILED', operation, {
          count: emails.length,
          recovered: !!lock,
        }),
        this.db
          .prepare(
            'DELETE FROM access_group_locks WHERE group_id=? AND operation_id=?',
          )
          .bind(this.groupId, operation),
      ]);
      return this.list();
    } catch {
      error('ACCESS_BUSY');
    }
  }
  async history() {
    return (
      await this.db
        .prepare(
          'SELECT o.id,o.email,o.action,o.status,o.error_code,o.created_at,o.finished_at,u.name AS operator FROM access_operations o JOIN user u ON u.id=o.user_id WHERE group_id=? ORDER BY created_at DESC LIMIT 100',
        )
        .bind(this.groupId)
        .all()
    ).results;
  }
}
function service(context: Context) {
  const actor = requirePermission(context, 'access.manage');
  return new AccessManagementService(
    context.env.DB,
    provider(context),
    context.env.ACCESS_GROUP_ID ?? '',
    actor.id,
  );
}
export const accessApi = {
  protection: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'access.manage');
    return provider(context).inspectProtection(
      context.env.ACCESS_APPLICATION_ID ?? '',
      context.env.ACCESS_HOSTNAME ?? '',
    );
  }),
  list: protectedProcedure.handler(({ context }) => service(context).list()),
  mutate: protectedProcedure
    .input(accessMutationSchema)
    .handler(({ context, input }) => service(context).mutate(input)),
  sync: protectedProcedure
    .input(z.strictObject({ confirmRecovery: z.boolean().default(false) }))
    .handler(({ context, input }) =>
      service(context).sync(input.confirmRecovery),
    ),
  history: protectedProcedure.handler(({ context }) =>
    service(context).history(),
  ),
};
