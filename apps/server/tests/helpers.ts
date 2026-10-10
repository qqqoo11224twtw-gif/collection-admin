import { env } from 'cloudflare:workers';
import app from '../src/index';

/** Historical schedule fixture only; retired public APIs cannot create plans. */
export async function historicalInstallmentFixture(
  caseId: string,
  status: 'active' | 'cancelled' = 'active',
) {
  const actor = await env.DB.prepare(
    "SELECT id FROM user WHERE email='boss@test.dev'",
  ).first<{ id: string }>();
  if (!actor) throw Error('Fixture admin missing');
  const id = crypto.randomUUID(),
    scheduleId = crypto.randomUUID(),
    now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE cases SET status='installment' WHERE id=?").bind(
      caseId,
    ),
    env.DB.prepare(
      "INSERT INTO installment_plans(id,case_id,plan_type,total_amount,deadline_date,status,created_by_user_id,created_at,updated_at) VALUES(?,?,'deadline',5000,'2026-12-31',?,?,?,?)",
    ).bind(id, caseId, status, actor.id, now, now),
    env.DB.prepare(
      "INSERT INTO installment_schedules(id,plan_id,case_id,sequence,due_date,expected_amount,paid_amount,status,created_at,updated_at) VALUES(?,?,?,1,'2026-12-31',5000,0,?,?,?)",
    ).bind(
      scheduleId,
      id,
      caseId,
      status === 'cancelled' ? 'cancelled' : 'pending',
      now,
      now,
    ),
  ]);
  return { id, scheduleId };
}

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
  await provisionUser(email);
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
export async function provisionUser(email: string) {
  email = email.trim().toLowerCase();
  const now = Date.now();
  const admin = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .some((value) => value.trim().toLowerCase() === email);
  await env.DB.prepare(
    'INSERT INTO user(id,name,email,email_verified,role,created_at,updated_at) VALUES(?,?,?,0,?,?,?) ON CONFLICT(email) DO NOTHING',
  )
    .bind(
      crypto.randomUUID(),
      'Fictional test user',
      email,
      admin ? 'admin' : 'user',
      now,
      now,
    )
    .run();
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

/** Explicit fictional financial fixture; never used by the application or staging seed. */
export async function configureFinanceFixture(
  collectorId: string,
  returnRate = 0.5,
  commissionRate = 0,
) {
  const actor = await env.DB.prepare(
    "SELECT id FROM user WHERE email='boss@test.dev'",
  ).first<{ id: string }>();
  if (!actor) throw Error('Fixture admin missing');
  const now = Date.now();
  for (const [kind, rate] of [
    ['return', returnRate],
    ['commission', commissionRate],
  ] as const) {
    await env.DB.prepare(
      'UPDATE collector_finance_settings SET active=0,effective_to=?,updated_at=? WHERE collector_id=? AND kind=? AND active=1',
    )
      .bind(now, now, collectorId, kind)
      .run();
    await env.DB.prepare(
      'INSERT INTO collector_finance_settings(id,collector_id,kind,rate,return_rate,commission_rate,active,effective_from,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?,?,?)',
    )
      .bind(
        crypto.randomUUID(),
        collectorId,
        kind,
        rate,
        kind === 'return' ? rate : null,
        kind === 'commission' ? rate : null,
        now,
        actor.id,
        now,
        actor.id,
        now,
      )
      .run();
  }
}
export async function assignFinanceFixture(caseId: string) {
  let collector = (
    await env.DB.prepare(
      'SELECT collector_id FROM assignments WHERE case_id=? AND unassigned_at IS NULL',
    )
      .bind(caseId)
      .first<{ collector_id: string }>()
  )?.collector_id;
  if (!collector) {
    const actor = await env.DB.prepare(
      "SELECT id FROM user WHERE email='boss@test.dev'",
    ).first<{ id: string }>();
    if (!actor) throw Error('Fixture admin missing');
    collector = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO collectors(id,display_name,code,is_active,created_at,updated_at) VALUES(?,?,?,1,?,?)',
    )
      .bind(collector, '虛構財務 fixture', collector, Date.now(), Date.now())
      .run();
    await env.DB.prepare(
      'INSERT INTO assignments(id,case_id,collector_id,assigned_by_user_id,assigned_at) VALUES(?,?,?,?,?)',
    )
      .bind(crypto.randomUUID(), caseId, collector, actor.id, Date.now())
      .run();
  }
  await configureFinanceFixture(collector);
  return collector;
}
