import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { rpc, testEnv } from './helpers';

/** The pre-auth config probe follows the docs/auth.md env matrix. */

const saved = {
  AUTH_MODE: env.AUTH_MODE,
  ADMIN_EMAILS: env.ADMIN_EMAILS,
  SERVER_URL: env.SERVER_URL,
};

afterEach(() => {
  Object.assign(testEnv, saved);
});

type Status = {
  authMode: string;
  mode: string;
  missing: string[];
  warnings: string[];
};

async function probe(): Promise<Status> {
  const { status, body } = await rpc('config.status', undefined, {
    cookie: null,
  });
  expect(status).toBe(200);
  return body as Status;
}

describe('config.status', () => {
  it('open + local: mail gaps are warnings, not blockers', async () => {
    const s = await probe();
    expect(s.authMode).toBe('open');
    expect(s.mode).toBe('local');
    expect(s.missing).toEqual([]);
    expect(s.warnings).toContain('RESEND_API_KEY');
    expect(s.warnings).toContain('EMAIL_FROM');
  });

  it('open + no ADMIN_EMAILS: warning (no admin channel), not a blocker', async () => {
    testEnv.ADMIN_EMAILS = '';
    const s = await probe();
    expect(s.missing).not.toContain('ADMIN_EMAILS');
    expect(s.warnings).toContain('ADMIN_EMAILS');
  });

  it('admin-only + no ADMIN_EMAILS: blocker (nobody can sign in)', async () => {
    testEnv.AUTH_MODE = 'admin-only';
    testEnv.ADMIN_EMAILS = '';
    const s = await probe();
    expect(s.missing).toContain('ADMIN_EMAILS');
  });

  it('deployed host: mail gaps become blockers', async () => {
    testEnv.SERVER_URL = 'https://starter-server.example.com';
    const s = await probe();
    expect(s.mode).toBe('deployed');
    expect(s.missing).toContain('RESEND_API_KEY');
    expect(s.missing).toContain('EMAIL_FROM');
  });

  it('disabled: nothing is required', async () => {
    testEnv.AUTH_MODE = 'disabled';
    const s = await probe();
    expect(s.authMode).toBe('disabled');
    expect(s.missing).toEqual([]);
    expect(s.warnings).toEqual([]);
  });
});
