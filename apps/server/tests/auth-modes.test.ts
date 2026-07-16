import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import app from '../src/index';
import { H, rpc, sendOtp, signIn, testEnv } from './helpers';

/**
 * The three AUTH_MODE configurations of the single auth instance
 * (docs/auth.md). authMode() reads env lazily, so tests flip
 * env.AUTH_MODE per case and restore it after.
 */

const DEFAULT_MODE = env.AUTH_MODE;

afterEach(() => {
  testEnv.AUTH_MODE = DEFAULT_MODE;
});

async function userRole(email: string): Promise<string | null> {
  const { results } = await env.DB.prepare(
    'SELECT role FROM user WHERE email = ?',
  )
    .bind(email)
    .all<{ role: string | null }>();
  return results[0]?.role ?? null;
}

describe('open mode (the default)', () => {
  it('lets any email sign up via OTP, as a plain user', async () => {
    const email = 'stranger@example.com';
    const cookie = await signIn(email);
    expect(cookie).toContain('better-auth');
    // The admin plugin's default role for fresh sign-ups.
    expect(await userRole(email)).toBe('user');

    // Signed in but not admin: no admin surface in the demo router, but the
    // session works for protected procedures.
    const { status } = await rpc('todos.getTodos', undefined, { cookie });
    expect(status).toBe(200);
  });

  it('grants ADMIN_EMAILS-listed addresses the admin role on first sign-in (trim + lowercase)', async () => {
    // The binding is intentionally messy: ' Boss@Test.dev '.
    await signIn('boss@test.dev');
    expect(await userRole('boss@test.dev')).toBe('admin');
  });

  it('promotes an existing user when their email is added to ADMIN_EMAILS later, and never auto-demotes', async () => {
    const email = 'late-admin@test.dev';
    const cookie = await signIn(email);
    expect(await userRole(email)).toBe('user');

    const original = env.ADMIN_EMAILS;
    try {
      testEnv.ADMIN_EMAILS = `${original},${email}`;
      // Any session resolution applies the promotion-only sync.
      await rpc('config.status', undefined, { cookie });
      expect(await userRole(email)).toBe('admin');

      // Removing the email from the whitelist must NOT demote.
      testEnv.ADMIN_EMAILS = original;
      await rpc('config.status', undefined, { cookie });
      expect(await userRole(email)).toBe('admin');
    } finally {
      testEnv.ADMIN_EMAILS = original;
    }
  });

  it('rejects anonymous access to protected procedures', async () => {
    const { status } = await rpc('todos.getTodos', undefined, {
      cookie: null,
    });
    expect(status).toBe(401);
  });

  it('keeps public procedures public', async () => {
    const health = await rpc('healthCheck.connection', undefined, {
      cookie: null,
    });
    expect(health.status).toBe(200);
    const planets = await rpc('planet.list', undefined, { cookie: null });
    expect(planets.status).toBe(200);
  });
});

describe('admin-only mode', () => {
  it('rejects non-whitelisted emails with an explicit 403 and writes no verification row', async () => {
    testEnv.AUTH_MODE = 'admin-only';
    const email = 'not-an-admin@example.com';
    const res = await sendOtp(email);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('EMAIL_NOT_ADMIN');

    // The gate runs BEFORE better-auth: a denied email must leave no rows.
    const { results } = await env.DB.prepare(
      'SELECT id FROM verification WHERE identifier = ?',
    )
      .bind(`sign-in-otp-${email}`)
      .all();
    expect(results).toHaveLength(0);
  });

  it('lets whitelisted admins sign in', async () => {
    testEnv.AUTH_MODE = 'admin-only';
    const cookie = await signIn('boss@test.dev');
    const { status } = await rpc('todos.getTodos', undefined, { cookie });
    expect(status).toBe(200);
  });
});

describe('disabled mode', () => {
  it('unmounts the auth surface (404)', async () => {
    testEnv.AUTH_MODE = 'disabled';
    const res = await sendOtp('anyone@example.com');
    expect(res.status).toBe(404);
    const session = await app.fetch(
      new Request('http://localhost/api/auth/get-session', { headers: H }),
    );
    expect(session.status).toBe(404);
  });

  it('fails protected procedures closed with 401 AUTH_DISABLED', async () => {
    testEnv.AUTH_MODE = 'disabled';
    const { status, body } = await rpc('todos.getTodos', undefined, {
      cookie: null,
    });
    expect(status).toBe(401);
    expect(JSON.stringify(body)).toContain('AUTH_DISABLED');
  });

  it('rejects even a previously valid session (fail closed beats stale cookies)', async () => {
    const cookie = await signIn('boss@test.dev');
    testEnv.AUTH_MODE = 'disabled';
    const { status } = await rpc('todos.getTodos', undefined, { cookie });
    expect(status).toBe(401);
  });

  it('unmounts the external key API (404)', async () => {
    testEnv.AUTH_MODE = 'disabled';
    const res = await app.fetch(
      new Request('http://localhost/api/v1/whoami', {
        headers: { Authorization: 'Bearer sfapp_whatever' },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('keeps the public surface up', async () => {
    testEnv.AUTH_MODE = 'disabled';
    const health = await app.fetch(new Request('http://localhost/health'));
    expect(health.status).toBe(200);
    const { status } = await rpc('healthCheck.db', undefined, {
      cookie: null,
    });
    expect(status).toBe(200);
  });
});

describe('AUTH_MODE validation', () => {
  it('fails closed on an unknown mode', async () => {
    testEnv.AUTH_MODE = 'yolo';
    const { status } = await rpc('todos.getTodos', undefined, {
      cookie: null,
    });
    expect(status).toBeGreaterThanOrEqual(500);
  });
});
