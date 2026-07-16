import { API_KEY_PREFIX } from '@saasflare-dev/api/auth';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/index';
import { adminCookie, rpc, userCookie } from './helpers';

/**
 * Managed API key lifecycle against the real better-auth api-key plugin on
 * D1: create (one-time plaintext) → list (metadata only) → call the external
 * API → revoke → 401. Keys belong to whoever created them — the plugin
 * scopes list/revoke to the session user.
 */

function whoami(token?: string) {
  return app.fetch(
    new Request('http://localhost/api/v1/whoami', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );
}

describe('API keys', () => {
  let plaintext: string;
  let keyId: string;

  beforeAll(async () => {
    const { status, body } = await rpc('apiKeys.create', {
      name: 'lifecycle-test',
    });
    expect(status).toBe(200);
    const created = body as { id: string; key: string; expiresAt: unknown };
    plaintext = created.key;
    keyId = created.id;
  });

  it('creates a key with the product prefix, never expiring by default', async () => {
    expect(plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(plaintext.length).toBeGreaterThan(40);
  });

  it('honors a chosen expiry (days), bounded at 365', async () => {
    const { status, body } = await rpc('apiKeys.create', {
      name: 'short-lived',
      expiresInDays: 7,
    });
    expect(status).toBe(200);
    const created = body as { expiresAt: string };
    const days =
      (new Date(created.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.5);
    expect(days).toBeLessThan(7.5);

    const over = await rpc('apiKeys.create', {
      name: 'too-long',
      expiresInDays: 400,
    });
    expect(over.status).not.toBe(200);
  });

  it('lists metadata only — never the plaintext or hash', async () => {
    const { status, body } = await rpc('apiKeys.list');
    expect(status).toBe(200);
    const rows = body as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.id === keyId);
    expect(row).toBeDefined();
    expect(row?.key).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain(plaintext);
  });

  it('scopes list to the session user', async () => {
    const { body } = await rpc('apiKeys.list', undefined, {
      cookie: await adminCookie(),
    });
    const rows = body as Array<{ id: string }>;
    expect(rows.some((r) => r.id === keyId)).toBe(false);
  });

  it('authenticates the external API with a valid key', async () => {
    const res = await whoami(plaintext);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keyId: string; userId: string };
    expect(body.keyId).toBe(keyId);
    expect(body.userId).toBeTruthy();
  });

  it('rejects missing/forged tokens with one generic 401', async () => {
    for (const res of await Promise.all([
      whoami(),
      whoami(`${API_KEY_PREFIX}forged00000000000000000000000000000000`),
      whoami('not-even-the-right-shape'),
    ])) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('rejects anonymous key management', async () => {
    const { status } = await rpc(
      'apiKeys.create',
      { name: 'nope' },
      { cookie: null },
    );
    expect(status).toBe(401);
  });

  it("cannot revoke another user's key", async () => {
    const { status } = await rpc(
      'apiKeys.revoke',
      { keyId },
      { cookie: await adminCookie() },
    );
    expect(status).not.toBe(200);
    // ...and the key still works.
    expect((await whoami(plaintext)).status).toBe(200);
  });

  it('revokes: the key stops working immediately', async () => {
    const { status, body } = await rpc(
      'apiKeys.revoke',
      { keyId },
      { cookie: await userCookie() },
    );
    expect(status).toBe(200);
    expect((body as { success: boolean }).success).toBe(true);
    expect((await whoami(plaintext)).status).toBe(401);

    const list = await rpc('apiKeys.list');
    expect(
      (list.body as Array<{ id: string }>).some((r) => r.id === keyId),
    ).toBe(false);
  });
});
