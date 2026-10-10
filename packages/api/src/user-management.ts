import { ORPCError } from '@orpc/server';
import { user } from '@saasflare-dev/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { managedAuthEnabled } from './managed-auth';
import { protectedProcedure } from './middleware';
import {
  PERMISSIONS,
  permissionPolicy,
  requirePermission,
} from './permissions';
import { systemLog } from './system-log';

export const userSaveSchema = z.strictObject({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(120),
  email: z
    .string()
    .trim()
    .email()
    .transform((e) => e.toLowerCase()),
  role: z.enum([
    'admin',
    'manager',
    'user',
    'reviewer',
    'finance',
    'restricted',
  ]),
  active: z.boolean(),
  allow: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
  deny: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
  expectedVersion: z.number().int().nonnegative().default(0),
});
export const MANAGER_SQL =
  "active=1 AND deleted_at IS NULL AND (role='admin' OR EXISTS(SELECT 1 FROM json_each(permission_allow) WHERE value='user_permission.manage')) AND NOT EXISTS(SELECT 1 FROM json_each(permission_deny) WHERE value='user_permission.manage')";
export const usersApi = {
  list: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'user_permission.manage');
    const rows = await context.DB.select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      active: user.active,
      allow: user.permissionAllow,
      deny: user.permissionDeny,
      version: user.permissionVersion,
    }).from(user);
    return rows.map((row) => ({
      ...row,
      effectivePermissions: permissionPolicy({
        user: { ...row, permissionAllow: row.allow, permissionDeny: row.deny },
      }).permissions,
    }));
  }),
  keys: protectedProcedure.handler(({ context }) => {
    requirePermission(context, 'user_permission.manage');
    return PERMISSIONS;
  }),
  save: protectedProcedure
    .input(userSaveSchema)
    .handler(async ({ context, input }) => {
      const actor = requirePermission(context, 'user_permission.manage');
      if (managedAuthEnabled())
        throw new ORPCError('FORBIDDEN', { message: '請使用正式帳號管理。' });
      const existing = input.id
        ? await context.DB.select()
            .from(user)
            .where(eq(user.id, input.id))
            .then((r) => r[0])
        : null;
      if (input.id && !existing) throw new ORPCError('NOT_FOUND');
      const prospective = {
        id: input.id ?? crypto.randomUUID(),
        email: input.email,
        name: input.name,
        role: input.role,
        active: input.active,
        permissionAllow: JSON.stringify([...new Set(input.allow)]),
        permissionDeny: JSON.stringify([...new Set(input.deny)]),
      };
      const willManage =
        input.active &&
        permissionPolicy({ user: prospective }).permissions.includes(
          'user_permission.manage',
        );
      const now = Date.now();
      try {
        const statement = existing
          ? context.env.DB.prepare(
              `UPDATE user SET name=?,email=?,role=?,active=?,permission_allow=?,permission_deny=?,permission_version=permission_version+1,updated_at=? WHERE id=? AND permission_version=? AND (?=1 OR NOT (${MANAGER_SQL}) OR EXISTS(SELECT 1 FROM user other WHERE other.id<>user.id AND ${MANAGER_SQL})) AND (?=1 OR NOT (${MANAGER_SQL}) OR EXISTS(SELECT 1 FROM user other WHERE other.id<>user.id AND ${MANAGER_SQL}))`,
            ).bind(
              input.name,
              input.email,
              input.role,
              Number(input.active),
              prospective.permissionAllow,
              prospective.permissionDeny,
              now,
              existing.id,
              input.expectedVersion,
              Number(willManage),
              Number(existing.email === input.email),
            )
          : context.env.DB.prepare(
              'INSERT INTO user(id,name,email,email_verified,role,active,permission_allow,permission_deny,permission_version,created_at,updated_at) VALUES(?,?,?,0,?,?,?,?,0,?,?)',
            ).bind(
              prospective.id,
              input.name,
              input.email,
              input.role,
              Number(input.active),
              prospective.permissionAllow,
              prospective.permissionDeny,
              now,
              now,
            );
        const result = await context.env.DB.batch([
          statement,
          context.env.DB.prepare(
            "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,'user.permissions_changed','user',?,?,? WHERE changes()=1",
          ).bind(
            crypto.randomUUID(),
            actor.id,
            prospective.id,
            JSON.stringify({
              before: existing
                ? {
                    role: existing.role,
                    active: existing.active,
                    allow: JSON.parse(existing.permissionAllow),
                    deny: JSON.parse(existing.permissionDeny),
                  }
                : null,
              after: {
                role: input.role,
                active: input.active,
                allow: input.allow,
                deny: input.deny,
              },
            }),
            now,
          ),
          context.env.DB.prepare(
            'DELETE FROM session WHERE user_id=? AND EXISTS(SELECT 1 FROM user WHERE id=? AND active=0)',
          ).bind(prospective.id, prospective.id),
        ]);
        if (result[0].meta.changes !== 1)
          throw new ORPCError('CONFLICT', {
            message: '不能停用最後一位權限管理者，或資料已變更。',
          });
      } catch (error: unknown) {
        if (error instanceof ORPCError) throw error;
        throw new ORPCError('CONFLICT', {
          message: 'Email 已存在，或使用者設定衝突。',
        });
      }
      await systemLog(context.env.DB, {
        category: 'permission',
        event: 'USER_PERMISSIONS_UPDATED',
        relatedUserId: prospective.id,
      });
      return { id: prospective.id };
    }),
};
