import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminCookie, rpc, signIn, userCookie } from './helpers';

let admin: string;
let ordinary: string;
let reviewer: string;
let reviewerId: string;
const fields = {
  customerName: '虛構人工確認戶',
  code: 'REVIEW-DEMO',
  address: '非真實示範地址',
  amountDue: 5000,
  status: 'pending',
  source: 'manual',
  revisitStatus: 'pending',
  revisitReason: '',
};
const classification = {
  status: 'settled',
  revisit_status: 'not_needed',
  revisit_reason: '虛構原因',
  payment_detected: true,
  payment_amount: 5000,
  confidence: 0.75,
};
async function createCase(name = fields.customerName) {
  const r = await rpc(
    'cases.create',
    { ...fields, customerName: name, code: crypto.randomUUID() },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  return (r.body as { id: string }).id;
}
async function caseDetail(id: string) {
  return (await rpc('cases.detail', { id }, { cookie: admin })).body as {
    version: number;
    status: string;
    revisitStatus: string;
    customerName: string;
    code: string;
    amountDue: number;
  };
}
async function createReport(caseId: string, status = 'needs_review') {
  const r = await rpc(
    'reports.create',
    {
      caseId,
      expectedCaseVersion: (await caseDetail(caseId)).version,
      content: '完全虛構的待確認訪查內容',
      status,
      revisitStatus: 'observe',
      revisitReason: '虛構二訪',
      paymentDetected: false,
      paymentAmount: null,
    },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  return (r.body as { id: string }).id;
}
async function autoReview(caseId: string) {
  const r = await rpc(
    'reviews.list',
    { query: caseId, status: 'pending' },
    { cookie: admin },
  );
  const row = await env.DB.prepare(
    'SELECT id FROM review_items WHERE case_id=? ORDER BY created_at DESC LIMIT 1',
  )
    .bind(caseId)
    .first<{ id: string }>();
  expect(r.status).toBe(200);
  expect(row?.id).toBeTruthy();
  return row?.id ?? '';
}
async function reviewDetail(id: string) {
  const r = await rpc('reviews.detail', { id }, { cookie: admin });
  expect(r.status).toBe(200);
  return r.body as {
    status: string;
    proposedData: unknown;
    confirmedData: unknown;
    resolvedByUserId: string | null;
  };
}
async function resolve(
  id: string,
  caseId: string,
  decision = 'approved',
  confirmedData?: unknown,
) {
  return rpc(
    'reviews.resolve',
    {
      id,
      decision,
      expectedCaseVersion: (await caseDetail(caseId)).version,
      ...(confirmedData ? { confirmedData } : {}),
    },
    { cookie: admin },
  );
}
async function manualReportReview(_caseId: string, reportId: string) {
  const r = await rpc(
    'reviews.create',
    {
      reviewType: 'report_classification',
      reportId,
      classification,
      reason: '虛構分類提案',
      confidence: 0.75,
      priority: 'high',
    },
    { cookie: admin },
  );
  expect(r.status).toBe(200);
  return (r.body as { id: string }).id;
}
beforeAll(async () => {
  admin = await adminCookie();
  ordinary = await userCookie();
  reviewer = await signIn('scoped-reviewer@example.test');
  reviewerId =
    (
      await env.DB.prepare('SELECT id FROM user WHERE email=?')
        .bind('scoped-reviewer@example.test')
        .first<{ id: string }>()
    )?.id ?? '';
  await env.DB.prepare("UPDATE user SET role='reviewer' WHERE id=?")
    .bind(reviewerId)
    .run();
  reviewer = await signIn('scoped-reviewer@example.test');
});
describe('Unified manual review', () => {
  it('a later approved normal status clears the prior direct-payment display marker', async () => {
    const c = await createCase();
    await env.DB.prepare(
      "UPDATE cases SET status='settled',current_status='direct_to_principal' WHERE id=?",
    )
      .bind(c)
      .run();
    const report = await createReport(c);
    expect((await caseDetail(c)).status).toBe('direct_to_principal');
    const id = await manualReportReview(c, report);
    expect((await resolve(id, c)).status).toBe(200);
    expect((await caseDetail(c)).status).toBe('settled');
    expect(
      await env.DB.prepare('SELECT current_status FROM cases WHERE id=?')
        .bind(c)
        .first(),
    ).toMatchObject({ current_status: null });
  });
  it('needs_review enqueues immutable original data without changing status or revisit summary', async () => {
    const c = await createCase();
    const report = await createReport(c);
    const id = await autoReview(c);
    expect(await caseDetail(c)).toMatchObject({
      status: 'pending',
      revisitStatus: 'pending',
    });
    expect(await reviewDetail(id)).toMatchObject({
      status: 'pending',
      proposedData: {
        type: 'report_classification',
        reportId: report,
        originalContent: '完全虛構的待確認訪查內容',
      },
    });
    const logs = (await rpc('cases.audit', { id: c }, { cookie: admin }))
      .body as { action: string; metadata: string }[];
    expect(logs.some((l) => l.action === 'review.created')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('完全虛構的待確認訪查內容');
  });
  it('approve applies a validated proposal and records actor/time without overwriting original data', async () => {
    const c = await createCase();
    const report = await createReport(c);
    const id = await manualReportReview(c, report);
    const before = await reviewDetail(id);
    expect((await resolve(id, c)).status).toBe(200);
    expect(await caseDetail(c)).toMatchObject({
      status: 'settled',
      revisitStatus: 'not_needed',
    });
    const after = await reviewDetail(id);
    expect(after).toMatchObject({
      status: 'approved',
      confirmedData: { type: 'report_classification', classification },
    });
    expect(after.proposedData).toEqual(before.proposedData);
    expect(after.resolvedByUserId).toBeTruthy();
  });
  it('corrected approval accepts edited fields and preserves the original proposal', async () => {
    const c = await createCase();
    await createReport(c);
    const id = await autoReview(c);
    const old = await reviewDetail(id);
    const corrected = {
      type: 'report_classification',
      classification: {
        ...classification,
        status: 'installment',
        payment_detected: false,
        payment_amount: null,
        revisit_status: 'recommended',
      },
    };
    expect((await resolve(id, c, 'corrected', corrected)).status).toBe(200);
    expect(await caseDetail(c)).toMatchObject({
      status: 'installment',
      revisitStatus: 'recommended',
    });
    expect((await reviewDetail(id)).proposedData).toEqual(old.proposedData);
  });
  it('reject changes no report/case data and requires no stale case version', async () => {
    const c = await createCase();
    const report = await createReport(c);
    const id = await autoReview(c);
    const before = await caseDetail(c);
    expect(
      (
        await rpc(
          'reviews.resolve',
          { id, decision: 'rejected' },
          { cookie: admin },
        )
      ).status,
    ).toBe(200);
    expect(await caseDetail(c)).toEqual(before);
    expect((await reviewDetail(id)).confirmedData).toBeNull();
    expect(
      (
        await env.DB.prepare('SELECT status FROM reports WHERE id=?')
          .bind(report)
          .first<{ status: string }>()
      )?.status,
    ).toBe('needs_review');
  });
  it('ordinary collectors and anonymous callers cannot view or resolve the queue', async () => {
    const c = await createCase();
    await createReport(c);
    const id = await autoReview(c);
    for (const path of [
      'reviews.list',
      'reviews.pendingCount',
      'reviews.detail',
      'reviews.resolve',
    ]) {
      const input =
        path === 'reviews.list'
          ? {}
          : path === 'reviews.pendingCount'
            ? undefined
            : path === 'reviews.detail'
              ? { id }
              : { id, decision: 'rejected' };
      expect((await rpc(path, input, { cookie: ordinary })).status).toBe(403);
      expect((await rpc(path, input, { cookie: null })).status).toBe(401);
    }
  });
  it('repeated and concurrent resolve requests update formal data and audit only once', async () => {
    const c = await createCase();
    const report = await createReport(c);
    const id = await manualReportReview(c, report);
    const input = {
      id,
      decision: 'approved',
      expectedCaseVersion: (await caseDetail(c)).version,
    };
    const responses = await Promise.all([
      rpc('reviews.resolve', input, { cookie: admin }),
      rpc('reviews.resolve', input, { cookie: admin }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(
      (await rpc('reviews.resolve', input, { cookie: admin })).body,
    ).toMatchObject({ alreadyResolved: true });
    const logs = await env.DB.prepare(
      "SELECT count(*) AS count FROM audit_logs WHERE action='review.approved' AND json_extract(metadata,'$.reviewId')=?",
    )
      .bind(id)
      .first<{ count: number }>();
    expect(logs?.count).toBe(1);
    expect((await caseDetail(c)).version).toBe(input.expectedCaseVersion + 1);
    expect(
      (
        await rpc(
          'reviews.resolve',
          { id, decision: 'rejected' },
          { cookie: admin },
        )
      ).status,
    ).toBe(409);
  });
  it('rejects unresolved classifications, unmarked corrections and arbitrary JSON', async () => {
    const c = await createCase();
    await createReport(c);
    const id = await autoReview(c);
    expect((await resolve(id, c)).status).toBe(400);
    expect(
      (
        await resolve(id, c, 'approved', {
          type: 'report_classification',
          classification,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await resolve(id, c, 'corrected', {
          type: 'report_classification',
          classification: { ...classification, sql: 'DROP TABLE cases' },
        })
      ).status,
    ).toBe(400);
    expect((await reviewDetail(id)).status).toBe('pending');
  });
  it('stale case/report versions cannot partially resolve', async () => {
    const c = await createCase();
    const report = await createReport(c);
    const id = await autoReview(c);
    expect(
      (
        await rpc(
          'reviews.resolve',
          {
            id,
            decision: 'corrected',
            expectedCaseVersion: 0,
            confirmedData: { type: 'report_classification', classification },
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(409);
    await env.DB.prepare('UPDATE reports SET version=version+1 WHERE id=?')
      .bind(report)
      .run();
    expect(
      (
        await resolve(id, c, 'corrected', {
          type: 'report_classification',
          classification,
        })
      ).status,
    ).toBe(409);
    expect((await reviewDetail(id)).status).toBe('pending');
    expect((await caseDetail(c)).status).toBe('pending');
  });
  it('report editing cannot bypass a pending classification review', async () => {
    const c = await createCase();
    const report = await createReport(c);
    const r = await rpc(
      'reports.edit',
      {
        id: report,
        caseId: c,
        expectedVersion: 0,
        expectedCaseVersion: (await caseDetail(c)).version,
        content: '虛構修訂',
        status: 'settled',
        revisitStatus: 'not_needed',
        revisitReason: null,
        paymentDetected: true,
        paymentAmount: 5000,
      },
      { cookie: admin },
    );
    expect(r.status).toBe(200);
    expect((await caseDetail(c)).status).toBe('pending');
    expect(
      (
        await env.DB.prepare('SELECT status FROM reports WHERE id=?')
          .bind(report)
          .first<{ status: string }>()
      )?.status,
    ).toBe('needs_review');
    expect(
      (await reviewDetail(await autoReview(c))).proposedData,
    ).toMatchObject({ classification: { status: 'settled' } });
  });
  it('case_match candidates are server generated and inaccessible or arbitrary targets are rejected', async () => {
    const name = `虛構重名-${crypto.randomUUID()}`;
    const a = await createCase(name);
    const b = await createCase(name);
    const outside = await createCase();
    const r = await rpc(
      'reviews.create',
      {
        reviewType: 'case_match',
        query: { field: 'customer_name', value: name },
        reason: '虛構重名配對',
      },
      { cookie: admin },
    );
    expect(r.status).toBe(200);
    const id = (r.body as { id: string }).id;
    expect(
      (
        await rpc(
          'reviews.resolve',
          {
            id,
            decision: 'approved',
            confirmedData: { type: 'case_match', selectedCaseId: outside },
          },
          { cookie: admin },
        )
      ).status,
    ).toBe(400);
    const collector = await rpc(
      'collectors.create',
      {
        displayName: 'Fictional Scoped Reviewer',
        code: crypto.randomUUID(),
        userId: reviewerId,
        isActive: true,
      },
      { cookie: admin },
    );
    await rpc(
      'cases.assign',
      {
        caseId: a,
        collectorId: (collector.body as { id: string }).id,
        expectedVersion: 0,
        note: null,
      },
      { cookie: admin },
    );
    const scoped = await rpc('reviews.detail', { id }, { cookie: reviewer });
    expect(scoped.status).toBe(200);
    expect(
      (scoped.body as { candidates: { id: string }[] }).candidates.map(
        (c) => c.id,
      ),
    ).toEqual([a]);
    expect(
      (
        await rpc(
          'reviews.resolve',
          {
            id,
            decision: 'approved',
            confirmedData: { type: 'case_match', selectedCaseId: b },
          },
          { cookie: reviewer },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await rpc(
          'reviews.resolve',
          {
            id,
            decision: 'approved',
            confirmedData: { type: 'case_match', selectedCaseId: a },
          },
          { cookie: reviewer },
        )
      ).status,
    ).toBe(200);
    expect((await reviewDetail(id)).confirmedData).toMatchObject({
      selectedCaseId: a,
    });
  });
  it('image extraction accepts field corrections and retains proposed and confirmed data', async () => {
    const c = await createCase();
    const extraction = {
      code: 'VIRTUAL-EXTRACT',
      customer_name: '虛構圖片戶',
      address: '虛構圖片地址',
      amount_due: 50000,
    };
    const r = await rpc(
      'reviews.create',
      {
        reviewType: 'image_extraction',
        caseId: c,
        extraction,
        reason: '虛構圖片辨識提案',
      },
      { cookie: admin },
    );
    expect(r.status).toBe(200);
    const id = (r.body as { id: string }).id;
    expect(
      (
        await resolve(id, c, 'corrected', {
          type: 'image_extraction',
          extraction: { ...extraction, amount_due: 40000 },
        })
      ).status,
    ).toBe(200);
    expect(await caseDetail(c)).toMatchObject({
      customerName: '虛構圖片戶',
      amountDue: 40000,
    });
    expect((await reviewDetail(id)).proposedData).toMatchObject({
      extraction: { amount_due: 50000 },
    });
    expect((await reviewDetail(id)).confirmedData).toMatchObject({
      extraction: { amount_due: 40000 },
    });
  });
  it('payment detection updates observation only, leaving case status and financial tables unchanged', async () => {
    const c = await createCase();
    const report = await createReport(c, 'follow_up');
    const r = await rpc(
      'reviews.create',
      {
        reviewType: 'payment_detection',
        reportId: report,
        payment: { payment_detected: true, payment_amount: 1200 },
        reason: '虛構收款觀察',
      },
      { cookie: admin },
    );
    const id = (r.body as { id: string }).id;
    expect((await resolve(id, c)).status).toBe(200);
    expect((await caseDetail(c)).status).toBe('follow_up');
    expect(
      await env.DB.prepare(
        'SELECT payment_detected,payment_amount FROM reports WHERE id=?',
      )
        .bind(report)
        .first(),
    ).toMatchObject({ payment_detected: 1, payment_amount: 1200 });
  });
  it('audit failure rolls back the resolution, report and case', async () => {
    const c = await createCase();
    const report = await createReport(c);
    const id = await manualReportReview(c, report);
    await env.DB.exec(
      "CREATE TRIGGER review_test_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='review.approved' BEGIN SELECT RAISE(ABORT,'test failure'); END;",
    );
    try {
      expect((await resolve(id, c)).status).toBe(409);
      expect((await reviewDetail(id)).status).toBe('pending');
      expect((await caseDetail(c)).status).toBe('pending');
    } finally {
      await env.DB.exec('DROP TRIGGER review_test_audit_failure');
    }
  });
  it('supports search, pagination, status/type filters, and scoped pending counts', async () => {
    const c = await createCase();
    await createReport(c);
    const id = await autoReview(c);
    const row = await rpc(
      'reviews.list',
      {
        query: '虛構人工確認戶',
        reviewType: 'report_classification',
        status: 'pending',
        page: 1,
        pageSize: 1,
      },
      { cookie: admin },
    );
    expect(row.status).toBe(200);
    expect((row.body as { items: unknown[] }).items.length).toBe(1);
    expect(
      (await rpc('reviews.pendingCount', undefined, { cookie: admin })).body,
    ).toBeGreaterThan(0);
    await rpc(
      'reviews.resolve',
      { id, decision: 'rejected' },
      { cookie: admin },
    );
    const filtered = await rpc(
      'reviews.list',
      {
        status: 'rejected',
        reviewType: 'report_classification',
        query: '虛構人工確認戶',
      },
      { cookie: admin },
    );
    expect(
      (filtered.body as { items: { id: string }[] }).items.some(
        (r) => r.id === id,
      ),
    ).toBe(true);
    expect(
      (await rpc('reviews.list', { query: "' OR 1=1 --" }, { cookie: admin }))
        .body,
    ).toMatchObject({ total: 0 });
  });
});
