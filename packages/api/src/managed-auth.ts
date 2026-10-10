import { env } from 'cloudflare:workers';
import { ORPCError } from '@orpc/server';
import { user } from '@saasflare-dev/db';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { z } from 'zod';
import {
  decryptTotp,
  digest,
  encryptTotp,
  hashAccountPassword,
  newTotpSecret,
  passwordSchema,
  randomToken,
  usernameSchema,
  verifyAccountPassword,
  verifyTotp,
} from './account-crypto';
import { atomicCaseWrite } from './audit';
import type { Context } from './context';
import { PASSWORD_LENGTH_MESSAGE } from './password-policy';
import { systemLog } from './system-log';

type Account = typeof user.$inferSelect;
type Challenge = {
  id: string;
  user_id: string;
  stage: string;
  auth_version: number;
  secret_encrypted: string | null;
  key_version: string | null;
  expires_at: number;
  attempts: number;
};
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const challengeLifetime = 15 * 60 * 1000;
export const SESSION_IDLE_MS = 15 * 60 * 1000;
export const IDLE_MESSAGE = '已超過 15 分鐘未操作，請重新登入。';
const invalidMessage = '帳號或驗證資訊不正確，請重新確認。';
export function managedAuthEnabled() {
  return !(
    String(env.ACCOUNT_AUTH_MODE) === 'legacy-test' && 'TEST_MIGRATIONS' in env
  );
}
function cookieName(kind: 'session' | 'challenge') {
  return `${(env.SERVER_URL ?? '').startsWith('https://') ? '__Secure-' : ''}collection_admin_${kind}`;
}
function readCookie(headers: Headers, kind: 'session' | 'challenge') {
  const name = cookieName(kind);
  return (
    (headers.get('cookie') ?? '')
      .split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ''
  );
}
function cookie(kind: 'session' | 'challenge', value: string, seconds: number) {
  const secure = (env.SERVER_URL ?? '').startsWith('https://');
  return `${cookieName(kind)}=${value}; Path=/; HttpOnly; Max-Age=${seconds}; SameSite=${secure ? 'None' : 'Lax'}${secure ? '; Secure' : ''}`;
}
function response(body: unknown, status = 200, cookies: string[] = []) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(JSON.stringify(body), { status, headers });
}
function accountPublic(record: Account) {
  return {
    id: record.id,
    name: record.name,
    email: record.email,
    username: record.username,
    role: record.role,
    active: record.active,
    permissionAllow: record.permissionAllow,
    permissionDeny: record.permissionDeny,
    permissionVersion: record.permissionVersion,
  };
}
function active(record: Account | null | undefined) {
  return Boolean(
    record?.active &&
      !record.deletedAt &&
      !(
        record.banned &&
        (!record.banExpires || record.banExpires.getTime() > Date.now())
      ),
  );
}
async function account(id: string) {
  const rows = await drizzle(env.DB)
    .select()
    .from(user)
    .where(eq(user.id, id))
    .limit(1);
  return rows[0];
}
export function authAudit(
  db: D1Database,
  actor: string | null,
  action: string,
  entityId: string,
  metadata: Record<string, string | number | boolean | null> = {},
  guard?: { sql: string; values: (string | number)[] },
) {
  const allowed = new Set([
    'username',
    'role',
    'active',
    'operator',
    'oldRole',
    'newRole',
    'fields',
    'before',
    'after',
  ]);
  const safe = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => allowed.has(key)),
  );
  return db
    .prepare(
      `INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,?,'account',?,?,?${guard ? ` WHERE ${guard.sql}` : ''}`,
    )
    .bind(
      crypto.randomUUID(),
      actor,
      action,
      entityId,
      JSON.stringify(safe),
      Date.now(),
      ...(guard?.values ?? []),
    );
}
async function loginLog(action: string, id?: string) {
  await env.DB.batch([
    authAudit(env.DB, id ?? null, action, id ?? 'anonymous'),
  ]);
  await systemLog(env.DB, {
    category: 'auth',
    event: action,
    relatedUserId: id,
    level: action.includes('FAILED') ? 'warning' : 'info',
    status: action.includes('FAILED') ? 'denied' : 'success',
  });
}
function assertOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const allowed = (env.CORS_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim());
  if (!origin || !allowed.includes(origin)) throw new ORPCError('FORBIDDEN');
}
async function limit(
  request: Request,
  scope: string,
  maximum = 10,
  window = 60000,
  accountOnly = false,
) {
  const ip = accountOnly
    ? 'account'
    : (request.headers.get('cf-connecting-ip') ?? 'local');
  const key = `managed-auth:${await digest(`${scope}:${ip}`)}`,
    now = Date.now();
  const row = await env.DB.prepare(
    'INSERT INTO rate_limit(id,key,count,last_request) VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN last_request<? THEN 1 ELSE count+1 END,last_request=CASE WHEN last_request<? THEN excluded.last_request ELSE last_request END RETURNING count',
  )
    .bind(crypto.randomUUID(), key, now, now - window, now - window)
    .first<{ count: number }>();
  if ((row?.count ?? maximum + 1) > maximum)
    throw new ORPCError('TOO_MANY_REQUESTS', {
      message: '嘗試次數過多，請稍後再試。',
    });
}
async function requestBody(request: Request) {
  const text = await request.text();
  if (text.length > 4096) throw new ORPCError('BAD_REQUEST');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ORPCError('BAD_REQUEST');
  }
}
async function getChallenge(headers: Headers, expected?: string, touch = true) {
  const token = readCookie(headers, 'challenge');
  if (!token || token.length > 128)
    throw new ORPCError('UNAUTHORIZED', {
      message: '驗證流程已逾時，請重新登入。',
    });
  const row = await env.DB.prepare(
    'SELECT id,user_id,stage,auth_version,secret_encrypted,key_version,expires_at,attempts FROM managed_auth_challenges WHERE token_hash=?',
  )
    .bind(await digest(token))
    .first<Challenge>();
  const owner = row ? await account(row.user_id) : null;
  if (
    !row ||
    !active(owner) ||
    !owner ||
    row.expires_at <= Date.now() ||
    row.attempts >= 5 ||
    row.auth_version !== owner.authVersion ||
    row.stage === 'completed' ||
    (expected && row.stage !== expected)
  )
    throw new ORPCError('UNAUTHORIZED', {
      message: '驗證流程已逾時，請重新登入。',
    });
  if (!touch) return { row, owner };
  const renewed = Date.now() + SESSION_IDLE_MS;
  const touched = await env.DB.prepare(
    'UPDATE managed_auth_challenges SET expires_at=? WHERE id=? AND expires_at>? AND stage<>?',
  )
    .bind(renewed, row.id, Date.now(), 'completed')
    .run();
  if (!touched.meta.changes)
    throw new ORPCError('UNAUTHORIZED', { message: IDLE_MESSAGE });
  return { row: { ...row, expires_at: renewed }, owner };
}
export async function managedSession(headers: Headers) {
  const token = readCookie(headers, 'session');
  if (!token || token.length > 128) return null;
  const stored = await env.DB.prepare(
    'SELECT id,user_id,auth_version,expires_at,token_hash,coalesce(last_activity_at,created_at) AS last_activity_at FROM managed_sessions WHERE token_hash=? AND expires_at>?',
  )
    .bind(await digest(token), Date.now())
    .first<{
      id: string;
      user_id: string;
      auth_version: number;
      expires_at: number;
      token_hash: string;
      last_activity_at: number;
    }>();
  if (!stored) return null;
  if (Date.now() - stored.last_activity_at >= SESSION_IDLE_MS) {
    await env.DB.prepare('DELETE FROM managed_sessions WHERE id=?')
      .bind(stored.id)
      .run();
    return null;
  }
  const owner = await account(stored.user_id);
  if (
    !owner ||
    !active(owner) ||
    owner.mustChangePassword ||
    !owner.totpEnabled ||
    !owner.passwordHash ||
    owner.authVersion !== stored.auth_version
  )
    return null;
  return {
    user: accountPublic(owner),
    session: {
      id: stored.id,
      token: stored.token_hash,
      expiresAt: new Date(stored.expires_at),
      lastActivityAt: stored.last_activity_at,
    },
  };
}
function recoverySet(userId: string) {
  const codes = Array.from(
    { length: 10 },
    () =>
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      )
        .join('')
        .toUpperCase()
        .match(/.{8}/g)
        ?.join('-') ?? '',
  );
  return {
    codes,
    hashes: Promise.all(
      codes.map((code) =>
        digest(`${userId}:recovery:${code.replaceAll('-', '')}`),
      ),
    ),
  };
}
function sessionStatement(
  id: string,
  tokenHash: string,
  owner: Account,
  guard: string,
  values: (string | number)[],
) {
  return env.DB.prepare(
    `INSERT INTO managed_sessions(id,user_id,token_hash,auth_version,expires_at,created_at,last_activity_at) SELECT ?,?,?,?,?,?,? WHERE ${guard}`,
  ).bind(
    id,
    owner.id,
    tokenHash,
    owner.authVersion,
    Date.now() + sessionLifetime,
    Date.now(),
    Date.now(),
    ...values,
  );
}
export function revokeStatements(
  userId: string,
  guard?: { sql: string; values: (string | number)[] },
) {
  const condition = guard ? ` AND (${guard.sql})` : '';
  return [
    env.DB.prepare(
      `DELETE FROM managed_sessions WHERE user_id=?${condition}`,
    ).bind(userId, ...(guard?.values ?? [])),
    env.DB.prepare(`DELETE FROM session WHERE user_id=?${condition}`).bind(
      userId,
      ...(guard?.values ?? []),
    ),
  ];
}
export async function managedAuthHandler(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname.replace('/api/auth/', '');
  try {
    if (request.method === 'GET' && path === 'onboarding-session') {
      const info = await managedSession(request.headers);
      if (info)
        return response({
          expiresAt: info.session.lastActivityAt + SESSION_IDLE_MS,
        });
      const state = await getChallenge(request.headers, undefined, false);
      return response({ expiresAt: state.row.expires_at });
    }
    if (request.method === 'GET' && path === 'get-session') {
      const info = await managedSession(request.headers);
      return response(
        info
          ? {
              user: info.user,
              session: {
                id: info.session.id,
                expiresAt: info.session.expiresAt,
                lastActivityAt: info.session.lastActivityAt,
              },
            }
          : null,
        info || !readCookie(request.headers, 'session') ? 200 : 401,
      );
    }
    if (request.method !== 'POST') return response({ code: 'NOT_FOUND' }, 404);
    assertOrigin(request);
    if (path === 'activity') {
      const info = await managedSession(request.headers);
      if (!info && readCookie(request.headers, 'challenge')) {
        const state = await getChallenge(request.headers);
        return response({
          lastActivityAt: state.row.expires_at - SESSION_IDLE_MS,
        });
      }
      if (!info)
        return response(
          { code: 'SESSION_IDLE_EXPIRED', message: IDLE_MESSAGE },
          401,
        );
      const now = Date.now();
      const result = await env.DB.prepare(
        'UPDATE managed_sessions SET last_activity_at=? WHERE id=? AND coalesce(last_activity_at,created_at)>? AND expires_at>?',
      )
        .bind(now, info.session.id, now - SESSION_IDLE_MS, now)
        .run();
      if (!result.meta.changes)
        return response(
          { code: 'SESSION_IDLE_EXPIRED', message: IDLE_MESSAGE },
          401,
        );
      return response({ lastActivityAt: now });
    }
    if (path === 'sign-out') {
      const info = await managedSession(request.headers);
      if (info)
        await env.DB.batch([
          env.DB.prepare('DELETE FROM managed_sessions WHERE id=?').bind(
            info.session.id,
          ),
          env.DB.prepare('DELETE FROM session WHERE id=?').bind(
            `managed:${info.session.id}`,
          ),
          authAudit(env.DB, info.user.id, 'SESSION_REVOKED', info.user.id),
        ]);
      return response({ success: true }, 200, [
        cookie('session', '', 0),
        cookie('challenge', '', 0),
      ]);
    }
    // Email OTP and public account registration are never formal login routes.
    if (
      ![
        'login',
        'onboarding/password',
        'onboarding/totp',
        'verify-totp',
        'verify-recovery',
        'change-password',
        'recovery-codes',
      ].includes(path)
    )
      return response(
        {
          code: 'AUTH_ROUTE_RETIRED',
          message: '請使用帳號、密碼與驗證器登入。',
        },
        403,
      );
    const raw = await requestBody(request);
    if (path === 'login') {
      const input = z
        .strictObject({
          username: usernameSchema,
          password: z.string().min(1),
        })
        .parse(raw);
      await limit(request, `login:${input.username}`);
      await limit(request, `account-login:${input.username}`, 15, 60000, true);
      await limit(request, 'login-ip', 30);
      const owner = (
        await drizzle(env.DB)
          .select()
          .from(user)
          .where(eq(user.username, input.username))
          .limit(1)
      )[0];
      const valid = await verifyAccountPassword(
        input.password,
        owner?.passwordHash ?? null,
      );
      if (!valid || !owner || !active(owner)) {
        await loginLog('LOGIN_PASSWORD_FAILED', owner?.id);
        return response(
          { code: 'LOGIN_PASSWORD_FAILED', message: invalidMessage },
          401,
        );
      }
      const stage = owner.mustChangePassword
          ? 'password_change'
          : owner.totpEnabled
            ? 'totp'
            : 'enroll',
        token = randomToken(),
        id = crypto.randomUUID(),
        now = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE managed_auth_challenges SET stage='completed' WHERE user_id=? AND stage<>'completed'",
        ).bind(owner.id),
        env.DB.prepare(
          'INSERT INTO managed_auth_challenges(id,token_hash,user_id,stage,auth_version,expires_at,created_at) VALUES(?,?,?,?,?,?,?)',
        ).bind(
          id,
          await digest(token),
          owner.id,
          stage,
          owner.authVersion,
          now + challengeLifetime,
          now,
        ),
      ]);
      return response({ step: stage }, 200, [
        cookie('challenge', token, challengeLifetime / 1000),
        cookie('session', '', 0),
      ]);
    }
    if (path === 'onboarding/password') {
      const input = z
        .strictObject({
          newPassword: passwordSchema,
          confirmPassword: passwordSchema,
        })
        .refine((value) => value.newPassword === value.confirmPassword)
        .parse(raw);
      const { row, owner } = await getChallenge(
        request.headers,
        'password_change',
      );
      await limit(request, `password-change:${owner.id}`);
      if (await verifyAccountPassword(input.newPassword, owner.passwordHash))
        throw new ORPCError('BAD_REQUEST', {
          message: '新密碼必須與暫時密碼不同。',
        });
      const hash = await hashAccountPassword(input.newPassword),
        stage = owner.totpEnabled ? 'totp' : 'enroll',
        token = randomToken();
      const guard = {
        sql: 'EXISTS(SELECT 1 FROM managed_auth_challenges WHERE id=? AND write_token=?)',
        values: [row.id, token],
      };
      await atomicCaseWrite({ env } as Context, [
        env.DB.prepare(
          "UPDATE managed_auth_challenges SET stage=?,auth_version=auth_version+1,write_token=? WHERE id=? AND stage='password_change' AND expires_at>? AND auth_version=? AND EXISTS(SELECT 1 FROM user WHERE id=user_id AND active=1 AND deleted_at IS NULL AND auth_version=?)",
        ).bind(
          stage,
          token,
          row.id,
          Date.now(),
          owner.authVersion,
          owner.authVersion,
        ),
        env.DB.prepare(
          `UPDATE user SET password_hash=?,must_change_password=0,auth_version=auth_version+1,updated_at=? WHERE id=? AND auth_version=? AND ${guard.sql}`,
        ).bind(hash, Date.now(), owner.id, owner.authVersion, ...guard.values),
        ...revokeStatements(owner.id, guard),
        authAudit(env.DB, owner.id, 'PASSWORD_CHANGED', owner.id, {}, guard),
      ]);
      return response({ step: stage });
    }
    if (path === 'onboarding/totp') {
      z.strictObject({}).parse(raw);
      const { row, owner } = await getChallenge(request.headers, 'enroll');
      await limit(request, `enroll:${owner.id}`);
      if (!row.secret_encrypted) {
        const secret = newTotpSecret(),
          encrypted = await encryptTotp(env, owner.id, secret);
        await env.DB.prepare(
          "UPDATE managed_auth_challenges SET secret_encrypted=?,key_version=? WHERE id=? AND stage='enroll' AND secret_encrypted IS NULL AND auth_version=? AND expires_at>?",
        )
          .bind(
            encrypted.encrypted,
            encrypted.version,
            row.id,
            owner.authVersion,
            Date.now(),
          )
          .run();
      }
      const updated = (await getChallenge(request.headers, 'enroll')).row;
      if (!updated.secret_encrypted || !updated.key_version)
        throw new ORPCError('INTERNAL_SERVER_ERROR');
      const secret = await decryptTotp(
        env,
        owner.id,
        updated.secret_encrypted,
        updated.key_version,
      );
      return response({
        secret,
        uri: `otpauth://totp/${encodeURIComponent(`案件管理後台:${owner.username}`)}?secret=${secret}&issuer=${encodeURIComponent('案件管理後台')}&algorithm=SHA1&digits=6&period=30`,
      });
    }
    if (path === 'verify-totp' || path === 'verify-recovery') {
      const { row, owner } = await getChallenge(request.headers);
      if (!['enroll', 'totp'].includes(row.stage))
        throw new ORPCError('UNAUTHORIZED');
      await limit(request, `verify:${owner.id}`);
      const input = z
        .strictObject({ code: z.string().trim().min(6).max(64) })
        .parse(raw);
      let counter: number | null = null,
        recoveryId: string | null = null;
      if (path === 'verify-recovery') {
        if (row.stage !== 'totp') throw new ORPCError('FORBIDDEN');
        const value = input.code.replaceAll('-', '').toUpperCase();
        recoveryId =
          (
            await env.DB.prepare(
              'SELECT id FROM auth_recovery_codes WHERE user_id=? AND code_hash=? AND used_at IS NULL',
            )
              .bind(owner.id, await digest(`${owner.id}:recovery:${value}`))
              .first<{ id: string }>()
          )?.id ?? null;
      } else {
        const encrypted =
            row.stage === 'enroll' ? row.secret_encrypted : owner.totpEncrypted,
          version =
            row.stage === 'enroll' ? row.key_version : owner.totpKeyVersion;
        if (encrypted && version)
          counter = await verifyTotp(
            await decryptTotp(env, owner.id, encrypted, version),
            input.code,
            row.stage === 'enroll' ? -1 : owner.lastTotpCounter,
          );
      }
      if (counter === null && !recoveryId) {
        await env.DB.batch([
          env.DB.prepare(
            'UPDATE managed_auth_challenges SET attempts=attempts+1 WHERE id=?',
          ).bind(row.id),
          authAudit(env.DB, owner.id, 'LOGIN_TOTP_FAILED', owner.id),
        ]);
        return response(
          { code: 'LOGIN_TOTP_FAILED', message: invalidMessage },
          401,
        );
      }
      const token = randomToken(),
        claim = randomToken(),
        sessionId = crypto.randomUUID(),
        set = row.stage === 'enroll' ? recoverySet(owner.id) : null,
        hashes = set ? await set.hashes : [];
      const guard = {
        sql: 'EXISTS(SELECT 1 FROM managed_auth_challenges WHERE id=? AND write_token=?)',
        values: [row.id, claim],
      };
      await atomicCaseWrite({ env } as Context, [
        env.DB.prepare(
          `UPDATE managed_auth_challenges SET stage='completed',write_token=? WHERE id=? AND stage=? AND expires_at>? AND attempts<5 AND auth_version=? AND EXISTS(SELECT 1 FROM user WHERE id=user_id AND active=1 AND deleted_at IS NULL AND must_change_password=0 AND auth_version=? ${recoveryId ? '' : 'AND last_totp_counter=?'})${recoveryId ? ' AND EXISTS(SELECT 1 FROM auth_recovery_codes WHERE id=? AND used_at IS NULL)' : ''}`,
        ).bind(
          claim,
          row.id,
          row.stage,
          Date.now(),
          owner.authVersion,
          owner.authVersion,
          ...(recoveryId ? [] : [owner.lastTotpCounter]),
          ...(recoveryId ? [recoveryId] : []),
        ),
        ...(recoveryId
          ? [
              env.DB.prepare(
                `UPDATE auth_recovery_codes SET used_at=?,used_token=? WHERE id=? AND used_at IS NULL AND ${guard.sql}`,
              ).bind(Date.now(), claim, recoveryId, ...guard.values),
              authAudit(
                env.DB,
                owner.id,
                'RECOVERY_CODE_USED',
                owner.id,
                {},
                guard,
              ),
            ]
          : [
              env.DB.prepare(
                `UPDATE user SET totp_enabled=1,totp_encrypted=?,totp_key_version=?,last_totp_counter=?,updated_at=? WHERE id=? AND auth_version=? AND ${guard.sql}`,
              ).bind(
                row.stage === 'enroll'
                  ? row.secret_encrypted
                  : owner.totpEncrypted,
                row.stage === 'enroll' ? row.key_version : owner.totpKeyVersion,
                counter,
                Date.now(),
                owner.id,
                owner.authVersion,
                ...guard.values,
              ),
            ]),
        ...(set
          ? [
              env.DB.prepare(
                `DELETE FROM auth_recovery_codes WHERE user_id=? AND ${guard.sql}`,
              ).bind(owner.id, ...guard.values),
              ...hashes.map((hash) =>
                env.DB.prepare(
                  `INSERT INTO auth_recovery_codes(id,user_id,code_hash,created_at) SELECT ?,?,?,? WHERE ${guard.sql}`,
                ).bind(
                  crypto.randomUUID(),
                  owner.id,
                  hash,
                  Date.now(),
                  ...guard.values,
                ),
              ),
              authAudit(env.DB, owner.id, 'TOTP_ENABLED', owner.id, {}, guard),
            ]
          : []),
        sessionStatement(
          sessionId,
          await digest(token),
          owner,
          guard.sql,
          guard.values,
        ),
        authAudit(env.DB, owner.id, 'LOGIN_SUCCESS', owner.id, {}, guard),
      ]);
      return response(
        { success: true, ...(set ? { recoveryCodes: set.codes } : {}) },
        200,
        [
          cookie('session', token, sessionLifetime / 1000),
          cookie('challenge', '', 0),
        ],
      );
    }
    const info = await managedSession(request.headers);
    if (!info) throw new ORPCError('UNAUTHORIZED');
    const owner = await account(info.user.id);
    if (!owner) throw new ORPCError('UNAUTHORIZED');
    await limit(request, `profile:${owner.id}`);
    if (path === 'change-password') {
      const input = z
        .strictObject({
          currentPassword: z.string().min(1),
          newPassword: passwordSchema,
          confirmPassword: passwordSchema,
        })
        .refine((value) => value.newPassword === value.confirmPassword)
        .parse(raw);
      if (
        !(await verifyAccountPassword(
          input.currentPassword,
          owner.passwordHash,
        ))
      )
        throw new ORPCError('UNAUTHORIZED', { message: invalidMessage });
      if (await verifyAccountPassword(input.newPassword, owner.passwordHash))
        throw new ORPCError('BAD_REQUEST', {
          message: '新密碼必須與目前密碼不同。',
        });
      const hash = await hashAccountPassword(input.newPassword),
        token = randomToken(),
        newOwner = { ...owner, authVersion: owner.authVersion + 1 },
        marker = crypto.randomUUID(),
        guard = {
          sql: 'EXISTS(SELECT 1 FROM managed_auth_challenges WHERE id=?)',
          values: [marker],
        };
      await atomicCaseWrite({ env } as Context, [
        env.DB.prepare(
          'UPDATE user SET password_hash=?,auth_version=auth_version+1,updated_at=? WHERE id=? AND auth_version=? AND active=1 AND deleted_at IS NULL',
        ).bind(hash, Date.now(), owner.id, owner.authVersion),
        env.DB.prepare(
          "INSERT INTO managed_auth_challenges(id,token_hash,user_id,stage,auth_version,expires_at,created_at) SELECT ?,?,?,'completed',?,0,? WHERE changes()=1",
        ).bind(marker, marker, owner.id, newOwner.authVersion, Date.now()),
        ...revokeStatements(owner.id, guard),
        env.DB.prepare(
          `UPDATE managed_auth_challenges SET stage='completed' WHERE user_id=? AND ${guard.sql}`,
        ).bind(owner.id, ...guard.values),
        sessionStatement(
          crypto.randomUUID(),
          await digest(token),
          newOwner,
          guard.sql,
          guard.values,
        ),
        authAudit(env.DB, owner.id, 'PASSWORD_CHANGED', owner.id, {}, guard),
        authAudit(env.DB, owner.id, 'SESSION_REVOKED', owner.id, {}, guard),
      ]);
      return response({ success: true }, 200, [
        cookie('session', token, sessionLifetime / 1000),
      ]);
    }
    if (path === 'recovery-codes') {
      const input = z
        .strictObject({
          currentPassword: z.string().min(1),
          code: z.string().regex(/^\d{6}$/),
        })
        .parse(raw);
      if (
        !(await verifyAccountPassword(
          input.currentPassword,
          owner.passwordHash,
        )) ||
        !owner.totpEncrypted ||
        !owner.totpKeyVersion
      )
        throw new ORPCError('UNAUTHORIZED', { message: invalidMessage });
      const counter = await verifyTotp(
        await decryptTotp(
          env,
          owner.id,
          owner.totpEncrypted,
          owner.totpKeyVersion,
        ),
        input.code,
        owner.lastTotpCounter,
      );
      if (counter === null)
        throw new ORPCError('UNAUTHORIZED', { message: invalidMessage });
      const set = recoverySet(owner.id),
        hashes = await set.hashes,
        marker = crypto.randomUUID(),
        guard = {
          sql: 'EXISTS(SELECT 1 FROM managed_auth_challenges WHERE id=?)',
          values: [marker],
        };
      await atomicCaseWrite({ env } as Context, [
        env.DB.prepare(
          'UPDATE user SET last_totp_counter=? WHERE id=? AND last_totp_counter=? AND auth_version=? AND active=1 AND deleted_at IS NULL',
        ).bind(counter, owner.id, owner.lastTotpCounter, owner.authVersion),
        env.DB.prepare(
          "INSERT INTO managed_auth_challenges(id,token_hash,user_id,stage,auth_version,expires_at,created_at) SELECT ?,?,?,'completed',?,0,? WHERE changes()=1",
        ).bind(marker, marker, owner.id, owner.authVersion, Date.now()),
        env.DB.prepare(
          `DELETE FROM auth_recovery_codes WHERE user_id=? AND ${guard.sql}`,
        ).bind(owner.id, ...guard.values),
        ...hashes.map((hash) =>
          env.DB.prepare(
            `INSERT INTO auth_recovery_codes(id,user_id,code_hash,created_at) SELECT ?,?,?,? WHERE ${guard.sql}`,
          ).bind(
            crypto.randomUUID(),
            owner.id,
            hash,
            Date.now(),
            ...guard.values,
          ),
        ),
        authAudit(
          env.DB,
          owner.id,
          'RECOVERY_CODES_REGENERATED',
          owner.id,
          {},
          guard,
        ),
      ]);
      return response({ recoveryCodes: set.codes });
    }
    return response({ code: 'NOT_FOUND' }, 404);
  } catch (error) {
    if (error instanceof ORPCError)
      return response(
        { code: error.code, message: error.message },
        error.status,
      );
    if (error instanceof z.ZodError)
      return response(
        {
          code: 'INVALID_INPUT',
          message: error.issues.some(
            (issue) =>
              ['newPassword', 'confirmPassword'].includes(
                String(issue.path[0]),
              ) && issue.code === 'too_small',
          )
            ? PASSWORD_LENGTH_MESSAGE
            : '請檢查輸入格式。',
        },
        400,
      );
    await systemLog(env.DB, {
      category: 'auth',
      event: 'AUTH_OPERATION_FAILED',
      level: 'error',
      status: 'failed',
      errorCode: 'AUTH_OPERATION_FAILED',
    });
    return response(
      {
        code: 'AUTH_OPERATION_FAILED',
        message: '驗證設定暫時無法使用，請聯絡管理員。',
      },
      500,
    );
  }
}
