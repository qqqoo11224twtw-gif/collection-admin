import { env } from 'cloudflare:workers';
import { apiKey } from '@better-auth/api-key';
import {
  account,
  apikey,
  rateLimit,
  session,
  user,
  verification,
} from '@saasflare-dev/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, emailOTP } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { sendEmail } from './email';
import { apiKeySessionHeaders } from './managed-api-key-bridge';
import {
  managedAuthEnabled,
  managedAuthHandler,
  managedSession,
} from './managed-auth';
import { systemLog } from './system-log';

/**
 * Passwordless better-auth on D1 + Drizzle (official core, no
 * better-auth-cloudflare). One way in: a 6-digit email OTP. Sessions live in
 * the D1 `session` table and travel as httpOnly cookies.
 *
 * AUTH_MODE decides who may sign in (see docs/auth.md):
 *   - `disabled`   — no auth at all: routes unmounted, protected procedures 401.
 *   - `open` / `admin-only` — provisioned active users only; no signup.
 * The three modes are configurations of THIS one instance, not parallel
 * systems — the instance itself is mode-independent.
 *
 * The instance is intentionally NOT exported: its plugin-inferred type
 * references zod internals that break declaration emit. Consumers use the
 * explicitly-typed wrappers below.
 */

export type AuthMode = 'disabled' | 'open' | 'admin-only';

/**
 * The template's single auth switch. When unset, the default is
 * environment-aware: `open` locally (the full demo works with zero
 * config) and `disabled` on deployed stages (fail-safe: nothing is
 * exposed until auth is configured on purpose). An unknown value throws
 * — fail closed — though alchemy.run.ts already rejects it at deploy
 * time. See docs/auth.md.
 */
export function authMode(): AuthMode {
  const raw = (env.AUTH_MODE ?? '').trim();
  if (raw === 'disabled' || raw === 'open' || raw === 'admin-only') return raw;
  if (raw) {
    throw new Error(
      `invalid AUTH_MODE "${raw}" — expected disabled | open | admin-only`,
    );
  }
  return (env.SERVER_URL ?? '').startsWith('http://localhost')
    ? 'open'
    : 'disabled';
}

/** Emails granted the admin role (trimmed, lowercased, from ADMIN_EMAILS). */
export function adminEmails(): string[] {
  return (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Whitelist check on a normalized (trim + lowercase) email. */
export function isAdminEmail(email: string): boolean {
  return adminEmails().includes(email.trim().toLowerCase());
}

import pkg from '../../../package.json';

/**
 * Managed API keys. The prefix is the product's namespace, single-sourced
 * from the root package.json `saasflare.apiKeyPrefix` (tasks uses sftask_,
 * notify ntfy_). Permissions are fixed server-side; users never edit them.
 */
export const API_KEY_PREFIX = pkg.saasflare.apiKeyPrefix;
/** Longest selectable expiry (plugin's maxExpiresIn is in DAYS). */
export const API_KEY_MAX_EXPIRES_DAYS = 365;
export const API_KEY_PERMISSIONS = { api: ['access'] };

function buildAuth() {
  const isLocal = (env.SERVER_URL ?? '').startsWith('http://localhost');
  return betterAuth({
    database: drizzleAdapter(drizzle(env.DB), {
      provider: 'sqlite',
      schema: { user, session, account, verification, apikey, rateLimit },
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.SERVER_URL,
    basePath: '/api/auth',
    databaseHooks: {
      user: { create: { before: async () => false } },
      session: {
        create: {
          before: async (data) => {
            const record = await drizzle(env.DB)
              .select()
              .from(user)
              .where(eq(user.id, data.userId))
              .limit(1);
            return record[0]?.active &&
              !(
                record[0].banned &&
                (!record[0].banExpires ||
                  record[0].banExpires.getTime() > Date.now())
              )
              ? { data }
              : false;
          },
        },
      },
    },
    session: {
      // Cache identity only; getSession reloads persisted user/session state
      // before applying authorization, activation and current permissions.
      cookieCache: {
        enabled: true,
        maxAge: 300,
      },
    },
    plugins: [
      // OTP is available only to pre-provisioned active accounts.
      emailOTP({
        disableSignUp: true,
        async sendVerificationOTP({ email, otp }) {
          await sendEmail({
            to: email,
            subject: 'Your sign-in code',
            text: `Your sign-in code is ${otp}\n\nIt expires shortly. If you didn't request this, you can ignore this email.`,
          });
        },
      }),
      admin(),
      // Managed API keys. Prefix and permissions are fixed server-side;
      // expiry is chosen at creation (default: never, ≤365 days when set).
      // The plugin's per-key rate limit defaults to 10 req/day — pure poison
      // for a real API — so it's off (better-auth's request rate limit below
      // is a separate mechanism and stays on).
      apiKey({
        defaultPrefix: API_KEY_PREFIX,
        requireName: true,
        maximumNameLength: 64,
        keyExpiration: {
          // null = keys without an explicit expiresIn never expire.
          defaultExpiresIn: null,
          disableCustomExpiresTime: false,
          // NOTE: unlike expiresIn (seconds), these two are in DAYS.
          minExpiresIn: 1,
          maxExpiresIn: API_KEY_MAX_EXPIRES_DAYS,
        },
        rateLimit: { enabled: false },
        permissions: {
          defaultPermissions: API_KEY_PERMISSIONS,
        },
      }),
    ],
    // Request rate limiting, D1-backed (the `rate_limit` table). Essential in
    // `open` mode: the OTP send endpoint accepts any address, so without a
    // limit anyone can use this deployment as a mail cannon. Off locally
    // (dev + tests) — mirrors better-auth's own prod-on/dev-off default,
    // which never triggers on Workers because there is no NODE_ENV.
    rateLimit: {
      enabled: !isLocal,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/email-otp/send-verification-otp': { window: 60, max: 3 },
      },
    },
    advanced: {
      ipAddress: {
        // Cloudflare sets cf-connecting-ip on every request; x-forwarded-for
        // is the local-dev fallback.
        ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'],
      },
    },
    trustedOrigins: env.CORS_ORIGIN
      ? env.CORS_ORIGIN.split(',').map((origin) => origin.trim())
      : [],
  });
}

// Lazy singleton: `disabled` deployments never construct the instance (and
// so never need auth/email secrets). Mode is fixed per deployment, so caching
// across requests is safe.
let cachedAuth: ReturnType<typeof buildAuth> | null = null;
function getAuth() {
  if (authMode() === 'disabled') {
    throw new Error('auth is disabled (AUTH_MODE=disabled)');
  }
  if (!cachedAuth) cachedAuth = buildAuth();
  return cachedAuth;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  active?: boolean;
  permissionAllow?: string;
  permissionDeny?: string;
  permissionVersion?: number;
  username?: string | null;
}
export interface SessionInfo {
  user: SessionUser;
  session: { id: string; token: string; expiresAt: Date };
}

/** Mounted at /api/auth/* (email-otp, session, sign-out, ...). */
export async function authHandler(request: Request): Promise<Response> {
  if (managedAuthEnabled()) return managedAuthHandler(request);
  const path = new URL(request.url).pathname;
  let relatedUserId: string | undefined;
  if (path.endsWith('/sign-out'))
    relatedUserId = (await getSession(request.headers))?.user.id;
  if (path.endsWith('/get-session'))
    return Response.json(await getSession(request.headers));
  if (request.method === 'GET')
    return Response.json(
      { code: 'FORBIDDEN', message: '此操作未開放。' },
      { status: 403 },
    );
  if (
    request.method === 'POST' &&
    path !== '/api/auth/sign-out' &&
    ![
      '/api/auth/email-otp/send-verification-otp',
      '/api/auth/sign-in/email-otp',
    ].includes(path)
  )
    return Response.json(
      { code: 'FORBIDDEN', message: '此操作未開放。' },
      { status: 403 },
    );
  if (request.method === 'POST' && path !== '/api/auth/sign-out') {
    const body: unknown = await request
      .clone()
      .json()
      .catch(() => null);
    const email =
      body &&
      typeof body === 'object' &&
      'email' in body &&
      typeof body.email === 'string'
        ? body.email.trim().toLowerCase()
        : '';
    const row = await env.DB.prepare(
      'SELECT id,active FROM user WHERE lower(email)=?',
    )
      .bind(email)
      .first<{ id: string; active: number }>();
    if (!row || !row.active) {
      const code = row ? 'USER_INACTIVE' : 'EMAIL_NOT_ALLOWED';
      await systemLog(env.DB, {
        category: 'auth',
        event: code,
        status: 'denied',
        level: 'warning',
        errorCode: code,
        relatedUserId: row?.id,
      });
      return Response.json(
        { code, message: '此帳號未被授權使用本系統。' },
        { status: 403 },
      );
    }
    const normalized = { ...(body as Record<string, unknown>), email };
    relatedUserId = row.id;
    request = new Request(request, { body: JSON.stringify(normalized) });
    await systemLog(env.DB, {
      category: 'otp',
      event: path.includes('send-verification')
        ? 'OTP_REQUESTED'
        : 'OTP_VERIFY_REQUESTED',
      relatedUserId: row.id,
    });
  }
  const response = await getAuth().handler(request);
  if (response.ok && path.includes('/sign-in/'))
    await systemLog(env.DB, {
      category: 'auth',
      event: 'LOGIN_SUCCESS',
      relatedUserId,
    });
  if (request.method === 'POST')
    await systemLog(env.DB, {
      category: 'auth',
      event: path.endsWith('sign-out')
        ? 'LOGOUT'
        : path.includes('sign-in/')
          ? response.ok
            ? 'OTP_VERIFY_SUCCESS'
            : 'OTP_VERIFY_FAILED'
          : 'OTP_REQUEST_FINISHED',
      status: response.ok ? 'success' : 'failed',
      level: response.ok ? 'info' : 'warning',
      relatedUserId,
    });
  return response;
}

/** Safe key metadata: everything a management UI may see. Never the secret. */
export interface ApiKeyMeta {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  enabled: boolean;
  createdAt: Date;
  expiresAt: Date | null;
}

function toApiKeyMeta(k: {
  id: string;
  name?: string | null;
  start?: string | null;
  prefix?: string | null;
  enabled?: boolean | null;
  createdAt: Date;
  expiresAt?: Date | null;
}): ApiKeyMeta {
  return {
    id: k.id,
    name: k.name ?? null,
    start: k.start ?? null,
    prefix: k.prefix ?? null,
    enabled: k.enabled ?? true,
    createdAt: k.createdAt,
    expiresAt: k.expiresAt ?? null,
  };
}

/**
 * Create a managed key for the session user. The returned `key` is the ONLY
 * time the plaintext exists outside the caller's hands; the database stores
 * a hash.
 */
export async function createUserApiKey(
  headers: Headers,
  name: string,
  // Omitted → the plugin default applies (null = never expires).
  expiresInSeconds?: number,
): Promise<ApiKeyMeta & { key: string }> {
  headers = await apiKeySessionHeaders(headers);
  const created = await getAuth().api.createApiKey({
    body: {
      name,
      ...(expiresInSeconds ? { expiresIn: expiresInSeconds } : {}),
    },
    headers,
  });
  return { ...toApiKeyMeta(created), key: created.key };
}

/** List the session user's keys — safe metadata only. */
export async function listUserApiKeys(headers: Headers): Promise<ApiKeyMeta[]> {
  // 1.6 returns a wrapper object, not a bare array.
  headers = await apiKeySessionHeaders(headers);
  const { apiKeys } = await getAuth().api.listApiKeys({ headers });
  return apiKeys.map(toApiKeyMeta);
}

/** Revoke (delete) one of the session user's own keys. */
export async function revokeUserApiKey(
  headers: Headers,
  keyId: string,
): Promise<{ success: boolean }> {
  headers = await apiKeySessionHeaders(headers);
  const result = await getAuth().api.deleteApiKey({
    body: { keyId },
    headers,
  });
  return { success: result.success };
}

/**
 * Verify a Bearer token against the managed keys, requiring the template's
 * fixed permission set. Returns identifiers for structured request logs —
 * never the key material.
 */
export async function verifyApiKey(
  key: string,
): Promise<{ valid: true; keyId: string; userId: string } | { valid: false }> {
  const result = await getAuth().api.verifyApiKey({
    body: { key, permissions: API_KEY_PERMISSIONS },
  });
  if (result.valid && result.key) {
    const owner = await drizzle(env.DB)
      .select({
        active: user.active,
        deletedAt: user.deletedAt,
        mustChangePassword: user.mustChangePassword,
        totpEnabled: user.totpEnabled,
        banned: user.banned,
        banExpires: user.banExpires,
      })
      .from(user)
      .where(eq(user.id, result.key.referenceId))
      .limit(1);
    if (
      !owner[0]?.active ||
      owner[0].deletedAt ||
      (managedAuthEnabled() &&
        (owner[0].mustChangePassword || !owner[0].totpEnabled)) ||
      (owner[0].banned &&
        (!owner[0].banExpires || owner[0].banExpires.getTime() > Date.now()))
    )
      return { valid: false };
    return {
      valid: true,
      keyId: result.key.id,
      // 1.6 renamed the owner column: referenceId is the creating user's id.
      userId: result.key.referenceId,
    };
  }
  return { valid: false };
}

/**
 * Resolve the session from request headers (cookie). Returns null outright in
 * `disabled` mode. Reloads the persisted account and session on every request
 * so activation, revocation and individual grants take effect immediately.
 */
export async function getSession(
  headers: Headers,
): Promise<SessionInfo | null> {
  if (authMode() === 'disabled') return null;
  if (managedAuthEnabled()) return managedSession(headers);
  const s = (await getAuth().api.getSession({ headers })) as SessionInfo | null;
  if (!s) return null;
  const [record] = await drizzle(env.DB)
    .select()
    .from(user)
    .where(eq(user.id, s.user.id))
    .limit(1);
  const stored = await drizzle(env.DB)
    .select({ id: session.id })
    .from(session)
    .where(eq(session.id, s.session.id))
    .limit(1);
  if (
    !record?.active ||
    !stored.length ||
    (record.banned &&
      (!record.banExpires || record.banExpires.getTime() > Date.now()))
  ) {
    await systemLog(env.DB, {
      category: 'auth',
      event: 'USER_INACTIVE',
      status: 'denied',
      level: 'warning',
      relatedUserId: s.user.id,
      errorCode: 'USER_INACTIVE',
    });
    return null;
  }
  s.user = {
    id: record.id,
    name: record.name,
    email: record.email,
    username: record.username ?? undefined,
    role: record.role,
    active: record.active,
    permissionAllow: record.permissionAllow,
    permissionDeny: record.permissionDeny,
    permissionVersion: record.permissionVersion,
  };
  return s;
}
