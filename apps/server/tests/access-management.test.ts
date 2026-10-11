import { env } from 'cloudflare:workers';
import {
  AccessManagementService,
  accessMutationSchema,
} from '@saasflare-dev/api/access-management';
import {
  AccessFailure,
  type AccessGroup,
  type AccessProvider,
  CloudflareAccessClient,
  groupEmails,
} from '@saasflare-dev/api/cloudflare-access-client';
import { permissionPolicy } from '@saasflare-dev/api/permissions';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminCookie, rpc } from './helpers';

const groupId = '11111111-1111-4111-8111-111111111111';
const first = 'first@example.test',
  second = 'second@example.test';
class Fixture implements AccessProvider {
  group: AccessGroup = {
    id: groupId,
    name: 'isolated-test-access-users',
    include: [first, second].map((email) => ({ email: { email } })),
    exclude: [{ ip: { ip: '192.0.2.1/32' } }],
    require: [],
    updated_at: '2026-01-01',
  };
  failWrite = false;
  failRevoke = false;
  writes = 0;
  revocations: string[] = [];
  async getGroup() {
    return structuredClone(this.group);
  }
  async updateGroup(group: AccessGroup) {
    this.writes++;
    this.group = structuredClone(group);
    if (this.failWrite) throw new AccessFailure('ACCESS_PROVIDER_FAILED');
  }
  async revokeUser(email: string) {
    if (this.failRevoke) throw new AccessFailure('ACCESS_PROVIDER_FAILED');
    this.revocations.push(email);
  }
}
let fixture: Fixture, service: AccessManagementService;
beforeEach(async () => {
  await adminCookie();
  const actor = await env.DB.prepare(
    "SELECT id FROM user WHERE email='boss@test.dev'",
  ).first<{ id: string }>();
  if (!actor) throw Error('Missing fixture actor');
  await env.DB.batch(
    [
      'DELETE FROM access_group_locks',
      'DELETE FROM access_operations',
      'DELETE FROM access_emails',
    ].map((sql) => env.DB.prepare(sql)),
  );
  fixture = new Fixture();
  service = new AccessManagementService(env.DB, fixture, groupId, actor.id);
  await service.sync(false);
});
it('reads joined audit history with an unambiguous operation timestamp', async () => {
  const history = await service.history();
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ action: 'sync', status: 'reconciled' });
});
it('limits Access writes per operator without changing provider state or leaving a lock', async () => {
  for (let index = 0; index < 9; index++) await service.sync(false);
  await expect(change('limited@example.test', 'add')).rejects.toMatchObject({
    code: 'TOO_MANY_REQUESTS',
    data: { code: 'ACCESS_RATE_LIMITED' },
  });
  expect(fixture.writes).toBe(0);
  expect((await service.list()).busy).toBe(false);
  await env.DB.prepare(
    'UPDATE access_operations SET created_at=created_at-60001',
  ).run();
  expect((await change('limited@example.test', 'add')).success).toBe(true);
});
async function change(
  email: string,
  action: 'add' | 'enable' | 'disable' | 'remove',
  confirm = true,
) {
  return service.mutate({
    email,
    action,
    expectedRevision: (await service.list()).revision,
    confirmAccountWideRevocation: confirm,
  });
}
describe('Access whitelist integration using isolated D1 and provider fixture', () => {
  it('admin defaults and explicit grants/denies enforce independent Access management', () => {
    const identity = {
      id: 'fictional-actor',
      name: 'Fictional',
      email: 'actor@example.test',
      role: 'manager',
    };
    expect(permissionPolicy({ user: identity }).permissions).not.toContain(
      'access.manage',
    );
    expect(
      permissionPolicy({ user: { ...identity, role: 'admin' } }).permissions,
    ).toContain('access.manage');
    expect(
      permissionPolicy({
        user: { ...identity, permissionAllow: '["access.manage"]' },
      }).permissions,
    ).toContain('access.manage');
    expect(
      permissionPolicy({
        user: {
          ...identity,
          role: 'admin',
          permissionDeny: '["access.manage"]',
        },
      }).permissions,
    ).not.toContain('access.manage');
  });
  it('normalizes email and rejects invalid/unknown fields', () => {
    const base = { action: 'add', expectedRevision: 'a'.repeat(64) };
    expect(
      accessMutationSchema.parse({ ...base, email: '  THIRD@Example.test ' })
        .email,
    ).toBe('third@example.test');
    expect(
      accessMutationSchema.safeParse({ ...base, email: 'not-email' }).success,
    ).toBe(false);
    expect(
      accessMutationSchema.safeParse({
        ...base,
        email: first,
        token: 'not-accepted',
      }).success,
    ).toBe(false);
  });
  it('adds exact email independently of website user and preserves rules', async () => {
    expect((await change(' THIRD@Example.test ', 'add')).success).toBe(true);
    expect(groupEmails(fixture.group)).toEqual([
      first,
      second,
      'third@example.test',
    ]);
    expect(fixture.group.exclude).toEqual([{ ip: { ip: '192.0.2.1/32' } }]);
    expect(
      await env.DB.prepare('SELECT id FROM user WHERE email=?')
        .bind('third@example.test')
        .first(),
    ).toBeNull();
    const audit = await env.DB.prepare(
      "SELECT metadata FROM audit_logs WHERE action='ACCESS_EMAIL_ADD' ORDER BY created_at DESC LIMIT 1",
    ).first<{ metadata: string }>();
    expect(JSON.parse(audit?.metadata ?? '{}').after).toBe(true);
  });
  it('rejects duplicate email without provider write', async () => {
    await expect(change(first, 'add')).rejects.toThrow('此授權信箱已存在');
    expect(fixture.writes).toBe(0);
  });
  it('disables, re-enables and soft removes, with account-wide revocation', async () => {
    await change(first, 'disable');
    expect(fixture.revocations).toEqual([first]);
    await change(first, 'enable');
    expect(groupEmails(fixture.group)).toContain(first);
    await change(first, 'remove');
    expect(
      (await service.list()).items.find((row) => row.email === first)
        ?.deleted_at,
    ).toBeTruthy();
  });
  it('requires explicit account-wide revocation acknowledgement', async () => {
    await expect(change(first, 'disable', false)).rejects.toThrow('請確認撤銷');
    expect(fixture.writes).toBe(0);
  });
  it('prevents removal of final authorized email', async () => {
    await change(first, 'disable');
    await expect(change(second, 'remove')).rejects.toThrow('最後一個');
    expect(groupEmails(fixture.group)).toEqual([second]);
  });
  it('detects external changes without blindly overwriting', async () => {
    const revision = (await service.list()).revision;
    fixture.group.include.push({ email: { email: 'external@example.test' } });
    await expect(
      service.mutate({
        email: first,
        action: 'disable',
        expectedRevision: revision,
        confirmAccountWideRevocation: true,
      }),
    ).rejects.toThrow('已變更');
    expect(fixture.writes).toBe(0);
    expect(groupEmails(fixture.group)).toContain('external@example.test');
  });
  it('serializes concurrent writes, avoiding lost updates', async () => {
    const revision = (await service.list()).revision;
    const results = await Promise.allSettled(
      ['a@example.test', 'b@example.test'].map((email) =>
        service.mutate({
          email,
          action: 'add',
          expectedRevision: revision,
          confirmAccountWideRevocation: false,
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(groupEmails(fixture.group)).toHaveLength(3);
    expect(fixture.writes).toBe(1);
  });
  it('reports session revoke failure as partial and safely retries only revocation', async () => {
    fixture.failRevoke = true;
    const result = await change(first, 'disable');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Session 撤銷失敗');
    expect(
      (await service.list()).items.find((row) => row.email === first)
        ?.sync_status,
    ).toBe('revoke_failed');
    fixture.failRevoke = false;
    await change(first, 'disable');
    expect(fixture.writes).toBe(1);
    expect(fixture.revocations).toEqual([first]);
  });
  it('quarantines an uncertain provider write and requires explicit read-only recovery', async () => {
    fixture.failWrite = true;
    await expect(change('new@example.test', 'add')).rejects.toThrow();
    expect((await service.list()).busy).toBe(true);
    await expect(service.sync(false)).rejects.toThrow('尚未完成');
    await env.DB.prepare('UPDATE access_group_locks SET created_at=?')
      .bind(Date.now() - 130000)
      .run();
    const after = await service.sync(true);
    expect(after.busy).toBe(false);
    expect(
      after.items.some(
        (row) => row.email === 'new@example.test' && row.cloudActive,
      ),
    ).toBe(true);
    expect(fixture.writes).toBe(1);
  });
  it('reads actual Cloudflare list and imports drift without changing provider', async () => {
    fixture.group.include.push({ email: { email: 'external@example.test' } });
    expect(
      (await service.list()).items.find(
        (row) => row.email === 'external@example.test',
      )?.sync_status,
    ).toBe('drift');
    expect(
      (await service.sync(false)).items.find(
        (row) => row.email === 'external@example.test',
      )?.sync_status,
    ).toBe('synced');
    expect(fixture.writes).toBe(0);
  });
  it('refuses broad Everyone/domain include rules', () => {
    expect(() =>
      groupEmails({ ...fixture.group, include: [{ everyone: {} }] }),
    ).toThrow('ACCESS_UNSAFE_GROUP');
    expect(() =>
      groupEmails({
        ...fixture.group,
        include: [{ email_domain: { domain: 'gmail.com' } }],
      }),
    ).toThrow();
  });
  it('rejects non-admin and anonymous APIs before external calls', async () => {
    for (const path of [
      'access/list',
      'access/history',
      'access/sync',
      'access/mutate',
    ]) {
      expect(
        (
          await rpc(
            path,
            path.endsWith('sync')
              ? { confirmRecovery: false }
              : path.endsWith('mutate')
                ? {
                    email: first,
                    action: 'add',
                    expectedRevision: 'a'.repeat(64),
                  }
                : undefined,
          )
        ).status,
      ).toBe(403);
      expect((await rpc(path, undefined, { cookie: null })).status).toBe(401);
    }
  });
  it('migration foreign keys and quick_check are clean', async () => {
    expect(
      (await env.DB.prepare('PRAGMA foreign_key_check').all()).results,
    ).toEqual([]);
    expect(
      await env.DB.prepare('PRAGMA quick_check').first('quick_check'),
    ).toBe('ok');
  });
});
describe('official Cloudflare request shape and safe errors', () => {
  it('reads exact Web scope, sole Group/OTP policy and all three 720h sessions', async () => {
    const otp = '22222222-2222-4222-8222-222222222222';
    const transport = (async (url) => {
      const path = String(url);
      const result = path.endsWith('/policies')
        ? [
            {
              decision: 'allow',
              include: [{ group: { id: groupId } }],
              require: [{ login_method: { id: otp } }],
              session_duration: '720h',
            },
          ]
        : path.endsWith('/identity_providers')
          ? [{ id: otp, type: 'onetimepin' }]
          : path.endsWith('/organizations')
            ? { session_duration: '720h' }
            : {
                type: 'self_hosted',
                domain: 'staging.example.test',
                session_duration: '720h',
                allowed_idps: [otp],
                allow_authenticate_via_warp: false,
              };
      return Response.json({ success: true, result });
    }) as typeof fetch;
    const client = new CloudflareAccessClient(
      'a'.repeat(32),
      groupId,
      'fixture-only',
      transport,
    );
    expect(
      await client.inspectProtection(groupId, 'staging.example.test'),
    ).toMatchObject({
      exactHostnameOnly: true,
      soleAllowGroup: true,
      otpOnly: true,
      allSessions720h: true,
      noDeviceSessionOverride: true,
    });
  });
  it('fails protection checks on broad Allow/Bypass or Google provider', async () => {
    const transport = (async (url) =>
      Response.json({
        success: true,
        result: String(url).endsWith('/policies')
          ? [
              {
                decision: 'bypass',
                include: [{ everyone: {} }],
                require: [],
                session_duration: '24h',
              },
            ]
          : String(url).endsWith('/identity_providers')
            ? [{ id: 'google', type: 'google' }]
            : {
                domain: '*.example.test',
                type: 'self_hosted',
                allowed_idps: ['google'],
                session_duration: '24h',
                allow_authenticate_via_warp: true,
              },
      })) as typeof fetch;
    const client = new CloudflareAccessClient(
      'a'.repeat(32),
      groupId,
      'fixture-only',
      transport,
    );
    expect(
      await client.inspectProtection(groupId, 'staging.example.test'),
    ).toMatchObject({
      exactHostnameOnly: false,
      soleAllowGroup: false,
      otpOnly: false,
      allSessions720h: false,
      noDeviceSessionOverride: false,
    });
  });
  it('uses account group endpoint and single-user revoke, never application revoke', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const transport = (async (url, options) => {
      calls.push({
        url: String(url),
        body: options?.body ? JSON.parse(String(options.body)) : null,
      });
      return Response.json({
        success: true,
        result: String(url).endsWith('revoke_user') ? true : fixture.group,
      });
    }) as typeof fetch;
    const client = new CloudflareAccessClient(
      'a'.repeat(32),
      groupId,
      'fixture-only',
      transport,
    );
    await client.getGroup();
    await client.updateGroup(fixture.group);
    await client.revokeUser(first);
    expect(calls[1].body).toMatchObject({
      name: fixture.group.name,
      exclude: fixture.group.exclude,
      require: [],
    });
    expect(calls[2].url).toMatch(/access\/organizations\/revoke_user$/);
    expect(calls[2].body).toEqual({ email: first });
  });
  it('never includes provider response/token in errors', async () => {
    const transport = (async () =>
      Response.json(
        { success: false, errors: [{ message: 'sensitive-provider-body' }] },
        { status: 403 },
      )) as typeof fetch;
    const client = new CloudflareAccessClient(
      'a'.repeat(32),
      groupId,
      'fixture-only',
      transport,
    );
    await expect(client.getGroup()).rejects.toThrow('ACCESS_PROVIDER_FAILED');
  });
  it('does not call a Worker transport with the client as receiver', async () => {
    const receivers: unknown[] = [];
    const transport = async function (this: unknown, _url, options) {
      receivers.push(this);
      if (this !== undefined) throw new TypeError('Illegal invocation');
      expect(options?.redirect).toBe('manual');
      return Response.json({ success: true, result: fixture.group });
    } as typeof fetch;
    const client = new CloudflareAccessClient(
      'a'.repeat(32),
      groupId,
      'fixture-only',
      transport,
    );
    await expect(client.getGroup()).resolves.toMatchObject({ id: groupId });
    expect(receivers).toEqual([undefined]);
  });
  it('rejects redirects without forwarding provider credentials', async () => {
    let calls = 0;
    const transport = (async (_url, options) => {
      calls++;
      expect(options?.redirect).toBe('manual');
      return Response.json(
        { success: true, result: fixture.group },
        { status: 302 },
      );
    }) as typeof fetch;
    const client = new CloudflareAccessClient(
      'a'.repeat(32),
      groupId,
      'fixture-only',
      transport,
    );
    await expect(client.getGroup()).rejects.toThrow('ACCESS_PROVIDER_FAILED');
    expect(calls).toBe(1);
  });
});
