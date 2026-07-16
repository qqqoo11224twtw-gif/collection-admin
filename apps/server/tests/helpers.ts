import { env } from 'cloudflare:workers';
import app from '../src/index';

/** Shared harness for the integration tests: sign-in + authed oRPC calls. */

/**
 * Test-mutable view of the worker env. Bindings are typed readonly, but in
 * vitest-pool-workers they are plain values on a shared object — mode tests
 * flip them per case and restore in afterEach.
 */
export const testEnv = env as {
  AUTH_MODE: string;
  ADMIN_EMAILS: string;
  RESEND_API_KEY: string;
  SERVER_URL: string;
};

export const H = {
  'Content-Type': 'application/json',
  Origin: 'http://localhost:3000',
};

/** POST /api/auth/email-otp/send-verification-otp as the login page would. */
export function sendOtp(email: string) {
  return app.fetch(
    new Request('http://localhost/api/auth/email-otp/send-verification-otp', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ email, type: 'sign-in' }),
    }),
  );
}

/**
 * Full passwordless sign-in; returns the session Cookie header value.
 * With no RESEND_API_KEY the OTP never leaves the verification table, so we
 * read it back directly (better-auth stores identifier `sign-in-otp-<email>`,
 * value `<otp>:<attempts>`).
 */
export async function signIn(email: string): Promise<string> {
  const send = await sendOtp(email);
  if (send.status !== 200) throw new Error(`send otp failed ${send.status}`);

  const { results } = await env.DB.prepare(
    'SELECT value FROM verification WHERE identifier = ?',
  )
    .bind(`sign-in-otp-${email}`)
    .all<{ value: string }>();
  const otp = (results.at(-1)?.value ?? '').split(':')[0];

  const res = await app.fetch(
    new Request('http://localhost/api/auth/sign-in/email-otp', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ email, otp }),
    }),
  );
  if (res.status !== 200) throw new Error(`otp sign-in failed ${res.status}`);
  const cookies = res.headers.getSetCookie();
  if (cookies.length === 0) throw new Error('no session cookie set');
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

let cachedUserCookie: Promise<string> | null = null;

/** Session cookie for a plain (non-admin) user, cached per test file. */
export function userCookie(): Promise<string> {
  cachedUserCookie ??= signIn('customer@test.dev');
  return cachedUserCookie;
}

let cachedAdminCookie: Promise<string> | null = null;

/** Session cookie for the default whitelisted admin (cached per test file). */
export function adminCookie(): Promise<string> {
  cachedAdminCookie ??= signIn('boss@test.dev');
  return cachedAdminCookie;
}

/**
 * Call an oRPC procedure. Signed in as the plain user by default (the
 * template's to-C posture); pass `{ cookie: null }` for anonymous calls or
 * an explicit cookie (e.g. `await adminCookie()`) for another session.
 */
export async function rpc(
  path: string,
  input?: unknown,
  opts?: { cookie?: string | null },
) {
  const cookie = opts?.cookie === undefined ? await userCookie() : opts.cookie;
  const resp = await app.fetch(
    new Request(`http://localhost/rpc/${path.replace(/\./g, '/')}`, {
      method: 'POST',
      headers: { ...H, ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ json: input }),
    }),
  );
  const raw = (await resp.json().catch(() => ({}))) as { json?: unknown };
  return { status: resp.status, body: raw.json };
}
