import { ORPCError } from '@orpc/server';
import { z } from 'zod';
import {
  hashAccountPassword,
  randomToken,
  usernameSchema,
} from './account-crypto';
import { atomicCaseWrite } from './audit';
import type { Context } from './context';
import { authAudit } from './managed-auth';
import { protectedProcedure } from './middleware';
import {
  PERMISSIONS,
  parseGrants,
  permissionPolicy,
  requirePermission,
} from './permissions';
import { MANAGER_SQL } from './user-management';

const READY_MANAGER_SQL = `${MANAGER_SQL} AND username IS NOT NULL AND password_hash IS NOT NULL AND must_change_password=0 AND totp_enabled=1 AND (coalesce(banned,0)=0 OR (ban_expires IS NOT NULL AND ban_expires<=CAST(strftime('%s','now') AS INTEGER)*1000))`;

const roles = z.enum([
  'admin',
  'manager',
  'user',
  'reviewer',
  'finance',
  'restricted',
]);
const saveSchema = z.strictObject({
  id: z.string().optional(),
  username: usernameSchema,
  name: z.string().trim().min(1).max(120),
  role: roles,
  active: z.boolean(),
  collectorId: z.string().nullable(),
  allow: z.array(z.enum(PERMISSIONS)).default([]),
  deny: z.array(z.enum(PERMISSIONS)).default([]),
  expectedVersion: z.number().int().nonnegative().default(0),
});
const actionSchema = z.strictObject({
  id: z.string(),
  action: z.enum([
    'disable',
    'enable',
    'delete',
    'reset_password',
    'reset_totp',
    'revoke_sessions',
  ]),
  expectedVersion: z.number().int().nonnegative(),
});
type AccountRow = {
  id: string;
  username: string | null;
  name: string;
  role: string;
  active: number;
  deleted_at: number | null;
  permission_allow: string;
  permission_deny: string;
  permission_version: number;
  auth_version: number;
  must_change_password: number;
  totp_enabled: number;
  collector_id: string | null;
};
const projection =
  'u.id,u.username,u.name,u.role,u.active,u.deleted_at,u.permission_allow,u.permission_deny,u.permission_version,u.auth_version,u.must_change_password,u.totp_enabled,(SELECT id FROM collectors WHERE user_id=u.id) collector_id';
function publicRow(row: AccountRow) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    active: Boolean(row.active),
    deletedAt: row.deleted_at,
    allow: parseGrants(row.permission_allow),
    deny: parseGrants(row.permission_deny),
    version: row.permission_version,
    collectorId: row.collector_id,
    mustChangePassword: Boolean(row.must_change_password),
    totpEnabled: Boolean(row.totp_enabled),
  };
}
async function read(context: Context, id: string) {
  return context.env.DB.prepare(`SELECT ${projection} FROM user u WHERE u.id=?`)
    .bind(id)
    .first<AccountRow>();
}
function revocations(context: Context, id: string, marker: string) {
  const guard = 'EXISTS(SELECT 1 FROM managed_auth_challenges WHERE id=?)';
  return [
    context.env.DB.prepare(
      `DELETE FROM managed_sessions WHERE user_id=? AND ${guard}`,
    ).bind(id, marker),
    context.env.DB.prepare(
      `DELETE FROM session WHERE user_id=? AND ${guard}`,
    ).bind(id, marker),
    context.env.DB.prepare(
      `UPDATE managed_auth_challenges SET stage='completed' WHERE user_id=? AND ${guard}`,
    ).bind(id, marker),
  ];
}
function accountAudit(
  context: Context,
  action: string,
  id: string,
  marker: string,
  before: unknown,
  after: unknown,
) {
  return authAudit(
    context.env.DB,
    context.user?.id ?? null,
    action,
    id,
    { before: JSON.stringify(before), after: JSON.stringify(after) },
    {
      sql: 'EXISTS(SELECT 1 FROM managed_auth_challenges WHERE id=?)',
      values: [marker],
    },
  );
}
async function save(context: Context, input: z.infer<typeof saveSchema>) {
  requirePermission(context, 'user_permission.manage');
  const previous = input.id ? await read(context, input.id) : null;
  if (input.id && (!previous || previous.deleted_at))
    throw new ORPCError('NOT_FOUND');
  if (input.role === 'user' && !input.collectorId)
    throw new ORPCError('BAD_REQUEST', {
      message: '外收帳號必須綁定外收人員。',
    });
  if (input.collectorId) {
    const collector = await context.env.DB.prepare(
      'SELECT id,user_id FROM collectors WHERE id=? AND is_active=1',
    )
      .bind(input.collectorId)
      .first<{ id: string; user_id: string | null }>();
    if (!collector || (collector.user_id && collector.user_id !== input.id))
      throw new ORPCError('CONFLICT', {
        message: '外收人員不存在、已停用或已綁定其他帳號。',
      });
  }
  const id = previous?.id ?? crypto.randomUUID(),
    now = Date.now(),
    version = (previous?.auth_version ?? -1) + 1,
    temporaryPassword = previous ? undefined : `${randomToken(24)}!`,
    hash = temporaryPassword
      ? await hashAccountPassword(temporaryPassword)
      : null,
    allow = JSON.stringify([...new Set(input.allow)]),
    deny = JSON.stringify([...new Set(input.deny)]);
  const willManage =
    input.active &&
    permissionPolicy({
      user: {
        id,
        role: input.role,
        permissionAllow: allow,
        permissionDeny: deny,
      } as Context['user'],
    }).permissions.includes('user_permission.manage');
  const collectorGuard =
    '(? IS NULL OR EXISTS(SELECT 1 FROM collectors WHERE id=? AND is_active=1 AND (user_id IS NULL OR user_id=?)))';
  const first = previous
    ? context.env.DB.prepare(
        `UPDATE user SET username=?,name=?,role=?,active=?,permission_allow=?,permission_deny=?,permission_version=permission_version+1,auth_version=auth_version+1,updated_at=? WHERE id=? AND permission_version=? AND deleted_at IS NULL AND (?=1 OR NOT (${MANAGER_SQL}) OR EXISTS(SELECT 1 FROM user other WHERE other.id<>user.id AND ${READY_MANAGER_SQL})) AND ${collectorGuard}`,
      ).bind(
        input.username,
        input.name,
        input.role,
        Number(input.active),
        allow,
        deny,
        now,
        id,
        input.expectedVersion,
        Number(willManage),
        input.collectorId,
        input.collectorId,
        id,
      )
    : context.env.DB.prepare(
        `INSERT INTO user(id,name,email,email_verified,username,password_hash,must_change_password,totp_enabled,auth_version,role,active,permission_allow,permission_deny,created_at,updated_at) SELECT ?,?,?,0,?,?,1,0,0,?,?,?,?,?,? WHERE ${collectorGuard}`,
      ).bind(
        id,
        input.name,
        `${id}@account.invalid`,
        input.username,
        hash,
        input.role,
        Number(input.active),
        allow,
        deny,
        now,
        now,
        input.collectorId,
        input.collectorId,
        id,
      );
  const marker = crypto.randomUUID(),
    guard = 'EXISTS(SELECT 1 FROM managed_auth_challenges WHERE id=?)';
  const markerStatement = context.env.DB.prepare(
    "INSERT INTO managed_auth_challenges(id,token_hash,user_id,stage,auth_version,expires_at,created_at) SELECT ?,?,?,'completed',?,0,? WHERE changes()=1",
  ).bind(marker, marker, id, version, now);
  await atomicCaseWrite(context, [
    first,
    markerStatement,
    ...revocations(context, id, marker),
    context.env.DB.prepare(
      `UPDATE collectors SET user_id=NULL,updated_at=? WHERE user_id=? AND ${guard}`,
    ).bind(now, id, marker),
    ...(input.collectorId
      ? [
          context.env.DB.prepare(
            `UPDATE collectors SET user_id=?,updated_at=? WHERE id=? AND ${guard}`,
          ).bind(id, now, input.collectorId, marker),
        ]
      : []),
    accountAudit(
      context,
      previous ? 'ACCOUNT_UPDATED' : 'ACCOUNT_CREATED',
      id,
      marker,
      previous ? publicRow(previous) : null,
      {
        username: input.username,
        name: input.name,
        role: input.role,
        active: input.active,
        collectorId: input.collectorId,
        allow: input.allow,
        deny: input.deny,
      },
    ),
  ]);
  return { id, temporaryPassword };
}
async function change(context: Context, input: z.infer<typeof actionSchema>) {
  requirePermission(context, 'user_permission.manage');
  const previous = await read(context, input.id);
  if (!previous || previous.deleted_at) throw new ORPCError('NOT_FOUND');
  const now = Date.now(),
    version = previous.auth_version + 1,
    temp =
      input.action === 'reset_password' ? `${randomToken(24)}!` : undefined,
    hash = temp ? await hashAccountPassword(temp) : null;
  const weakening = [
      'disable',
      'delete',
      'reset_password',
      'reset_totp',
    ].includes(input.action),
    lastGuard = weakening
      ? ` AND (NOT (${MANAGER_SQL}) OR EXISTS(SELECT 1 FROM user other WHERE other.id<>user.id AND ${READY_MANAGER_SQL}))`
      : '';
  const clause =
    input.action === 'disable'
      ? 'active=0'
      : input.action === 'enable'
        ? 'active=1'
        : input.action === 'delete'
          ? 'active=0,deleted_at=?'
          : input.action === 'reset_password'
            ? 'password_hash=?,must_change_password=1'
            : input.action === 'reset_totp'
              ? 'totp_enabled=0,totp_encrypted=NULL,totp_key_version=NULL,last_totp_counter=-1'
              : 'active=active';
  const values =
    input.action === 'delete'
      ? [now]
      : input.action === 'reset_password'
        ? [hash]
        : [];
  const marker = crypto.randomUUID();
  await atomicCaseWrite(context, [
    context.env.DB.prepare(
      `UPDATE user SET ${clause},auth_version=auth_version+1,permission_version=permission_version+1,updated_at=? WHERE id=? AND deleted_at IS NULL AND permission_version=?${lastGuard}`,
    ).bind(...values, now, input.id, input.expectedVersion),
    context.env.DB.prepare(
      "INSERT INTO managed_auth_challenges(id,token_hash,user_id,stage,auth_version,expires_at,created_at) SELECT ?,?,?,'completed',?,0,? WHERE changes()=1",
    ).bind(marker, marker, input.id, version, now),
    ...revocations(context, input.id, marker),
    ...(input.action === 'reset_totp' || input.action === 'delete'
      ? [
          context.env.DB.prepare(
            'DELETE FROM auth_recovery_codes WHERE user_id=? AND EXISTS(SELECT 1 FROM managed_auth_challenges WHERE id=?)',
          ).bind(input.id, marker),
        ]
      : []),
    accountAudit(
      context,
      `ACCOUNT_${input.action.toUpperCase()}`,
      input.id,
      marker,
      publicRow(previous),
      { action: input.action },
    ),
  ]);
  return { id: input.id, temporaryPassword: temp };
}
export const accountsApi = {
  collectorChoices: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'user_permission.manage');
    return (
      await context.env.DB.prepare(
        'SELECT id,display_name,user_id FROM collectors WHERE is_active=1 ORDER BY display_name,id',
      ).all<{ id: string; display_name: string; user_id: string | null }>()
    ).results.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      userId: row.user_id,
    }));
  }),
  list: protectedProcedure
    .input(
      z
        .strictObject({ includeDeleted: z.boolean().default(false) })
        .default({ includeDeleted: false }),
    )
    .handler(async ({ context, input }) => {
      requirePermission(context, 'user_permission.manage');
      return (
        await context.env.DB.prepare(
          `SELECT ${projection} FROM user u ${input.includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY u.created_at DESC`,
        ).all<AccountRow>()
      ).results.map(publicRow);
    }),
  save: protectedProcedure
    .input(saveSchema)
    .handler(({ context, input }) => save(context, input)),
  action: protectedProcedure
    .input(actionSchema)
    .handler(({ context, input }) => change(context, input)),
};
