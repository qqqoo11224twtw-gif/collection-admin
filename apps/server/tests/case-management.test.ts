import { env } from 'cloudflare:workers';
import {
  detectedImageType,
  sha256,
} from '@saasflare-dev/api/case-media-management';
import { R2CaseStorage } from '@saasflare-dev/api/case-storage';
import { permissionPolicy } from '@saasflare-dev/api/permissions';
import { DEMO_IMAGES } from '@saasflare-dev/db/demo-images';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/index';
import { adminCookie, rpc, signIn, userCookie } from './helpers';

const fields = {
  customerName: '虛構測試戶',
  code: 'TEST-CASE',
  address: '虛構市測試路（非真實地址）',
  amountDue: 1200,
  status: 'pending',
  source: 'manual',
  revisitStatus: 'pending',
  revisitReason: '',
};
let admin: string;
let ordinary: string;
let agentA: string;
let agentB: string;
let userA: string;
let userB: string;
const png = () =>
  Uint8Array.from(atob(DEMO_IMAGES[0].base64), (char) => char.charCodeAt(0))
    .buffer;
async function createCase() {
  const response = await rpc(
    'cases.create',
    { ...fields, duplicateOverride: true },
    { cookie: admin },
  );
  expect(response.status).toBe(200);
  return response.body as { id: string; caseNo: string };
}
async function version(id: string) {
  return (
    (await rpc('cases.detail', { id }, { cookie: admin })).body as {
      version: number;
    }
  ).version;
}
async function logs(id: string) {
  const response = await rpc('cases.audit', { id }, { cookie: admin });
  expect(response.status).toBe(200);
  return response.body as { action: string; metadata: string }[];
}
async function createCollector(
  code: string,
  userId: string | null = null,
  isActive = true,
) {
  const response = await rpc(
    'collectors.create',
    { displayName: `Fictional ${code}`, code, userId, isActive },
    { cookie: admin },
  );
  expect(response.status).toBe(200);
  return (response.body as { id: string }).id;
}
async function upload(
  id: string,
  expectedVersion: number,
  options: { cookie?: string | null; origin?: string; files?: File[] } = {},
) {
  const form = new FormData();
  form.append('expectedVersion', String(expectedVersion));
  for (const file of options.files ?? [
    new File([png()], 'fictional.png', { type: 'image/png' }),
  ])
    form.append('files', file);
  const cookie = options.cookie === undefined ? admin : options.cookie;
  return app.fetch(
    new Request(`http://localhost/api/cases/${id}/media`, {
      method: 'POST',
      headers: {
        Origin: options.origin ?? 'http://localhost:3000',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: form,
    }),
  );
}
beforeAll(async () => {
  admin = await adminCookie();
  ordinary = await userCookie();
  agentA = await signIn('phase-two-a@example.test');
  agentB = await signIn('phase-two-b@example.test');
  userA =
    (
      await env.DB.prepare('SELECT id FROM user WHERE email=?')
        .bind('phase-two-a@example.test')
        .first<{ id: string }>()
    )?.id ?? '';
  userB =
    (
      await env.DB.prepare('SELECT id FROM user WHERE email=?')
        .bind('phase-two-b@example.test')
        .first<{ id: string }>()
    )?.id ?? '';
});

describe('Case creation and editing', () => {
  it('generates unique case numbers and records creation without sensitive values', async () => {
    const a = await createCase();
    const b = await createCase();
    expect(a.caseNo).toMatch(/^CASE-\d{8}-[A-F0-9]{32}$/);
    expect(a.caseNo).not.toBe(b.caseNo);
    const audit = await logs(a.id);
    expect(audit[0].action).toBe('case.created');
    expect(audit[0].metadata).not.toContain(fields.customerName);
    expect(audit[0].metadata).not.toContain(fields.address);
  });
  it('rejects client identity fields and invalid values', async () => {
    for (const change of [
      { caseNo: 'forged' },
      { id: 'forged' },
      { createdAt: 1 },
      { assignedAgentId: userA },
      { amountDue: -1 },
      { amountDue: 1.5 },
      { status: 'bad' },
    ])
      expect(
        (await rpc('cases.create', { ...fields, ...change }, { cookie: admin }))
          .status,
      ).toBe(400);
  });
  it('edits allowed fields while preserving identity and source', async () => {
    const created = await createCase();
    const original = (
      await rpc('cases.detail', { id: created.id }, { cookie: admin })
    ).body as { createdAt: string; caseNo: string; source: string };
    const { source: _source, ...editable } = fields;
    expect(
      (
        await rpc(
          'cases.edit',
          {
            ...editable,
            id: created.id,
            expectedVersion: 0,
            customerName: '另一个虛構戶',
            amountDue: 2400,
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    const changed = (
      await rpc('cases.detail', { id: created.id }, { cookie: admin })
    ).body as typeof original & { amountDue: number; version: number };
    expect(changed.caseNo).toBe(original.caseNo);
    expect(changed.createdAt).toEqual(original.createdAt);
    expect(changed.source).toBe('manual');
    expect(changed.amountDue).toBe(2400);
    expect(changed.version).toBe(1);
    expect(
      (await logs(created.id)).some((item) => item.action === 'case.edited'),
    ).toBe(true);
    for (const change of [
      { caseNo: 'changed' },
      { createdAt: 0 },
      { source: 'telegram_ai' },
    ])
      expect(
        (
          await rpc(
            'cases.edit',
            { ...editable, id: created.id, expectedVersion: 1, ...change },
            { cookie: admin },
          )
        ).status,
      ).toBe(400);
  });
  it('rejects stale and concurrent edits without producing extra audit entries', async () => {
    const created = await createCase();
    const { source: _source, ...editable } = fields;
    const results = await Promise.all(
      [1, 2].map((amountDue) =>
        rpc(
          'cases.edit',
          { ...editable, id: created.id, expectedVersion: 0, amountDue },
          { cookie: admin },
        ),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(
      (await logs(created.id)).filter((item) => item.action === 'case.edited'),
    ).toHaveLength(1);
  });
  it('rolls back the case update if audit insertion fails', async () => {
    const created = await createCase();
    const { source: _source, ...editable } = fields;
    await env.DB.exec(
      "CREATE TRIGGER reject_case_audit BEFORE INSERT ON audit_logs WHEN NEW.action='case.edited' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;",
    );
    try {
      expect(
        (
          await rpc(
            'cases.edit',
            { ...editable, id: created.id, expectedVersion: 0, amountDue: 999 },
            { cookie: admin },
          )
        ).status,
      ).toBe(409);
      expect(await version(created.id)).toBe(0);
    } finally {
      await env.DB.exec('DROP TRIGGER reject_case_audit');
    }
  });
});

describe('Collectors and assignment history', () => {
  it('creates, edits and toggles collectors with unique codes', async () => {
    const id = await createCollector('UNIQUE-TEST');
    expect(
      (
        await rpc(
          'collectors.create',
          {
            displayName: 'Duplicate',
            code: 'unique-test',
            isActive: true,
            userId: null,
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await rpc(
          'collectors.edit',
          {
            id,
            expectedVersion: 0,
            displayName: 'Edited fictional',
            code: 'UNIQUE-TEST',
            isActive: false,
            userId: null,
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await rpc(
          'collectors.edit',
          {
            id,
            expectedVersion: 1,
            displayName: 'Edited fictional',
            code: 'UNIQUE-TEST',
            isActive: true,
            userId: null,
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await rpc(
          'collectors.edit',
          {
            id,
            expectedVersion: 0,
            displayName: 'Stale',
            code: 'UNIQUE-TEST',
            isActive: true,
            userId: null,
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(409);
  });
  it('preserves assign → reassign → unassign history and changes visibility', async () => {
    const created = await createCase();
    const a = await createCollector('COL-A', userA);
    const b = await createCollector('COL-B', userB);
    expect(
      (
        await rpc(
          'cases.assign',
          {
            caseId: created.id,
            collectorId: a,
            expectedVersion: 0,
            note: 'Demo first assignment',
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    expect(
      (await rpc('cases.detail', { id: created.id }, { cookie: agentA }))
        .status,
    ).toBe(200);
    expect(
      (await rpc('cases.detail', { id: created.id }, { cookie: agentB }))
        .status,
    ).toBe(404);
    expect(
      (
        await rpc(
          'cases.assign',
          {
            caseId: created.id,
            collectorId: b,
            expectedVersion: 1,
            note: 'Demo reassignment',
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    expect(
      (await rpc('cases.detail', { id: created.id }, { cookie: agentA }))
        .status,
    ).toBe(404);
    expect(
      (await rpc('cases.detail', { id: created.id }, { cookie: agentB }))
        .status,
    ).toBe(200);
    expect(
      (
        await rpc(
          'cases.assign',
          {
            caseId: created.id,
            collectorId: null,
            expectedVersion: 2,
            note: null,
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    expect(
      (await rpc('cases.detail', { id: created.id }, { cookie: agentB }))
        .status,
    ).toBe(404);
    const history = (
      await rpc('cases.assignments', { id: created.id }, { cookie: admin })
    ).body as { unassignedAt: unknown; note: string }[];
    expect(history).toHaveLength(2);
    expect(history.every((item) => item.unassignedAt)).toBe(true);
    expect(history.map((item) => item.note)).toContain('Demo first assignment');
    const audit = await logs(created.id);
    expect(audit.map((item) => item.action)).toEqual(
      expect.arrayContaining([
        'assignment.created',
        'assignment.reassigned',
        'assignment.unassigned',
      ]),
    );
    expect(
      audit.every((item) => !item.metadata.includes('Demo first assignment')),
    ).toBe(true);
  });
  it('rejects inactive collectors and concurrent assignments atomically', async () => {
    const created = await createCase();
    const inactive = await createCollector('INACTIVE', null, false);
    expect(
      (
        await rpc(
          'cases.assign',
          {
            caseId: created.id,
            collectorId: inactive,
            expectedVersion: 0,
            note: null,
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(400);
    const a = await createCollector('RACE-A');
    const b = await createCollector('RACE-B');
    const result = await Promise.all(
      [a, b].map((collectorId) =>
        rpc(
          'cases.assign',
          { caseId: created.id, collectorId, expectedVersion: 0, note: null },
          { cookie: admin },
        ),
      ),
    );
    expect(result.map((item) => item.status).sort()).toEqual([200, 409]);
    const rows = await env.DB.prepare(
      'SELECT id FROM assignments WHERE case_id=? AND unassigned_at IS NULL',
    )
      .bind(created.id)
      .all();
    expect(rows.results).toHaveLength(1);
  });
  it('revokes access on deactivation and prevents active login-link transfer', async () => {
    const created = await createCase();
    // Use the already linked collector to respect the unique login index.
    const collector = await env.DB.prepare(
      'SELECT id,code,display_name,version FROM collectors WHERE user_id=?',
    )
      .bind(userA)
      .first<{
        id: string;
        code: string;
        display_name: string;
        version: number;
      }>();
    if (!collector) throw new Error('Missing test collector');
    await rpc(
      'cases.assign',
      {
        caseId: created.id,
        collectorId: collector.id,
        expectedVersion: 0,
        note: null,
      },
      { cookie: admin },
    );
    const values = {
      id: collector.id,
      expectedVersion: collector.version,
      code: collector.code,
      displayName: collector.display_name,
      userId: userA,
      isActive: false,
    };
    expect(
      (
        await rpc(
          'collectors.edit',
          { ...values, userId: null },
          { cookie: admin },
        )
      ).status,
    ).toBe(409);
    expect(
      (await rpc('collectors.edit', values, { cookie: admin })).status,
    ).toBe(200);
    expect(
      (await rpc('cases.detail', { id: created.id }, { cookie: agentA }))
        .status,
    ).toBe(404);
    expect(
      (
        await rpc(
          'collectors.edit',
          { ...values, expectedVersion: collector.version + 1, isActive: true },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
  });
});

describe('Permission enforcement', () => {
  it('supports independent role grants and denies unknown roles', () => {
    const actor = {
      id: 'synthetic',
      email: 'synthetic@example.test',
      name: 'Synthetic',
      role: 'manager',
    };
    expect(permissionPolicy({ user: actor }).permissions).toContain(
      'case.edit',
    );
    expect(permissionPolicy({ user: actor }).permissions).not.toContain(
      'collector.manage',
    );
    expect(
      permissionPolicy({ user: { ...actor, role: 'unknown' } }).permissions,
    ).toEqual([]);
  });
  it('rejects unauthenticated and unprivileged management calls', async () => {
    const created = await createCase();
    const { source: _source, ...editable } = fields;
    const actions: [string, unknown][] = [
      ['cases.create', fields],
      ['cases.edit', { ...editable, id: created.id, expectedVersion: 0 }],
      ['collectors.list', undefined],
      ['collectors.users', undefined],
      ['collectors.choices', undefined],
      [
        'collectors.create',
        { displayName: 'Denied', code: 'DENIED', isActive: true, userId: null },
      ],
      ['cases.audit', { id: created.id }],
    ];
    for (const [path, input] of actions) {
      expect((await rpc(path, input, { cookie: null })).status).toBe(401);
      expect((await rpc(path, input, { cookie: ordinary })).status).toBe(403);
    }
    expect(
      (
        await rpc(
          'cases.assign',
          {
            caseId: created.id,
            collectorId: null,
            expectedVersion: 0,
            note: null,
          },
          { cookie: ordinary },
        )
      ).status,
    ).toBe(404);
    expect((await upload(created.id, 0, { cookie: ordinary })).status).toBe(
      403,
    );
    expect((await upload(created.id, 0, { cookie: null })).status).toBe(401);
    expect(
      (await upload(created.id, 0, { origin: 'https://evil.example.test' }))
        .status,
    ).toBe(403);
  });
});

describe('Private image writes and audit', () => {
  it('uploads multiple images, computes hashes, reorders and deletes privately', async () => {
    const created = await createCase();
    const response = await upload(created.id, 0, {
      files: [
        new File([png()], 'one.png', { type: 'image/png' }),
        new File([png()], 'two.png', { type: 'image/png' }),
      ],
    });
    expect(response.status).toBe(201);
    const uploaded = (await response.json()) as { ids: string[] };
    expect(uploaded.ids).toHaveLength(2);
    const rows = await env.DB.prepare(
      'SELECT id,storage_key,sha256 FROM case_media WHERE case_id=?',
    )
      .bind(created.id)
      .all<{ id: string; storage_key: string; sha256: string }>();
    expect(
      rows.results.every((item) => item.sha256 === DEMO_IMAGES[0].sha256),
    ).toBe(true);
    const bucket = env.CASE_BUCKET;
    if (!bucket) throw new Error('Missing private test bucket');
    for (const media of rows.results)
      expect(await bucket.get(media.storage_key)).not.toBeNull();
    const image = await app.fetch(
      new Request(
        `http://localhost/api/cases/${created.id}/media/${uploaded.ids[0]}/image`,
        { headers: { Cookie: admin } },
      ),
    );
    expect(image.status).toBe(200);
    expect(image.headers.get('Cache-Control')).toBe('private, no-store');
    expect(
      (
        await rpc(
          'cases.reorderMedia',
          {
            caseId: created.id,
            ids: uploaded.ids.toReversed(),
            expectedVersion: 1,
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    const ordered = (
      await rpc('cases.media', { id: created.id }, { cookie: admin })
    ).body as { id: string }[];
    expect(ordered[0].id).toBe(uploaded.ids[1]);
    expect(
      (
        await rpc(
          'cases.deleteMedia',
          { caseId: created.id, mediaId: uploaded.ids[0], expectedVersion: 2 },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    const removed = rows.results.find((item) => item.id === uploaded.ids[0]);
    expect(await bucket.get(removed?.storage_key ?? '')).toBeNull();
    expect(
      (
        await app.fetch(
          new Request(
            `http://localhost/api/cases/${created.id}/media/${uploaded.ids[0]}/image`,
            { headers: { Cookie: admin } },
          ),
        )
      ).status,
    ).toBe(404);
    expect((await logs(created.id)).map((item) => item.action)).toEqual(
      expect.arrayContaining([
        'media.uploaded',
        'media.reordered',
        'media.deleted',
      ]),
    );
    expect(
      (await logs(created.id)).every(
        (item) => !/base64|one\.png|data:image|OTP|apiKey/.test(item.metadata),
      ),
    ).toBe(true);
  });
  it('rejects SVG, disguised bytes, oversized files and too many files', async () => {
    const created = await createCase();
    for (const file of [
      new File(['<svg/>'], 'bad.svg', { type: 'image/svg+xml' }),
      new File(['not an image'], 'bad.png', { type: 'image/png' }),
      new File([png()], 'wrong.jpeg', { type: 'image/jpeg' }),
    ])
      expect((await upload(created.id, 0, { files: [file] })).status).toBe(400);
    expect(
      (
        await upload(created.id, 0, {
          files: [
            new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', {
              type: 'image/png',
            }),
          ],
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await upload(created.id, 0, {
          files: Array.from(
            { length: 6 },
            () => new File([png()], 'many.png', { type: 'image/png' }),
          ),
        })
      ).status,
    ).toBe(400);
    expect(await version(created.id)).toBe(0);
  });
  it('cleans uploaded objects when D1/audit commit fails', async () => {
    const created = await createCase();
    await env.DB.exec(
      "CREATE TRIGGER reject_upload_audit BEFORE INSERT ON audit_logs WHEN NEW.action='media.uploaded' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;",
    );
    try {
      expect((await upload(created.id, 0)).status).toBe(409);
      expect(await version(created.id)).toBe(0);
      expect(
        (
          await env.DB.prepare('SELECT id FROM case_media WHERE case_id=?')
            .bind(created.id)
            .all()
        ).results,
      ).toHaveLength(0);
      expect(
        (await env.CASE_BUCKET?.list({ prefix: `cases/${created.id}/` }))
          ?.objects,
      ).toHaveLength(0);
    } finally {
      await env.DB.exec('DROP TRIGGER reject_upload_audit');
    }
  });
  it('rejects cross-case deletion, invalid order, stale writes and ordinary media writes', async () => {
    const created = await createCase();
    const other = await createCase();
    const response = await upload(created.id, 0);
    const { ids } = (await response.json()) as { ids: string[] };
    expect(
      (
        await rpc(
          'cases.deleteMedia',
          { caseId: other.id, mediaId: ids[0], expectedVersion: 0 },
          { cookie: admin },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await rpc(
          'cases.reorderMedia',
          { caseId: created.id, ids: [ids[0], ids[0]], expectedVersion: 1 },
          { cookie: admin },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await rpc(
          'cases.deleteMedia',
          { caseId: created.id, mediaId: ids[0], expectedVersion: 0 },
          { cookie: admin },
        )
      ).status,
    ).toBe(409);
    for (const [path, input] of [
      [
        'cases.deleteMedia',
        { caseId: created.id, mediaId: ids[0], expectedVersion: 1 },
      ],
      ['cases.reorderMedia', { caseId: created.id, ids, expectedVersion: 1 }],
    ] as const)
      expect((await rpc(path, input, { cookie: ordinary })).status).toBe(403);
  });
  it('verifies adapter persistence, hashing and format detection', async () => {
    const bucket = env.CASE_BUCKET;
    if (!bucket) throw new Error('Missing private test bucket');
    const storage = new R2CaseStorage(bucket);
    const bytes = png();
    await storage.write('private-storage-test', bytes, 'image/png');
    expect(
      await sha256((await storage.read('private-storage-test')) as ArrayBuffer),
    ).toBe(DEMO_IMAGES[0].sha256);
    await storage.delete('private-storage-test');
    expect(await storage.read('private-storage-test')).toBeNull();
    expect(detectedImageType(new Uint8Array(bytes))).toBe('image/png');
    expect(detectedImageType(new TextEncoder().encode('<svg/>'))).toBeNull();
  });
  it('protects audit event payloads from mutation and deletion', async () => {
    const created = await createCase();
    await expect(
      env.DB.prepare("UPDATE audit_logs SET action='forged' WHERE entity_id=?")
        .bind(created.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare('DELETE FROM audit_logs WHERE entity_id=?')
        .bind(created.id)
        .run(),
    ).rejects.toThrow();
  });
});
