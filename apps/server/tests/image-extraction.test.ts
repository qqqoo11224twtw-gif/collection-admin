import { env } from 'cloudflare:workers';
import type { Context } from '@saasflare-dev/api/context';
import {
  enqueueImageExtraction,
  processImageExtractionJobs,
} from '@saasflare-dev/api/image-extraction-service';
import {
  FakeImageExtractionProvider,
  OpenAIImageExtractionProvider,
} from '@saasflare-dev/api/openai-image-extraction';
import { telegramPrincipal } from '@saasflare-dev/api/telegram-principal';
import { DEMO_IMAGES } from '@saasflare-dev/db/demo-images';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, expect, it } from 'vitest';
import app from '../src/index';
import { adminCookie, rpc, userCookie } from './helpers';

let cookie: string;
let ordinary: string;
let context: Context;
const output = () => ({
  code: crypto.randomUUID(),
  customer_name: `Fictional ${crypto.randomUUID()}`,
  address: 'Fictional image street',
  amount_due: 50000,
  confidence: 0.95,
});
beforeAll(async () => {
  cookie = await adminCookie();
  ordinary = await userCookie();
  const user = await env.DB.prepare('SELECT id FROM user WHERE email=?')
    .bind('boss@test.dev')
    .first<{ id: string }>();
  context = await telegramPrincipal(
    {
      env,
      DB: drizzle(env.DB),
      headers: new Headers(),
      session: null,
      user: null,
      isAdmin: false,
    },
    user?.id ?? '',
  );
});
async function draft() {
  const received = await rpc(
    'intake.receive',
    {
      source: 'manual',
      externalId: crypto.randomUUID(),
      proposedData: {
        code: null,
        customer_name: null,
        address: null,
        amount_due: null,
      },
    },
    { cookie },
  );
  expect(received.status).toBe(200);
  const id = (received.body as { id: string }).id;
  const form = new FormData();
  form.append('expectedVersion', '0');
  const bytes = Uint8Array.from(atob(DEMO_IMAGES[0].base64), (c) =>
    c.charCodeAt(0),
  ).buffer;
  for (let i = 0; i < 2; i++)
    form.append(
      'files',
      new File([bytes], `fictional-${i}.png`, { type: 'image/png' }),
    );
  const upload = await app.fetch(
    new Request(`http://localhost/api/intake/${id}/media`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'http://localhost:3000' },
      body: form,
    }),
  );
  expect(upload.status).toBe(201);
  return id;
}
async function detail(id: string) {
  return (await rpc('intake.detail', { id }, { cookie })).body as {
    status: string;
    confidence: number;
    proposedData: unknown;
    receivedData: unknown;
    reviewItemId: string | null;
    matchedCaseId: string | null;
    version: number;
  };
}
it('deduplicates image SHA jobs, preserves original input, caches calls and leaves no-match as a proposal', async () => {
  const id = await draft();
  const proposed = output();
  const provider = new FakeImageExtractionProvider(proposed);
  await enqueueImageExtraction(context, id, provider);
  await enqueueImageExtraction(context, id, provider);
  await processImageExtractionJobs(context, provider, Date.now() + 10000);
  expect(provider.calls).toBe(1);
  expect(await detail(id)).toMatchObject({
    status: 'processing',
    proposedData: {
      code: proposed.code,
      customer_name: proposed.customer_name,
      address: proposed.address,
      amount_due: proposed.amount_due,
    },
    matchedCaseId: null,
  });
  expect((await detail(id)).receivedData).toMatchObject({
    customer_name: null,
  });
  await processImageExtractionJobs(context, provider, Date.now() + 20000);
  expect(provider.calls).toBe(1);
  const usage = await env.DB.prepare(
    'SELECT * FROM ai_usage_logs WHERE job_id IN (SELECT id FROM ai_image_jobs WHERE intake_id=?)',
  )
    .bind(id)
    .all();
  expect(usage.results).toHaveLength(1);
  expect(usage.results[0]).toMatchObject({
    task_type: 'image_extraction',
    input_tokens: 10,
    output_tokens: 5,
    success: 1,
  });
  const changed = new FakeImageExtractionProvider(proposed, 'fake-image-v2');
  await enqueueImageExtraction(context, id, changed);
  await processImageExtractionJobs(context, changed, Date.now() + 30000);
  expect(changed.calls).toBe(1);
});
it('high confidence unique match promotes private media without overwriting the case', async () => {
  const proposed = output();
  const created = await rpc(
    'cases.create',
    {
      customerName: proposed.customer_name,
      code: proposed.code,
      address: proposed.address,
      amountDue: 123,
      status: 'pending',
      source: 'manual',
      revisitStatus: 'pending',
      revisitReason: '',
    },
    { cookie },
  );
  expect(created.status).toBe(200);
  const caseId = (created.body as { id: string }).id;
  const id = await draft();
  const provider = new FakeImageExtractionProvider(proposed);
  await enqueueImageExtraction(context, id, provider);
  await processImageExtractionJobs(context, provider, Date.now() + 10000);
  expect(await detail(id)).toMatchObject({
    status: 'matched',
    matchedCaseId: caseId,
  });
  expect(
    (
      await env.DB.prepare('SELECT amount_due FROM cases WHERE id=?')
        .bind(caseId)
        .first()
    )?.amount_due,
  ).toBe(123);
  expect(
    (
      await env.DB.prepare(
        'SELECT count(*) AS n FROM case_media WHERE case_id=?',
      )
        .bind(caseId)
        .first()
    )?.n,
  ).toBe(2);
});
it('ambiguous high confidence goes to case-match review; low confidence and invalid extra keys go to extraction review', async () => {
  const proposed = output();
  for (let i = 0; i < 2; i++)
    expect(
      (
        await rpc(
          'cases.create',
          {
            customerName: proposed.customer_name,
            code: proposed.code,
            duplicateOverride: true,
            address: proposed.address,
            amountDue: 123,
            status: 'pending',
            source: 'manual',
            revisitStatus: 'pending',
            revisitReason: '',
          },
          { cookie },
        )
      ).status,
    ).toBe(200);
  for (const [fields, type] of [
    [proposed, 'case_match'],
    [{ ...proposed, confidence: 0.5 }, 'image_extraction'],
    [{ ...proposed, unexpected: 'forbidden' }, 'image_extraction'],
  ] as const) {
    const id = await draft();
    const provider = new FakeImageExtractionProvider(fields);
    await enqueueImageExtraction(context, id, provider);
    await processImageExtractionJobs(context, provider, Date.now() + 10000);
    const row = await detail(id);
    expect(row.status).toBe('needs_review');
    expect(
      (
        await env.DB.prepare('SELECT review_type FROM review_items WHERE id=?')
          .bind(row.reviewItemId)
          .first()
      )?.review_type,
    ).toBe(type);
  }
});
it('bounds failed attempts and logs each real invocation before final review', async () => {
  const id = await draft();
  const provider = new FakeImageExtractionProvider(output());
  provider.failures = 10;
  await enqueueImageExtraction(context, id, provider);
  for (let i = 0; i < 6; i++)
    await processImageExtractionJobs(
      context,
      provider,
      Date.now() + 10000 + i * 400000,
    );
  expect(provider.calls).toBe(4);
  expect((await detail(id)).status).toBe('needs_review');
  expect(
    (
      await env.DB.prepare(
        'SELECT count(*) AS n FROM ai_usage_logs WHERE job_id IN (SELECT id FROM ai_image_jobs WHERE intake_id=?)',
      )
        .bind(id)
        .first()
    )?.n,
  ).toBe(4);
});
it('D1 application rollback reuses validated KV result without calling the provider again', async () => {
  const id = await draft();
  const provider = new FakeImageExtractionProvider(output());
  await enqueueImageExtraction(context, id, provider);
  await env.DB.exec(
    "CREATE TRIGGER fail_image_result BEFORE UPDATE OF result ON ai_image_jobs WHEN NEW.result IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
  );
  try {
    await processImageExtractionJobs(context, provider, Date.now() + 10000);
    expect(provider.calls).toBe(1);
  } finally {
    await env.DB.exec('DROP TRIGGER fail_image_result');
  }
  await processImageExtractionJobs(context, provider, Date.now() + 400000);
  expect(provider.calls).toBe(1);
  expect((await detail(id)).status).toBe('processing');
});
it('denies extraction API to ordinary users and formal resolution while jobs are pending', async () => {
  const id = await draft();
  expect(
    (await rpc('intake.extractImages', { id }, { cookie: ordinary })).status,
  ).toBe(403);
  await enqueueImageExtraction(
    context,
    id,
    new FakeImageExtractionProvider(output()),
  );
  const row = await detail(id);
  expect(
    (
      await rpc(
        'intake.resolve',
        {
          id,
          expectedVersion: row.version,
          action: 'create',
        },
        { cookie },
      )
    ).status,
  ).toBe(409);
});
it('Responses transport uses strict structured output and private bytes, handles malformed output and retryable errors without network', async () => {
  let body: Record<string, unknown> = {};
  const transport: typeof fetch = async (_request, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(output()) }],
        },
      ],
      usage: { input_tokens: 15, output_tokens: 6 },
    });
  };
  const provider = new OpenAIImageExtractionProvider(
    {
      OPENAI_API_KEY: 'synthetic-test-placeholder',
      OPENAI_IMAGE_MODEL: 'test-image-model',
    },
    transport,
  );
  const result = await provider.run({
    mediaId: 'test',
    image: { bytes: new Uint8Array([1, 2, 3]).buffer, mediaType: 'image/png' },
  });
  expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 6 });
  expect(body).toMatchObject({
    store: false,
    model: 'test-image-model',
    text: { format: { strict: true, schema: { additionalProperties: false } } },
  });
  expect(JSON.stringify(body)).toContain('data:image/png;base64,AQID');
  const rejected = new OpenAIImageExtractionProvider(
    {
      OPENAI_API_KEY: 'synthetic-test-placeholder',
      OPENAI_IMAGE_MODEL: 'test-image-model',
    },
    async () => new Response('', { status: 429 }),
  );
  await expect(
    rejected.run({
      mediaId: 'test',
      image: { bytes: new ArrayBuffer(1), mediaType: 'image/png' },
    }),
  ).rejects.toMatchObject({ code: 'AI_RATE_LIMIT', retryable: true });
});
