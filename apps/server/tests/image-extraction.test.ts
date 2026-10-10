import {
  imageExtractionProvider,
  OpenAIImageExtractionProvider,
} from '@saasflare-dev/api/openai-image-extraction';
import { expect, it } from 'vitest';

const output = () => ({
  code: 'ARCHIVED',
  customer_name: '虛構封存戶',
  address: '虛構地址',
  amount_due: 50000,
  confidence: 0.95,
});
it('formal runtime never enables OpenAI or fake recognition regardless of old environment settings', () => {
  for (const mode of ['openai', 'fake', 'disabled', undefined])
    expect(
      imageExtractionProvider({
        IMAGE_EXTRACTION_MODE: mode,
        SERVER_URL: 'http://localhost:4000',
        OPENAI_API_KEY: 'synthetic-test-placeholder',
        OPENAI_IMAGE_MODEL: 'test-image-model',
      }),
    ).toBeNull();
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
