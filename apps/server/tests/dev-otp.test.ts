import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import app from '../src/index';
import { provisionUser, sendOtp, testEnv } from './helpers';

/**
 * The dev-only OTP readback endpoint powering local E2E sign-in. It must not
 * exist as soon as real mail delivery is configured (deployed stages enforce
 * that fail-closed in alchemy.run.ts) or when auth is off entirely.
 */

const saved = { RESEND_API_KEY: env.RESEND_API_KEY, AUTH_MODE: env.AUTH_MODE };
afterEach(() => {
  Object.assign(testEnv, saved);
});

function readOtp(email: string) {
  return app.fetch(
    new Request(
      `http://localhost/api/dev/otp?email=${encodeURIComponent(email)}`,
    ),
  );
}

describe('/api/dev/otp', () => {
  it('returns the latest code for an email (local dev, no mail key)', async () => {
    const email = 'otp-readback@example.com';
    await provisionUser(email);
    expect((await sendOtp(email)).status).toBe(200);
    const res = await readOtp(email);
    expect(res.status).toBe(200);
    const { otp } = (await res.json()) as { otp: string };
    expect(otp).toMatch(/^\d{6}$/);
  });

  it('requires an email parameter', async () => {
    const res = await app.fetch(new Request('http://localhost/api/dev/otp'));
    expect(res.status).toBe(400);
  });

  it('does not exist once a mail key is configured', async () => {
    testEnv.RESEND_API_KEY = 're_test_key';
    expect((await readOtp('otp-readback@example.com')).status).toBe(404);
  });

  it('does not exist in disabled mode', async () => {
    testEnv.AUTH_MODE = 'disabled';
    expect((await readOtp('otp-readback@example.com')).status).toBe(404);
  });
});
