import { env } from 'cloudflare:workers';
import {
  decryptTotp,
  digest,
  encryptTotp,
  hashAccountPassword,
  newTotpSecret,
  passwordSchema,
  randomToken,
  totpCode,
  verifyAccountPassword,
  verifyTotp,
} from '@saasflare-dev/api/account-crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import app from '../src/index';
import { H, rpc } from './helpers';

vi.setConfig({ testTimeout: 120000, hookTimeout: 30000 });
const settings = env as unknown as { ACCOUNT_AUTH_MODE: string };
const password = 'Fictional-test-password-2026!';
let hash: string, admin: string, adminId: string;
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
async function request(path: string, body: unknown, cookie = '') {
  return app.fetch(
    new Request(`http://localhost/api/auth/${path}`, {
      method: 'POST',
      headers: { ...H, Cookie: cookie },
      body: JSON.stringify(body),
    }),
  );
}
async function fixture(ready = false, role = 'restricted') {
  const id = crypto.randomUUID(),
    username = `test-${id}`,
    secret = newTotpSecret(),
    encrypted = await encryptTotp(env, id, secret);
  await env.DB.prepare(
    'INSERT INTO user(id,name,email,email_verified,username,password_hash,must_change_password,totp_enabled,totp_encrypted,totp_key_version,role,active,created_at,updated_at) VALUES(?,?,?,0,?,?,?,?,?,?,?,1,?,?)',
  )
    .bind(
      id,
      '虛構帳號',
      `${id}@example.test`,
      username,
      hash,
      ready ? 0 : 1,
      ready ? 1 : 0,
      encrypted.encrypted,
      encrypted.version,
      role,
      Date.now(),
      Date.now(),
    )
    .run();
  return { id, username, secret };
}
async function fullCookie(id: string) {
  const token = randomToken();
  await env.DB.prepare(
    'INSERT INTO managed_sessions(id,user_id,token_hash,auth_version,expires_at,created_at) VALUES(?,?,?,0,?,?)',
  )
    .bind(
      crypto.randomUUID(),
      id,
      await digest(token),
      Date.now() + 24 * 60 * 60 * 1000,
      Date.now(),
    )
    .run();
  return `collection_admin_session=${token}`;
}
beforeAll(async () => {
  settings.ACCOUNT_AUTH_MODE = 'managed';
  hash = await hashAccountPassword(password);
  const owner = await fixture(true, 'admin');
  adminId = owner.id;
  admin = await fullCookie(owner.id);
});
afterAll(() => {
  settings.ACCOUNT_AUTH_MODE = 'legacy-test';
});
it('idle time is per session: polling does not extend, real activity extends, 15:00 expires without revival', async () => {
  const owner = await fixture(true),
    cookie = await fullCookie(owner.id);
  const session = () =>
    app.fetch(
      new Request('http://localhost/api/auth/get-session', {
        headers: { ...H, Cookie: cookie },
      }),
    );
  const age = async (milliseconds: number) =>
    env.DB.prepare(
      'UPDATE managed_sessions SET last_activity_at=? WHERE user_id=?',
    )
      .bind(Date.now() - milliseconds, owner.id)
      .run();
  await age(14 * 60 * 1000 + 59000);
  const before = await env.DB.prepare(
    'SELECT last_activity_at FROM managed_sessions WHERE user_id=?',
  )
    .bind(owner.id)
    .first();
  expect(await (await session()).json()).toBeTruthy();
  expect(
    await env.DB.prepare(
      'SELECT last_activity_at FROM managed_sessions WHERE user_id=?',
    )
      .bind(owner.id)
      .first(),
  ).toEqual(before);
  expect((await request('activity', {}, cookie)).status).toBe(200);
  expect(await (await session()).json()).toBeTruthy();
  for (let index = 0; index < 3; index++) {
    await age(14 * 60 * 1000);
    expect((await request('activity', {}, cookie)).status).toBe(200);
  }
  await age(15 * 60 * 1000);
  expect((await rpc('cases.list', {}, { cookie })).status).toBe(401);
  expect((await request('activity', {}, cookie)).status).toBe(401);
  expect(await (await session()).json()).toBeNull();
});
it('password hashing and RFC 6238 vectors, counter replay and skew checks', async () => {
  expect(hash).not.toContain(password);
  expect(await verifyAccountPassword(password, hash)).toBe(true);
  expect(await verifyAccountPassword('wrong', hash)).toBe(false);
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  expect(await totpCode(secret, 1)).toBe('287082');
  expect(await verifyTotp(secret, '287082', -1, 59000)).toBe(1);
  expect(await verifyTotp(secret, '287082', 1, 59000)).toBeNull();
  expect(await verifyTotp(secret, '287082', -1, 180000)).toBeNull();
});
it('onboarding idle reads do not extend the challenge and expired onboarding cannot resume', async () => {
  const owner = await fixture();
  const login = await request('login', { username: owner.username, password });
  const cookie = cookies(login);
  const read = () =>
    app.fetch(
      new Request('http://localhost/api/auth/onboarding-session', {
        headers: { ...H, Cookie: cookie },
      }),
    );
  const before = await env.DB.prepare(
    'SELECT expires_at FROM managed_auth_challenges WHERE user_id=?',
  )
    .bind(owner.id)
    .first();
  expect((await read()).status).toBe(200);
  expect(
    await env.DB.prepare(
      'SELECT expires_at FROM managed_auth_challenges WHERE user_id=?',
    )
      .bind(owner.id)
      .first(),
  ).toEqual(before);
  expect((await request('activity', {}, cookie)).status).toBe(200);
  await env.DB.prepare(
    'UPDATE managed_auth_challenges SET expires_at=? WHERE user_id=?',
  )
    .bind(Date.now() - 1, owner.id)
    .run();
  expect((await read()).status).toBe(401);
  expect(
    (
      await request(
        'onboarding/password',
        { newPassword: '123456', confirmPassword: '123456' },
        cookie,
      )
    ).status,
  ).toBe(401);
});
it('email OTP, registration and dev OTP are retired', async () => {
  expect(
    (
      await request('email-otp/send-verification-otp', {
        email: 'fictional@example.test',
      })
    ).status,
  ).toBe(403);
  expect(
    (await request('sign-up/email', { email: 'fictional@example.test' }))
      .status,
  ).toBe(403);
  expect(
    (
      await app.fetch(
        new Request(
          'http://localhost/api/dev/otp?email=fictional@example.test',
        ),
      )
    ).status,
  ).toBe(404);
});
it('forced password change and TOTP enrolment happen before a complete session; recovery is one-use', async () => {
  const owner = await fixture();
  const login = await request('login', {
    username: owner.username.toUpperCase(),
    password,
  });
  expect(login.status).toBe(200);
  expect(await login.json()).toMatchObject({ step: 'password_change' });
  const challenge = cookies(login);
  expect((await rpc('cases.list', {}, { cookie: challenge })).status).toBe(401);
  expect(
    (await request('verify-totp', { code: '123456' }, challenge)).status,
  ).toBe(401);
  const newPassword = 'Fictional-new-password-2026!';
  expect(
    (
      await request(
        'onboarding/password',
        { newPassword, confirmPassword: newPassword },
        challenge,
      )
    ).status,
  ).toBe(200);
  const enrollment = await request('onboarding/totp', {}, challenge),
    body = (await enrollment.json()) as { secret: string; uri: string };
  expect(body.uri).toContain('otpauth://');
  const stored = await env.DB.prepare(
    "SELECT secret_encrypted FROM managed_auth_challenges WHERE user_id=? AND stage='enroll'",
  )
    .bind(owner.id)
    .first<{ secret_encrypted: string }>();
  expect(stored?.secret_encrypted).not.toContain(body.secret);
  const code = await totpCode(body.secret, Math.floor(Date.now() / 30000)),
    verified = await request('verify-totp', { code }, challenge);
  expect(verified.status).toBe(200);
  const completed = (await verified.json()) as { recoveryCodes: string[] };
  expect(completed.recoveryCodes).toHaveLength(10);
  const full = cookies(verified);
  expect(
    (await rpc('cases.permissions', undefined, { cookie: full })).status,
  ).toBe(200);
  expect((await request('verify-totp', { code }, challenge)).status).toBe(401);
  const session = await app.fetch(
    new Request('http://localhost/api/auth/get-session', {
      headers: { Cookie: full },
    }),
  );
  const serialized = await session.text();
  expect(serialized).not.toContain(body.secret);
  expect(serialized).not.toContain('token');
  expect(serialized).not.toContain('passwordHash');
  await request('sign-out', {}, full);
  expect(
    (await rpc('cases.permissions', undefined, { cookie: full })).status,
  ).toBe(401);
  const second = await request('login', {
    username: owner.username,
    password: newPassword,
  });
  const recovery = await request(
    'verify-recovery',
    { code: completed.recoveryCodes[0] },
    cookies(second),
  );
  expect(recovery.status).toBe(200);
  const third = await request('login', {
    username: owner.username,
    password: newPassword,
  });
  expect(
    (
      await request(
        'verify-recovery',
        { code: completed.recoveryCodes[0] },
        cookies(third),
      )
    ).status,
  ).toBe(401);
});
it('CSRF origin and disabled/deleted account sessions are denied', async () => {
  const owner = await fixture(true);
  const cookie = await fullCookie(owner.id);
  const denied = await app.fetch(
    new Request('http://localhost/api/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: 'https://untrusted.example',
      },
      body: '{}',
    }),
  );
  expect(denied.status).toBe(403);
  await env.DB.prepare('UPDATE user SET active=0 WHERE id=?')
    .bind(owner.id)
    .run();
  expect((await rpc('cases.permissions', undefined, { cookie })).status).toBe(
    401,
  );
});
it('admin creates an account with one-time password, normalized username, safe list and version conflict', async () => {
  const input = {
    username: `CASE-MANAGER-${crypto.randomUUID()}`,
    name: '虛構管理者',
    role: 'restricted',
    active: true,
    collectorId: null,
    allow: [],
    deny: [],
    expectedVersion: 0,
  };
  const created = await rpc('accounts.save', input, { cookie: admin });
  expect(created.status).toBe(200);
  const result = created.body as { id: string; temporaryPassword: string };
  expect(result.temporaryPassword.length).toBeGreaterThan(24);
  const listing = await rpc('accounts.list', {}, { cookie: admin });
  expect(JSON.stringify(listing.body)).not.toContain(result.temporaryPassword);
  expect(JSON.stringify(listing.body)).not.toContain('password_hash');
  expect(
    (
      await rpc(
        'accounts.save',
        { ...input, username: input.username.toLowerCase() },
        { cookie: admin },
      )
    ).status,
  ).toBe(409);
  const updated = await rpc(
    'accounts.save',
    { ...input, id: result.id, name: '虛構更新' },
    { cookie: admin },
  );
  expect(updated.status).toBe(200);
  expect(
    (
      await rpc(
        'accounts.save',
        { ...input, id: result.id, name: '不得覆蓋' },
        { cookie: admin },
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await env.DB.prepare('SELECT name FROM user WHERE id=?')
        .bind(result.id)
        .first()
    )?.name,
  ).toBe('虛構更新');
});
it('soft delete preserves account history; collector and restricted cannot manage accounts', async () => {
  const owner = await fixture(true);
  const own = await fullCookie(owner.id);
  expect((await rpc('accounts.list', {}, { cookie: own })).status).toBe(403);
  const result = await rpc(
    'accounts.action',
    { id: owner.id, action: 'delete', expectedVersion: 0 },
    { cookie: admin },
  );
  expect(result.status).toBe(200);
  expect(
    (await rpc('cases.permissions', undefined, { cookie: own })).status,
  ).toBe(401);
  expect(
    (
      await env.DB.prepare('SELECT deleted_at FROM user WHERE id=?')
        .bind(owner.id)
        .first()
    )?.deleted_at,
  ).toBeTruthy();
  const rows = (
    await env.DB.prepare(
      "SELECT metadata FROM audit_logs WHERE entity_type='account'",
    ).all<{ metadata: string }>()
  ).results;
  expect(JSON.stringify(rows)).not.toContain(password);
  expect(JSON.stringify(rows)).not.toContain('scrypt$');
});
it('last permission manager cannot be disabled, deleted or reset', async () => {
  for (const action of ['disable', 'delete', 'reset_password', 'reset_totp'])
    expect(
      (
        await rpc(
          'accounts.action',
          { id: adminId, action, expectedVersion: 0 },
          { cookie: admin },
        )
      ).status,
    ).toBe(409);
});
it('existing API key management remains scoped to a fully enrolled session', async () => {
  const owner = await fixture(true),
    cookie = await fullCookie(owner.id);
  const created = await rpc(
    'apiKeys.create',
    { name: '虛構 API key' },
    { cookie },
  );
  expect(created.status).toBe(200);
  const result = created.body as { key: string; id: string };
  expect(result.key).toBeTruthy();
  const listed = await rpc('apiKeys.list', undefined, { cookie });
  expect(listed.status).toBe(200);
  expect(JSON.stringify(listed.body)).not.toContain(result.key);
  const other = await fixture(true);
  const denied = await rpc(
    'apiKeys.revoke',
    { keyId: result.id },
    { cookie: await fullCookie(other.id) },
  );
  expect(denied.status).not.toBe(200);
});

it('encrypted TOTP is bound to user and key version, never plaintext', async () => {
  const id = crypto.randomUUID(),
    secret = newTotpSecret(),
    encrypted = await encryptTotp(env, id, secret);
  expect(encrypted.encrypted).not.toContain(secret);
  expect(
    await decryptTotp(env, id, encrypted.encrypted, encrypted.version),
  ).toBe(secret);
  await expect(
    decryptTotp(
      env,
      crypto.randomUUID(),
      encrypted.encrypted,
      encrypted.version,
    ),
  ).rejects.toThrow();
});
it('TOTP challenge attempts and expiry fail closed', async () => {
  const owner = await fixture(true);
  const login = await request('login', { username: owner.username, password });
  expect(login.status).toBe(200);
  const cookie = cookies(login);
  for (let i = 0; i < 5; i++)
    expect(
      (await request('verify-totp', { code: 'INVALID' }, cookie)).status,
    ).toBe(401);
  expect(
    (
      await request(
        'verify-totp',
        { code: await totpCode(owner.secret, Math.floor(Date.now() / 30000)) },
        cookie,
      )
    ).status,
  ).toBe(401);
  const next = await request('login', { username: owner.username, password });
  await env.DB.prepare(
    'UPDATE managed_auth_challenges SET expires_at=0 WHERE user_id=?',
  )
    .bind(owner.id)
    .run();
  expect(
    (
      await request(
        'verify-totp',
        { code: await totpCode(owner.secret, Math.floor(Date.now() / 30000)) },
        cookies(next),
      )
    ).status,
  ).toBe(401);
});
it('reset password, reset TOTP and disable revoke sessions and keep audit history', async () => {
  const owner = await fixture(true);
  const old = await fullCookie(owner.id);
  const reset = await rpc(
    'accounts.action',
    { id: owner.id, action: 'reset_password', expectedVersion: 0 },
    { cookie: admin },
  );
  expect(reset.status).toBe(200);
  expect(
    (reset.body as { temporaryPassword: string }).temporaryPassword,
  ).toBeTruthy();
  expect(
    (await rpc('cases.permissions', undefined, { cookie: old })).status,
  ).toBe(401);
  const changed = await request('login', {
    username: owner.username,
    password: (reset.body as { temporaryPassword: string }).temporaryPassword,
  });
  expect(await changed.json()).toMatchObject({ step: 'password_change' });
  expect(
    (
      await request(
        'onboarding/password',
        { newPassword: 'abc123', confirmPassword: 'abc123' },
        cookies(changed),
      )
    ).status,
  ).toBe(200);
  const updated = await env.DB.prepare(
    'SELECT password_hash FROM user WHERE id=?',
  )
    .bind(owner.id)
    .first<{ password_hash: string }>();
  expect(
    await verifyAccountPassword('abc123', updated?.password_hash ?? null),
  ).toBe(true);
  expect(
    (reset.body as { temporaryPassword: string }).temporaryPassword.length,
  ).toBeGreaterThan(24);
  expect(
    (
      await rpc(
        'accounts.action',
        { id: owner.id, action: 'reset_totp', expectedVersion: 1 },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  expect(
    await env.DB.prepare(
      'SELECT totp_encrypted,totp_enabled FROM user WHERE id=?',
    )
      .bind(owner.id)
      .first(),
  ).toMatchObject({ totp_encrypted: null, totp_enabled: 0 });
  expect(
    (
      await rpc(
        'accounts.action',
        { id: owner.id, action: 'disable', expectedVersion: 2 },
        { cookie: admin },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request('login', {
        username: owner.username,
        password: (reset.body as { temporaryPassword: string })
          .temporaryPassword,
      })
    ).status,
  ).toBe(401);
});

it('profile password change revokes old sessions and recovery regeneration requires a fresh authenticator code', async () => {
  const owner = await fixture(true),
    old = await fullCookie(owner.id),
    newPassword = 'abcdef';
  const changed = await request(
    'change-password',
    { currentPassword: password, newPassword, confirmPassword: newPassword },
    old,
  );
  expect(changed.status).toBe(200);
  expect(
    (await rpc('cases.permissions', undefined, { cookie: old })).status,
  ).toBe(401);
  const current = cookies(changed);
  expect(
    (await rpc('cases.permissions', undefined, { cookie: current })).status,
  ).toBe(200);
  const code = await totpCode(owner.secret, Math.floor(Date.now() / 30000)),
    recovery = await request(
      'recovery-codes',
      { currentPassword: newPassword, code },
      current,
    );
  expect(recovery.status).toBe(200);
  expect(
    ((await recovery.json()) as { recoveryCodes: string[] }).recoveryCodes,
  ).toHaveLength(10);
  expect(
    (
      await request(
        'recovery-codes',
        { currentPassword: newPassword, code },
        current,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await env.DB.prepare(
        'SELECT count(*) n FROM auth_recovery_codes WHERE user_id=?',
      )
        .bind(owner.id)
        .first()
    )?.n,
  ).toBe(10);
});

it('password policy accepts only the length rule, and onboarding rejects five but accepts six characters', async () => {
  expect(passwordSchema.safeParse('12345').success).toBe(false);
  for (const value of [
    '123456',
    'abcdef',
    'abc123',
    '1234567',
    'a'.repeat(129),
  ])
    expect(passwordSchema.safeParse(value).success).toBe(true);
  const owner = await fixture();
  const login = await request('login', { username: owner.username, password });
  const challenge = cookies(login);
  const rejected = await request(
    'onboarding/password',
    { newPassword: '12345', confirmPassword: '12345' },
    challenge,
  );
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({
    message: '密碼至少需要 6 碼。',
  });
  const accepted = await request(
    'onboarding/password',
    { newPassword: '123456', confirmPassword: '123456' },
    challenge,
  );
  expect(accepted.status).toBe(200);
  const next = await request('login', {
    username: owner.username,
    password: '123456',
  });
  expect(next.status).toBe(200);
  expect(await next.json()).toMatchObject({ step: 'enroll' });
  const ready = await fixture(true);
  const deniedChange = await request(
    'change-password',
    {
      currentPassword: password,
      newPassword: '12345',
      confirmPassword: '12345',
    },
    await fullCookie(ready.id),
  );
  expect(deniedChange.status).toBe(400);
  expect(await deniedChange.json()).toMatchObject({
    message: '密碼至少需要 6 碼。',
  });
});
