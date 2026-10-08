import { env } from 'cloudflare:workers';
import { normalizedAddress } from '@saasflare-dev/api/case-matching';
import {
  extractionOutputSchema,
  receiveFromAdapter,
  validatedExtraction,
} from '@saasflare-dev/api/intake-contract';
import { DEMO_IMAGES } from '@saasflare-dev/db/demo-images';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/index';
import { adminCookie, rpc, signIn, userCookie } from './helpers';

let admin: string;
let ordinary: string;
let other: string;
const fields = {
  code: 'FICTIONAL-DRAFT',
  customer_name: '虛構接收戶',
  address: '虛構市草稿路（非真實地址）',
  amount_due: 50000,
};
async function receive(extra: Record<string, unknown> = {}, cookie = admin) {
  const r = await rpc(
    'intake.receive',
    {
      source: 'manual',
      proposedData: { ...fields, code: crypto.randomUUID() },
      ...extra,
    },
    { cookie },
  );
  expect(r.status).toBe(200);
  return r.body as { id: string; duplicate: boolean };
}
async function detail(id: string, cookie = admin) {
  const r = await rpc('intake.detail', { id }, { cookie });
  expect(r.status).toBe(200);
  return r.body as {
    id: string;
    status: string;
    version: number;
    proposedData: typeof fields;
    confirmedData: typeof fields | null;
    matchedCaseId: string | null;
    reviewItemId: string | null;
    media: { id: string; isDuplicate: boolean; promotedAt: Date | null }[];
    matching: { kind: string; candidates: { id: string }[] };
    audit: { action: string }[];
  };
}
async function resolve(
  id: string,
  action = 'create',
  extra: Record<string, unknown> = {},
) {
  const d = await detail(id);
  return rpc(
    'intake.resolve',
    { id, expectedVersion: d.version, action, ...extra },
    { cookie: admin },
  );
}
async function existing(values: Partial<typeof fields> = {}) {
  const r = await rpc(
    'cases.create',
    {
      customerName: values.customer_name ?? fields.customer_name,
      code: values.code ?? crypto.randomUUID(),
      address: values.address ?? fields.address,
      amountDue: values.amount_due ?? 100,
      status: 'pending',
      source: 'manual',
      revisitStatus: 'pending',
      revisitReason: '',
    },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  return r.body as { id: string; caseNo: string };
}
async function upload(id: string, cookie = admin, files = 2) {
  const d = await detail(id);
  const form = new FormData();
  form.append('expectedVersion', String(d.version));
  const bytes = Uint8Array.from(atob(DEMO_IMAGES[0].base64), (c) =>
    c.charCodeAt(0),
  ).buffer;
  for (let i = 0; i < files; i++)
    form.append(
      'files',
      new File([bytes], `fictional-${i}.png`, { type: 'image/png' }),
    );
  return app.fetch(
    new Request(`http://localhost/api/intake/${id}/media`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'http://localhost:3000' },
      body: form,
    }),
  );
}
beforeAll(async () => {
  admin = await adminCookie();
  ordinary = await userCookie();
  other = await signIn('other-intake@example.test');
});
describe('Unified intake', () => {
  it('receives a validated draft without creating cases', async () => {
    const name = `虛構-${crypto.randomUUID()}`;
    const row = await receive({
      proposedData: { ...fields, customer_name: name },
    });
    expect(await detail(row.id)).toMatchObject({
      status: 'received',
      matchedCaseId: null,
      confirmedData: null,
    });
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS n FROM cases WHERE customer_name=?',
        )
          .bind(name)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (await detail(row.id)).audit.some((x) => x.action === 'intake.received'),
    ).toBe(true);
  });
  it('external_id replays and concurrent deliveries return one intake and one receive event', async () => {
    const input = {
      source: 'telegram',
      externalId: `event-${crypto.randomUUID()}`,
      proposedData: {
        ...fields,
        code: crypto.randomUUID(),
        customer_name: crypto.randomUUID(),
      },
    };
    const results = await Promise.all([
      rpc('intake.receive', input, { cookie: admin }),
      rpc('intake.receive', input, { cookie: admin }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const ids = results.map((r) => (r.body as { id: string }).id);
    expect(ids[0]).toBe(ids[1]);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM audit_logs WHERE entity_id=? AND action='intake.received'",
        )
          .bind(ids[0])
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      (await rpc('intake.receive', input, { cookie: admin })).body,
    ).toMatchObject({ id: ids[0], duplicate: true });
  });
  it('dedupe keys are scoped by source and conflicting replays never overwrite data', async () => {
    const key = crypto.randomUUID();
    const a = await receive({ dedupeKey: key, proposedData: fields });
    const b = await receive({
      source: 'api',
      dedupeKey: key,
      proposedData: fields,
    });
    expect(a.id).not.toBe(b.id);
    expect(
      (
        await rpc(
          'intake.receive',
          {
            dedupeKey: key,
            source: 'manual',
            proposedData: { ...fields, amount_due: 1 },
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(409);
    expect((await detail(a.id)).proposedData.amount_due).toBe(50000);
  });
  it('rejects arbitrary JSON, case IDs and invalid amounts at ingestion', async () => {
    for (const proposedData of [
      { ...fields, sql: 'DROP TABLE cases' },
      { ...fields, amount_due: -1 },
      { ...fields, amount_due: 1.5 },
      { ...fields, id: 'forged' },
    ])
      expect(
        (await rpc('intake.receive', { proposedData }, { cookie: admin }))
          .status,
      ).toBe(400);
    expect(
      (
        await rpc(
          'intake.receive',
          { proposedData: fields, matchedCaseId: 'forged' },
          { cookie: admin },
        )
      ).status,
    ).toBe(400);
  });
  it('ambiguous matching enters the existing review center and never selects the first case', async () => {
    const code = crypto.randomUUID();
    const a = await existing({ code });
    const b = await existing({ code });
    const row = await receive({ proposedData: { ...fields, code } });
    expect((await detail(row.id)).matching.kind).toBe('ambiguous');
    const r = await rpc(
      'intake.process',
      { id: row.id, expectedVersion: 0 },
      { cookie: admin },
    );
    expect(r.status).toBe(200);
    const d = await detail(row.id);
    expect(d.status).toBe('needs_review');
    expect(d.matchedCaseId).toBeNull();
    expect(d.reviewItemId).toBeTruthy();
    const review = await rpc(
      'reviews.detail',
      { id: d.reviewItemId },
      { cookie: admin },
    );
    expect(
      (review.body as { candidates: { id: string }[] }).candidates
        .map((c) => c.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(
      (
        await rpc(
          'reviews.resolve',
          {
            id: d.reviewItemId,
            decision: 'approved',
            confirmedData: { type: 'case_match', selectedCaseId: b.id },
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    expect(await detail(row.id)).toMatchObject({
      status: 'matched',
      matchedCaseId: b.id,
    });
  });
  it('unique match links a case without overwriting name, address or amount', async () => {
    const c = await existing();
    const current = (await rpc('cases.detail', { id: c.id }, { cookie: admin }))
      .body as { code: string };
    const row = await receive({
      proposedData: {
        ...fields,
        code: current.code,
        customer_name: '另一虛構提案',
        address: '另一虛構地址',
        amount_due: 999,
      },
    });
    expect((await detail(row.id)).matching.kind).toBe('unique_match');
    const before = (await rpc('cases.detail', { id: c.id }, { cookie: admin }))
      .body;
    expect((await resolve(row.id, 'match', { caseId: c.id })).status).toBe(200);
    expect(
      (await rpc('cases.detail', { id: c.id }, { cookie: admin })).body,
    ).toEqual(before);
    expect((await detail(row.id)).proposedData.amount_due).toBe(999);
  });
  it('case_no exact and normalized address comparison safely disambiguate', async () => {
    const name = crypto.randomUUID();
    const a = await existing({ customer_name: name, address: '虛構路１２號' });
    await existing({ customer_name: name, address: '虛構路99號' });
    const row = await receive({
      proposedData: {
        ...fields,
        code: crypto.randomUUID(),
        customer_name: name,
        address: '虛構路 12 號',
      },
    });
    expect((await detail(row.id)).matching).toMatchObject({
      kind: 'unique_match',
      candidates: [{ id: a.id }],
    });
    const byNo = await receive({
      caseNo: a.caseNo,
      proposedData: {
        ...fields,
        code: crypto.randomUUID(),
        customer_name: '不同提案',
      },
    });
    expect((await detail(byNo.id)).matching.candidates[0].id).toBe(a.id);
    expect(normalizedAddress('虛構路１２號')).toBe(
      normalizedAddress('虛構路 12 號'),
    );
  });
  it('no_match creates a backend-numbered case and translates the original source', async () => {
    const row = await receive({
      source: 'poster_builder',
      proposedData: {
        ...fields,
        code: crypto.randomUUID(),
        customer_name: crypto.randomUUID(),
      },
    });
    expect((await detail(row.id)).matching.kind).toBe('no_match');
    expect((await resolve(row.id)).status).toBe(200);
    const d = await detail(row.id);
    expect(d.status).toBe('created');
    const c = (
      await rpc('cases.detail', { id: d.matchedCaseId }, { cookie: admin })
    ).body as { caseNo: string; source: string };
    expect(c.caseNo).toMatch(/^CASE-\d{8}-[A-F0-9]{32}$/);
    expect(c.source).toBe('poster_builder');
    expect(d.audit.some((x) => x.action === 'intake.created_case')).toBe(true);
  });
  it('repeated or concurrent creation cannot create two cases', async () => {
    const row = await receive({
      externalId: crypto.randomUUID(),
      proposedData: {
        ...fields,
        code: crypto.randomUUID(),
        customer_name: crypto.randomUUID(),
      },
    });
    const input = { id: row.id, expectedVersion: 0, action: 'create' };
    const results = await Promise.all([
      rpc('intake.resolve', input, { cookie: admin }),
      rpc('intake.resolve', input, { cookie: admin }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect((results[0].body as { caseId: string }).caseId).toBe(
      (results[1].body as { caseId: string }).caseId,
    );
    expect(
      (await rpc('intake.resolve', input, { cookie: admin })).body,
    ).toMatchObject({ alreadyProcessed: true });
  });
  it('default collectors can create their own draft but cannot resolve, reject or view another draft', async () => {
    const row = await receive({}, ordinary);
    for (const action of ['create', 'match', 'review', 'reject'])
      expect(
        (
          await rpc(
            'intake.resolve',
            { id: row.id, expectedVersion: 0, action },
            { cookie: ordinary },
          )
        ).status,
      ).toBe(403);
    expect(
      (await rpc('intake.detail', { id: row.id }, { cookie: other })).status,
    ).toBe(404);
    expect(
      (await rpc('intake.receive', { proposedData: fields }, { cookie: null }))
        .status,
    ).toBe(401);
  });
  it('private attachments preserve duplicate source records and promote once to the correct case', async () => {
    const row = await receive({
      proposedData: {
        ...fields,
        code: crypto.randomUUID(),
        customer_name: crypto.randomUUID(),
      },
    });
    expect((await upload(row.id)).status).toBe(201);
    const d = await detail(row.id);
    expect(d.media).toHaveLength(2);
    expect(d.media.some((m) => m.isDuplicate)).toBe(true);
    expect((await resolve(row.id)).status).toBe(200);
    const done = await detail(row.id);
    const cases = (
      await rpc('cases.media', { id: done.matchedCaseId }, { cookie: admin })
    ).body as { id: string }[];
    expect(cases).toHaveLength(2);
    expect(done.media.every((m) => !!m.promotedAt)).toBe(true);
    expect(
      (await rpc('intake.promote', { id: row.id }, { cookie: admin })).body,
    ).toMatchObject({ count: 0, alreadyPromoted: true });
    expect(
      (await rpc('cases.media', { id: done.matchedCaseId }, { cookie: admin }))
        .body,
    ).toEqual(cases);
    const original = await app.fetch(
      new Request(
        `http://localhost/api/intake/${row.id}/media/${d.media[0].id}/image`,
        { headers: { Cookie: admin } },
      ),
    );
    expect(original.status).toBe(200);
    expect(original.headers.get('Cache-Control')).toContain('no-store');
    expect(
      (
        await app.fetch(
          new Request(
            `http://localhost/api/intake/${row.id}/media/${d.media[0].id}/image`,
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          new Request(
            `http://localhost/api/intake/${row.id}/media/${d.media[0].id}/image`,
            { headers: { Cookie: ordinary } },
          ),
        )
      ).status,
    ).toBe(404);
  });
  it('matching promotes attachments to the selected existing case, never another candidate', async () => {
    const code = crypto.randomUUID();
    const a = await existing({ code });
    const b = await existing({ code });
    const row = await receive({ proposedData: { ...fields, code } });
    await upload(row.id, admin, 1);
    await resolve(row.id, 'review');
    const d = await detail(row.id);
    expect(
      (
        await rpc(
          'reviews.resolve',
          {
            id: d.reviewItemId,
            decision: 'approved',
            confirmedData: { type: 'case_match', selectedCaseId: b.id },
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    expect(
      (await rpc('cases.media', { id: a.id }, { cookie: admin })).body,
    ).toEqual([]);
    expect(
      (await rpc('cases.media', { id: b.id }, { cookie: admin }))
        .body as unknown[],
    ).toHaveLength(1);
  });
  it('low-confidence or incomplete extraction is corrected through the same resolver', async () => {
    const row = await receive({
      confidence: 0.2,
      proposedData: {
        code: null,
        customer_name: null,
        address: null,
        amount_due: null,
      },
    });
    expect((await resolve(row.id)).status).toBe(200);
    const d = await detail(row.id);
    expect(d.status).toBe('needs_review');
    const confirmed = {
      ...fields,
      code: crypto.randomUUID(),
      customer_name: crypto.randomUUID(),
    };
    expect(
      (
        await rpc(
          'reviews.resolve',
          {
            id: d.reviewItemId,
            decision: 'corrected',
            confirmedData: { type: 'image_extraction', extraction: confirmed },
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    expect(await detail(row.id)).toMatchObject({
      status: 'created',
      confirmedData: confirmed,
      proposedData: { customer_name: null },
    });
  });
  it('cannot match arbitrary case IDs or bypass an unresolved review', async () => {
    const c = await existing();
    const row = await receive({
      proposedData: {
        ...fields,
        code: crypto.randomUUID(),
        customer_name: crypto.randomUUID(),
      },
    });
    expect((await resolve(row.id, 'match', { caseId: c.id })).status).toBe(400);
    await resolve(row.id, 'review');
    expect((await resolve(row.id)).status).toBe(409);
  });
  it('reject completes the linked review without creating a case or deleting attachments', async () => {
    const row = await receive({
      proposedData: {
        ...fields,
        code: crypto.randomUUID(),
        customer_name: crypto.randomUUID(),
      },
    });
    await upload(row.id, admin, 1);
    await resolve(row.id, 'review');
    const d = await detail(row.id);
    expect(
      (
        await rpc(
          'reviews.resolve',
          { id: d.reviewItemId, decision: 'rejected' },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    expect(await detail(row.id)).toMatchObject({
      status: 'rejected',
      matchedCaseId: null,
    });
    expect((await detail(row.id)).media).toHaveLength(1);
  });
  it('audit failure rolls back the case, promotion and intake; original storage remains', async () => {
    const row = await receive({
      proposedData: {
        ...fields,
        code: crypto.randomUUID(),
        customer_name: crypto.randomUUID(),
      },
    });
    await upload(row.id, admin, 1);
    const d = await detail(row.id);
    await env.DB.exec(
      "CREATE TRIGGER intake_test_failure BEFORE INSERT ON audit_logs WHEN NEW.action='intake.created_case' BEGIN SELECT RAISE(ABORT,'test failure'); END;",
    );
    try {
      expect((await resolve(row.id)).status).toBe(409);
      expect(await detail(row.id)).toMatchObject({
        status: 'received',
        matchedCaseId: null,
      });
      expect(
        (
          await env.DB.prepare(
            'SELECT count(*) AS n FROM cases WHERE customer_name=?',
          )
            .bind(d.proposedData.customer_name)
            .first<{ n: number }>()
        )?.n,
      ).toBe(0);
      expect((await detail(row.id)).media[0].promotedAt).toBeNull();
    } finally {
      await env.DB.exec('DROP TRIGGER intake_test_failure');
    }
  });
  it('listing supports filters/search/pagination and audit contains identifiers only', async () => {
    const name = crypto.randomUUID();
    const row = await receive({
      source: 'historical_import',
      proposedData: { ...fields, customer_name: name },
    });
    const list = await rpc(
      'intake.list',
      {
        query: name,
        source: 'historical_import',
        status: 'received',
        pageSize: 1,
      },
      { cookie: admin },
    );
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      total: 1,
      items: [{ id: row.id, mediaCount: 0 }],
    });
    const audit = (await detail(row.id)).audit;
    expect(JSON.stringify(audit)).not.toContain(name);
    expect(
      (await rpc('intake.list', { query: "' OR 1=1 --" }, { cookie: admin }))
        .body,
    ).toMatchObject({ total: 0 });
  });
  it('adapter and extraction interfaces validate data before calling the receiver', async () => {
    const parsed = extractionOutputSchema.parse({ ...fields, confidence: 0.9 });
    expect(parsed.confidence).toBe(0.9);
    await expect(
      validatedExtraction(
        { extract: async () => ({ ...fields, confidence: 3 }) },
        { mediaId: 'synthetic' },
      ),
    ).rejects.toThrow();
    let called = false;
    const r = await receiveFromAdapter(
      {
        source: 'telegram',
        normalize: async () => ({
          proposedData: fields,
          externalId: 'synthetic-event',
        }),
      },
      {},
      {
        receive: async (input) => {
          called = true;
          expect(input.source).toBe('telegram');
          return { id: 'synthetic', duplicate: false };
        },
      },
    );
    expect(called).toBe(true);
    expect(r.id).toBe('synthetic');
  });
});
