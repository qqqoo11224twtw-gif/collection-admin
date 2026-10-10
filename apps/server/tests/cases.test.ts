import { env } from 'cloudflare:workers';
import {
  caseInputSchema,
  caseListSchema,
  caseMediaInputSchema,
} from '@saasflare-dev/api/case-contract';
import {
  DemoCaseStorage,
  privateCaseStorage,
  R2CaseStorage,
} from '@saasflare-dev/api/case-storage';
import {
  assignments,
  caseMedia,
  cases,
  collectors,
  user,
} from '@saasflare-dev/db';
import { DEMO_CASES, DEMO_MEDIA } from '@saasflare-dev/db/demo-cases';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/index';
import { adminCookie, H, rpc, signIn, testEnv, userCookie } from './helpers';

const db = drizzle(env.DB);
let admin: string;
let agent: string;
let agentId: string;
const input = { page: 1, pageSize: 50, query: '' };
it('server pagination accepts only 20/50/200/500 and maintains filtered totals, ordering and collector scope', async () => {
  for (const pageSize of [20, 50, 200, 500]) {
    const response = await rpc(
      'cases.list',
      { page: 1, pageSize, query: 'DEMO-' },
      { cookie: admin },
    );
    expect(response.status).toBe(200);
    expect((response.body as Page).total).toBe(18);
    expect((response.body as Page).items).toHaveLength(18);
    const own = await rpc('cases.list', { pageSize }, { cookie: agent });
    expect(own.status).toBe(200);
    expect((own.body as Page).total).toBeLessThan(18);
  }
  for (const pageSize of [1, 10, 10000, 999999]) {
    expect(
      (await rpc('cases.list', { pageSize }, { cookie: admin })).status,
    ).toBe(400);
  }
});
interface Page {
  items: { id: string; customerName: string; status: string; source: string }[];
  total: number;
}
it('500-row D1 pages retrieve only the requested page and count the filtered 510 cases', async () => {
  const prefix = `PAGINATION-${crypto.randomUUID()}-`,
    now = Date.now();
  const statements = Array.from({ length: 510 }, (_, i) =>
    env.DB.prepare(
      "INSERT INTO cases(id,case_no,code,customer_name,address,amount_due,region,status,created_at,updated_at) VALUES(?,?,?,?,?,100,'桃園市','pending',?,?)",
    ).bind(
      `${prefix}${i}`,
      `${prefix}${i}`,
      `${prefix}${i}`,
      '虛構分頁案件',
      '虛構地址',
      now,
      now,
    ),
  );
  for (let i = 0; i < statements.length; i += 100)
    await env.DB.batch(statements.slice(i, i + 100));
  for (const pageSize of [20, 50, 200, 500]) {
    const started = performance.now();
    const first = await rpc(
      'cases.list',
      {
        pageSize,
        query: prefix,
        region: '桃園市',
        status: 'pending',
        assignmentStatus: 'unassigned',
      },
      { cookie: admin },
    );
    expect(first.status).toBe(200);
    expect((first.body as Page).total).toBe(510);
    expect((first.body as Page).items).toHaveLength(pageSize);
    if (pageSize === 500)
      console.info(
        JSON.stringify({
          event: 'CASE_PAGE_500_LOCAL',
          duration_ms: Math.round(performance.now() - started),
          returned_rows: 500,
        }),
      );
  }
  const second = await rpc(
    'cases.list',
    { page: 2, pageSize: 500, query: prefix },
    { cookie: admin },
  );
  expect((second.body as Page).items).toHaveLength(10);
  const own = await rpc(
    'cases.list',
    { pageSize: 500, query: prefix },
    { cookie: agent },
  );
  expect((own.body as Page).total).toBe(0);
  await env.DB.prepare('DELETE FROM cases WHERE code LIKE ?')
    .bind(`${prefix}%`)
    .run();
});
function imageRequest(caseId: string, mediaId: string, cookie?: string) {
  return app.fetch(
    new Request(`http://localhost/api/cases/${caseId}/media/${mediaId}/image`, {
      headers: { ...H, ...(cookie ? { Cookie: cookie } : {}) },
    }),
  );
}
beforeAll(async () => {
  admin = await adminCookie();
  agent = await signIn('case-agent@example.test');
  agentId =
    (
      await env.DB.prepare('SELECT id FROM user WHERE email = ?')
        .bind('case-agent@example.test')
        .first<{ id: string }>()
    )?.id ?? '';
  await db.insert(collectors).values({
    id: 'phase-one-agent',
    displayName: 'Fictional agent',
    code: 'PHASE-ONE-AGENT',
    isActive: true,
    userId: agentId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  for (const record of DEMO_CASES) {
    await db.insert(cases).values({
      ...record,
      assignedAgentId: record.assignedAgentId ? agentId : null,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    });
    if (record.assignedAgentId)
      await db.insert(assignments).values({
        id: `phase-one-${record.id}`,
        caseId: record.id,
        collectorId: 'phase-one-agent',
        assignedByUserId: agentId,
        assignedAt: new Date(record.updatedAt),
      });
  }
  for (const { fixture: _fixture, ...media } of DEMO_MEDIA)
    await db
      .insert(caseMedia)
      .values({ ...media, createdAt: new Date(media.createdAt) });
});

describe('Case schema validation', () => {
  it('accepts all fictional statuses and sources', () => {
    for (const record of DEMO_CASES)
      expect(caseInputSchema.safeParse(record).success).toBe(true);
    expect(new Set(DEMO_CASES.map((record) => record.status)).size).toBe(6);
    expect(new Set(DEMO_CASES.map((record) => record.source)).size).toBe(4);
  });
  it('rejects invalid money, enums, required fields and pagination', () => {
    for (const amountDue of [-1, 1.2, 1e15])
      expect(
        caseInputSchema.safeParse({ ...DEMO_CASES[0], amountDue }).success,
      ).toBe(false);
    for (const change of [
      { status: 'other' },
      { source: 'other' },
      { revisitStatus: 'other' },
      { customerName: '  ' },
      { caseNo: '' },
    ])
      expect(
        caseInputSchema.safeParse({ ...DEMO_CASES[0], ...change }).success,
      ).toBe(false);
    for (const invalid of [
      { page: 0 },
      { pageSize: 51 },
      { query: 'x'.repeat(121) },
    ])
      expect(caseListSchema.safeParse(invalid).success).toBe(false);
    expect(caseListSchema.parse({}).page).toBe(1);
  });
  it('rejects public storage URLs, traversal, bad hashes and media types', () => {
    expect(caseMediaInputSchema.safeParse(DEMO_MEDIA[0]).success).toBe(true);
    for (const change of [
      { storageKey: 'https://example.test/photo.png' },
      { storageKey: '../other' },
      { sha256: 'bad' },
      { mediaType: 'image/svg+xml' },
      { sortOrder: -1 },
    ])
      expect(
        caseMediaInputSchema.safeParse({ ...DEMO_MEDIA[0], ...change }).success,
      ).toBe(false);
  });
});

describe('D1 constraints and indexes', () => {
  it('enforces case number uniqueness, enums, amount and agent foreign key', async () => {
    const record = {
      ...DEMO_CASES[0],
      id: 'invalid-case',
      assignedAgentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await expect(
      db
        .insert(cases)
        .values({ ...record, caseNo: DEMO_CASES[0].caseNo.toLowerCase() }),
    ).rejects.toThrow();
    for (const statement of [
      "UPDATE cases SET status = 'bad'",
      "UPDATE cases SET source = 'bad'",
      "UPDATE cases SET revisit_status = 'bad'",
      'UPDATE cases SET amount_due = -1',
      "UPDATE cases SET customer_name = ''",
      "UPDATE cases SET assigned_agent_id = 'nonexistent-user'",
    ])
      await expect(
        env.DB.prepare(`${statement} WHERE id = ?`)
          .bind(DEMO_CASES[0].id)
          .run(),
      ).rejects.toThrow();
  });
  it('enforces media FK, hash and format constraints', async () => {
    for (const statement of [
      "UPDATE case_media SET case_id = 'nonexistent-case'",
      "UPDATE case_media SET sha256 = 'invalid'",
      "UPDATE case_media SET media_type = 'image/svg+xml'",
      'UPDATE case_media SET sort_order = -1',
    ])
      await expect(
        env.DB.prepare(`${statement} WHERE id = ?`)
          .bind(DEMO_MEDIA[0].id)
          .run(),
      ).rejects.toThrow();
  });
  it('uses indexes for customer, code and case number prefix searches', async () => {
    for (const [column, index] of [
      ['customer_name', 'cases_customer_name_idx'],
      ['code', 'cases_code_idx'],
      ['case_no', 'cases_case_no_idx'],
    ]) {
      const result = await env.DB.prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM cases WHERE ${column} LIKE ? ESCAPE '!'`,
      )
        .bind('DEMO%')
        .all<{ detail: string }>();
      expect(
        result.results.some(
          (row) => row.detail.includes(index) && row.detail.includes('SEARCH'),
        ),
      ).toBe(true);
    }
  });
  it('sets deleted agent references to null and cascades media deletion', async () => {
    const now = new Date();
    await db.insert(user).values({
      id: 'cascade-agent',
      name: 'Fictional',
      email: 'cascade@example.test',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(cases).values({
      ...DEMO_CASES[0],
      id: 'cascade-case',
      caseNo: 'CASCADE-TEST',
      assignedAgentId: 'cascade-agent',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(caseMedia).values({
      ...DEMO_MEDIA[0],
      id: 'cascade-media',
      caseId: 'cascade-case',
      storageKey: 'cascade/key.png',
      createdAt: now,
    });
    await env.DB.prepare('DELETE FROM user WHERE id = ?')
      .bind('cascade-agent')
      .run();
    expect(
      (
        await env.DB.prepare('SELECT assigned_agent_id FROM cases WHERE id = ?')
          .bind('cascade-case')
          .first<{ assigned_agent_id: string | null }>()
      )?.assigned_agent_id,
    ).toBeNull();
    await env.DB.prepare('DELETE FROM cases WHERE id = ?')
      .bind('cascade-case')
      .run();
    expect(
      await env.DB.prepare('SELECT id FROM case_media WHERE id = ?')
        .bind('cascade-media')
        .first(),
    ).toBeNull();
  });
});

describe('Cases API and search', () => {
  it('paginates with stable ordering and no duplicate records', async () => {
    const first = await rpc(
      'cases.list',
      { ...input, pageSize: 20 },
      { cookie: admin },
    );
    const second = await rpc(
      'cases.list',
      { ...input, pageSize: 20, page: 2 },
      { cookie: admin },
    );
    expect(first.status).toBe(200);
    const a = first.body as Page;
    const b = second.body as Page;
    expect(a.total).toBe(18);
    expect(a.items.length).toBe(18);
    expect(b.items.length).toBe(0);
    expect(
      new Set([...a.items, ...b.items].map((record) => record.id)).size,
    ).toBe(18);
    expect(a.items[0].id).toBe('demo-case-018');
  });
  it('finds same-name customers, codes, case numbers and address substrings', async () => {
    for (const query of [
      '示範星河',
      'demo-001',
      'demo-2026-001',
      '測試路 1 號',
    ]) {
      const result = await rpc(
        'cases.list',
        { ...input, query },
        { cookie: admin },
      );
      expect(result.status).toBe(200);
      expect(
        (result.body as Page).items.some(
          (record) => record.id === 'demo-case-001',
        ),
      ).toBe(true);
      if (query === '示範星河') expect((result.body as Page).total).toBe(6);
    }
  });
  it('treats SQL and LIKE metacharacters as literal search text', async () => {
    for (const query of ['%', '_', "' OR 1=1 --", '!']) {
      const result = await rpc(
        'cases.list',
        { ...input, query },
        { cookie: admin },
      );
      expect(result.status).toBe(200);
      expect((result.body as Page).total).toBe(0);
    }
  });
  it('returns empty/out-of-range results and validates inputs', async () => {
    expect(
      (
        (await rpc('cases.list', { ...input, page: 100 }, { cookie: admin }))
          .body as Page
      ).items,
    ).toEqual([]);
    expect(
      (await rpc('cases.list', { ...input, page: -1 }, { cookie: admin }))
        .status,
    ).toBe(400);
    expect(
      (await rpc('cases.detail', { id: 'missing' }, { cookie: admin })).status,
    ).toBe(404);
  });
});

describe('Case and image authorization', () => {
  it('requires a session for every new API', async () => {
    for (const [path, value] of [
      ['cases.list', input],
      ['cases.detail', { id: 'demo-case-001' }],
      ['cases.media', { id: 'demo-case-001' }],
    ] as const)
      expect((await rpc(path, value, { cookie: null })).status).toBe(401);
    expect((await imageRequest('demo-case-001', DEMO_MEDIA[0].id)).status).toBe(
      401,
    );
  });
  it('scopes list, counts and search to assigned cases', async () => {
    const listed = await rpc('cases.list', input, { cookie: agent });
    expect((listed.body as Page).total).toBe(6);
    expect(
      (listed.body as Page).items.every(
        (record) =>
          DEMO_CASES.find((item) => item.id === record.id)?.assignedAgentId,
      ),
    ).toBe(true);
    expect(
      (
        (
          await rpc(
            'cases.list',
            { ...input, query: 'DEMO-002' },
            { cookie: agent },
          )
        ).body as Page
      ).total,
    ).toBe(0);
    expect(((await rpc('cases.list', input)).body as Page).total).toBe(0);
  });
  it('denies unassigned users and hides inaccessible records behind 404', async () => {
    const other = await userCookie();
    for (const path of ['cases.detail', 'cases.media']) {
      expect(
        (await rpc(path, { id: 'demo-case-001' }, { cookie: agent })).status,
      ).toBe(200);
      expect(
        (await rpc(path, { id: 'demo-case-002' }, { cookie: agent })).status,
      ).toBe(404);
      expect(
        (await rpc(path, { id: 'demo-case-001' }, { cookie: other })).status,
      ).toBe(404);
    }
    expect(
      (await imageRequest('demo-case-001', DEMO_MEDIA[0].id, other)).status,
    ).toBe(404);
  });
  it('returns ordered metadata without public URLs or storage keys', async () => {
    const result = await rpc(
      'cases.media',
      { id: 'demo-case-001' },
      { cookie: admin },
    );
    const metadata = result.body as { sortOrder: number }[];
    expect(metadata.map((item) => item.sortOrder)).toEqual([1, 2, 3]);
    expect(JSON.stringify(metadata)).not.toMatch(/storageKey|sha256|https?:/);
  });
  it('serves exact PNG bytes privately only after both case and media checks', async () => {
    const response = await imageRequest(
      'demo-case-001',
      DEMO_MEDIA[0].id,
      agent,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(
      Array.from(new Uint8Array(await response.arrayBuffer()).slice(0, 8)),
    ).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(
      (await imageRequest('demo-case-002', DEMO_MEDIA[0].id, admin)).status,
    ).toBe(404);
    expect((await imageRequest('demo-case-001', 'unknown', admin)).status).toBe(
      404,
    );
  });
  it('fails closed when auth is disabled', async () => {
    testEnv.AUTH_MODE = 'disabled';
    try {
      expect((await rpc('cases.list', input, { cookie: admin })).status).toBe(
        401,
      );
      expect(
        (await imageRequest('demo-case-001', DEMO_MEDIA[0].id, admin)).status,
      ).toBe(401);
    } finally {
      testEnv.AUTH_MODE = 'open';
    }
  });
  it('supports a private R2 adapter with no public URL', async () => {
    const bucket = env.BUCKET;
    if (!bucket) throw new Error('Missing test R2 binding');
    const demo = new DemoCaseStorage();
    const bytes = await demo.read(DEMO_MEDIA[0].storageKey);
    expect(bytes).not.toBeNull();
    await bucket.put('private-adapter-test.png', bytes as ArrayBuffer);
    const adapter = new R2CaseStorage(bucket);
    expect(await adapter.read('private-adapter-test.png')).toEqual(bytes);
    expect(await adapter.read('not-found.png')).toBeNull();
    await bucket.delete('private-adapter-test.png');
  });
  it('never serves demo images on a deployed or lookalike localhost URL', () => {
    expect(
      privateCaseStorage({
        CASE_STORAGE_MODE: 'demo',
        SERVER_URL: 'http://localhost:4000',
      }),
    ).toBeInstanceOf(DemoCaseStorage);
    for (const SERVER_URL of [
      'https://example.test',
      'http://localhost.example.test',
      '',
    ]) {
      expect(() =>
        privateCaseStorage({ CASE_STORAGE_MODE: 'demo', SERVER_URL }),
      ).toThrow('not configured');
    }
    expect(() => privateCaseStorage({ CASE_STORAGE_MODE: 'r2' })).toThrow(
      'not configured',
    );
    expect(() => privateCaseStorage({})).toThrow('not configured');
  });
  it('rejects corrupted storage bytes without disclosing storage details', async () => {
    await env.DB.prepare('UPDATE case_media SET sha256 = ? WHERE id = ?')
      .bind('0'.repeat(64), DEMO_MEDIA[0].id)
      .run();
    try {
      const response = await imageRequest(
        'demo-case-001',
        DEMO_MEDIA[0].id,
        admin,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'IMAGE_UNAVAILABLE' });
    } finally {
      await env.DB.prepare('UPDATE case_media SET sha256 = ? WHERE id = ?')
        .bind(DEMO_MEDIA[0].sha256, DEMO_MEDIA[0].id)
        .run();
    }
  });
});
