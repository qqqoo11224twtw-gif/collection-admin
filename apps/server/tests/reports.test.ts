import { env } from 'cloudflare:workers';
import {
  classifyReport,
  ManualClassifier,
  reportCaseStatus,
  reportClassificationSchema,
} from '@saasflare-dev/api/report-classification';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminCookie, rpc, signIn, userCookie } from './helpers';

let admin: string;
let ordinary: string;
let agent: string;
let agentId: string;
const reportFields = {
  content: '完全虛構的訪查回報',
  status: 'cannot_find',
  revisitStatus: 'recommended',
  revisitReason: '虛構的二訪建議',
  paymentDetected: false,
  paymentAmount: null,
};
async function createCase(name = '虛構三階段測試戶') {
  const r = await rpc(
    'cases.create',
    {
      customerName: name,
      code: crypto.randomUUID(),
      address: '非真實測試地址',
      amountDue: 5000,
      status: 'pending',
      source: 'manual',
      revisitStatus: 'pending',
      revisitReason: '',
    },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  return (r.body as { id: string; caseNo: string }).id;
}
async function detail(id: string) {
  const r = await rpc('cases.detail', { id }, { cookie: admin });
  return r.body as {
    version: number;
    status: string;
    revisitStatus: string;
    revisitReason: string;
    code: string;
    caseNo: string;
  };
}
async function createReport(
  caseId: string,
  fields: Partial<typeof reportFields> = {},
  cookie = admin,
) {
  return rpc(
    'reports.create',
    {
      ...reportFields,
      ...fields,
      caseId,
      expectedCaseVersion: (await detail(caseId)).version,
    },
    { cookie },
  );
}
async function list(id: string, cookie = admin) {
  const r = await rpc('reports.list', { id }, { cookie });
  expect(r.status).toBe(200);
  return r.body as {
    id: string;
    version: number;
    content: string;
    status: string;
    source: string;
    assignmentId: string | null;
    collectorId: string | null;
    revisitStatus: string;
    revisitReason: string;
  }[];
}
beforeAll(async () => {
  admin = await adminCookie();
  ordinary = await userCookie();
  agent = await signIn('phase-three-agent@example.test');
  agentId =
    (
      await env.DB.prepare('SELECT id FROM user WHERE email=?')
        .bind('phase-three-agent@example.test')
        .first<{ id: string }>()
    )?.id ?? '';
});
describe('Report workflow', () => {
  it('creates a report, preserves visit data and synchronizes cannot_find independently from revisit', async () => {
    const id = await createCase();
    expect((await createReport(id)).status).toBe(200);
    expect(await detail(id)).toMatchObject({
      status: 'follow_up',
      revisitStatus: 'recommended',
      revisitReason: reportFields.revisitReason,
    });
    const rows = await list(id);
    expect(rows[0]).toMatchObject({
      content: reportFields.content,
      status: 'cannot_find',
      source: 'admin',
      assignmentId: null,
      collectorId: null,
    });
    const audit = await rpc('cases.audit', { id }, { cookie: admin });
    const logs = audit.body as { action: string; metadata: string }[];
    expect(logs.some((x) => x.action === 'report.created')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(reportFields.content);
  });
  it.each([
    'settled',
    'installment',
    'unresolved',
    'follow_up',
  ] as const)('maps %s to the case status', async (status) => {
    const id = await createCase();
    expect((await createReport(id, { status })).status).toBe(200);
    expect((await detail(id)).status).toBe(status);
  });
  it('needs_review keeps the current status and never settles a pending case', async () => {
    const id = await createCase();
    expect(
      (
        await createReport(id, {
          status: 'needs_review',
          revisitStatus: 'observe',
        })
      ).status,
    ).toBe(200);
    expect(await detail(id)).toMatchObject({
      status: 'pending',
      revisitStatus: 'observe',
    });
    expect(reportCaseStatus('needs_review')).toBeNull();
  });
  it('rejects anonymous, unassigned and other-case creation and reading', async () => {
    const id = await createCase();
    const input = { ...reportFields, caseId: id, expectedCaseVersion: 0 };
    expect((await rpc('reports.create', input, { cookie: null })).status).toBe(
      401,
    );
    expect(
      (await rpc('reports.create', input, { cookie: ordinary })).status,
    ).toBe(404);
    expect(
      (await rpc('reports.list', { id }, { cookie: ordinary })).status,
    ).toBe(404);
    expect((await rpc('reports.create', input, { cookie: agent })).status).toBe(
      404,
    );
  });
  it('allows the current collector, snapshots assignment, and denies access after unassignment', async () => {
    const id = await createCase();
    const r = await rpc(
      'collectors.create',
      {
        displayName: 'Fictional Report Agent',
        code: crypto.randomUUID(),
        isActive: true,
        userId: agentId,
      },
      { cookie: admin },
    );
    expect(r.status).toBe(200);
    const collectorId = (r.body as { id: string }).id;
    expect(
      (
        await rpc(
          'cases.assign',
          { caseId: id, collectorId, expectedVersion: 0, note: null },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    expect((await createReport(id, {}, agent)).status).toBe(200);
    const rows = await list(id, agent);
    expect(rows[0].source).toBe('collector_portal');
    expect(rows[0].assignmentId).toBeTruthy();
    expect(rows[0].collectorId).toBe(collectorId);
    expect(
      (
        await rpc(
          'reports.edit',
          {
            ...reportFields,
            id: rows[0].id,
            caseId: id,
            expectedVersion: 0,
            expectedCaseVersion: (await detail(id)).version,
          },
          { cookie: agent },
        )
      ).status,
    ).toBe(403);
    await rpc(
      'cases.assign',
      {
        caseId: id,
        collectorId: null,
        expectedVersion: (await detail(id)).version,
        note: null,
      },
      { cookie: admin },
    );
    expect((await rpc('reports.list', { id }, { cookie: agent })).status).toBe(
      404,
    );
    expect((await createReport(id, {}, agent)).status).toBe(404);
    expect((await list(id))[0].assignmentId).toBe(rows[0].assignmentId);
  });
  it('edits latest reports with permission/version checks and audits, preserving original source', async () => {
    const id = await createCase();
    await createReport(id);
    const [r] = await list(id);
    const input = {
      ...reportFields,
      status: 'settled',
      paymentDetected: true,
      paymentAmount: 15000,
      id: r.id,
      caseId: id,
      expectedVersion: 0,
      expectedCaseVersion: (await detail(id)).version,
    };
    expect(
      (await rpc('reports.edit', input, { cookie: ordinary })).status,
    ).toBe(403);
    expect((await rpc('reports.edit', input, { cookie: admin })).status).toBe(
      200,
    );
    expect((await detail(id)).status).toBe('settled');
    expect((await list(id))[0]).toMatchObject({ source: 'admin', version: 1 });
    expect((await rpc('reports.edit', input, { cookie: admin })).status).toBe(
      409,
    );
    expect(
      JSON.stringify(
        (await rpc('cases.audit', { id }, { cookie: admin })).body,
      ),
    ).toContain('report.edited');
  });
  it('keeps each historical recommendation and never syncs older report edits', async () => {
    const id = await createCase();
    await createReport(id);
    const [old] = await list(id);
    await createReport(id, {
      status: 'installment',
      revisitStatus: 'not_needed',
      revisitReason: '新的虛構建議',
    });
    expect((await list(id)).find((r) => r.id === old.id)?.revisitStatus).toBe(
      'recommended',
    );
    expect(
      (
        await rpc(
          'reports.edit',
          {
            ...reportFields,
            status: 'settled',
            id: old.id,
            caseId: id,
            expectedVersion: 0,
            expectedCaseVersion: (await detail(id)).version,
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    expect(await detail(id)).toMatchObject({
      status: 'installment',
      revisitStatus: 'not_needed',
    });
  });
  it('rejects invalid classification, payment fields, forged source and identity fields', async () => {
    const id = await createCase();
    for (const extra of [
      { status: 'pending' },
      { revisitStatus: 'settled' },
      { paymentAmount: 1 },
      { content: '' },
      { paymentDetected: true, paymentAmount: -1 },
      { source: 'telegram' },
      { assignmentId: 'forged' },
    ]) {
      expect(
        (
          await rpc(
            'reports.create',
            { ...reportFields, caseId: id, expectedCaseVersion: 0, ...extra },
            { cookie: admin },
          )
        ).status,
      ).toBe(400);
    }
    expect((await list(id)).length).toBe(0);
    expect((await detail(id)).version).toBe(0);
  });
  it('atomic conflicts allow one concurrent report and one audit, not partial writes', async () => {
    const id = await createCase();
    const input = { ...reportFields, caseId: id, expectedCaseVersion: 0 };
    const results = await Promise.all([
      rpc('reports.create', input, { cookie: admin }),
      rpc('reports.create', input, { cookie: admin }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await list(id)).length).toBe(1);
  });
  it('rolls back report and summary when the audit insert fails', async () => {
    const id = await createCase();
    await env.DB.exec(
      "CREATE TRIGGER report_test_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='report.created' BEGIN SELECT RAISE(ABORT,'test failure'); END;",
    );
    try {
      expect((await createReport(id)).status).toBe(409);
      expect((await detail(id)).status).toBe('pending');
      expect((await list(id)).length).toBe(0);
    } finally {
      await env.DB.exec('DROP TRIGGER report_test_audit_failure');
    }
  });
  it('returns ambiguity for duplicate names, exact code/number matches and respects case scope', async () => {
    const name = `虛構同名-${crypto.randomUUID()}`;
    const a = await createCase(name);
    await createCase(name);
    const lookup = await rpc(
      'cases.lookup',
      { field: 'customer_name', value: name },
      { cookie: admin },
    );
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({ kind: 'ambiguous', truncated: false });
    expect((lookup.body as { candidates: unknown[] }).candidates.length).toBe(
      2,
    );
    const d = await detail(a);
    for (const [field, value] of [
      ['code', d.code],
      ['case_no', d.caseNo],
    ])
      expect(
        (await rpc('cases.lookup', { field, value }, { cookie: admin })).body,
      ).toMatchObject({ kind: 'matched' });
    expect(
      (
        await rpc(
          'cases.lookup',
          { field: 'customer_name', value: name },
          { cookie: ordinary },
        )
      ).body,
    ).toMatchObject({ kind: 'not_found', candidates: [] });
    expect(
      (
        await rpc(
          'cases.lookup',
          { field: 'customer_name', value: "' OR 1=1 --" },
          { cookie: admin },
        )
      ).body,
    ).toMatchObject({ kind: 'not_found' });
  });
  it('validates all provider results before persistence without an AI connection', async () => {
    const manual = {
      status: 'cannot_find' as const,
      revisit_status: 'recommended' as const,
      revisit_reason: null,
      payment_detected: false,
      payment_amount: null,
      confidence: 1,
    };
    expect(
      await classifyReport(new ManualClassifier(), {
        content: 'fictional',
        manual,
      }),
    ).toEqual(manual);
    expect(
      reportClassificationSchema.safeParse({ ...manual, confidence: 2 })
        .success,
    ).toBe(false);
    await expect(
      classifyReport(
        { classify: async () => ({ ...manual, status: 'DROP TABLE cases' }) },
        { content: 'fictional', manual },
      ),
    ).rejects.toThrow();
  });
});
