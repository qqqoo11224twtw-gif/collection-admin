import { env } from 'cloudflare:workers';
import {
  bulkCreateSchema,
  createBulkCases,
  previewBulkCases,
} from '@saasflare-dev/api/bulk-case-create';
import {
  captionCode,
  normalizeCounty,
  resolveOcrFields,
  type VisualOcr,
} from '@saasflare-dev/api/bulk-ocr-contract';
import {
  issueOcrReceipt,
  verifyOcrReview,
} from '@saasflare-dev/api/bulk-ocr-receipt';
import { recognizeBulkImage } from '@saasflare-dev/api/bulk-ocr-service';
import type { Context } from '@saasflare-dev/api/context';
import { telegramPrincipal } from '@saasflare-dev/api/telegram-principal';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, expect, it } from 'vitest';
import { adminCookie } from './helpers';

const field = (
  value: string | null,
  source: VisualOcr['code']['source'],
  evidence = value ?? '',
) => ({ value, source, evidence, legible: true, ambiguous: false });
function sample(caption = '莊佩璇 菲菲 ATM'): VisualOcr {
  return {
    quality: 'readable',
    code: field('菲菲', 'caption', caption),
    customerName: field('莊佩璇', 'id_front'),
    region: field('彰化縣', 'household'),
  };
}
it.each([
  '莊佩璇 菲菲 ATM',
  '菲菲 莊佩璇 ATM',
  '莊佩璇 菲菲',
  '菲菲 莊佩璇',
  '菲菲 ATM',
  '菲菲',
])('extracts caption form %s without swapping', (caption) => {
  expect(captionCode(caption, '莊佩璇')).toBe('菲菲');
  const result = resolveOcrFields(
    sample(caption),
    `姓名莊佩璇 戶籍彰化縣 ${caption}`,
  );
  expect(result.code.value).toBe('菲菲');
  expect(result.customerName.value).toBe('莊佩璇');
});
it('normalizes all 22 counties without conflating Hsinchu or Chiayi', () => {
  for (const county of [
    '基隆市',
    '台北市',
    '新北市',
    '桃園市',
    '新竹市',
    '新竹縣',
    '苗栗縣',
    '台中市',
    '彰化縣',
    '南投縣',
    '雲林縣',
    '嘉義市',
    '嘉義縣',
    '台南市',
    '高雄市',
    '屏東縣',
    '宜蘭縣',
    '花蓮縣',
    '台東縣',
    '澎湖縣',
    '金門縣',
    '連江縣',
  ])
    expect(normalizeCounty(county)).toBe(county);
  expect(normalizeCounty('臺中市')).toBe('台中市');
  expect(normalizeCounty('彰化')).toBe('彰化縣');
  expect(normalizeCounty('新竹')).toBe('');
  expect(normalizeCounty('嘉義')).toBe('');
});
it('retains name from ID only, blanks absent nickname and uses household over current address', () => {
  const raw = sample();
  raw.code = field(null, 'unknown');
  const result = resolveOcrFields(raw, '莊佩璇 彰化縣 現居高雄市');
  expect(result.code.value).toBe('');
  expect(result.customerName.value).toBe('莊佩璇');
  expect(result.region.value).toBe('彰化縣');
});
it('abstains for blur, multiple people, ambiguous glyphs and independent OCR mismatch', () => {
  for (const quality of ['poor', 'multiple_people'] as const)
    expect(
      Object.values(
        resolveOcrFields({ ...sample(), quality }, '莊佩璇 菲菲 ATM 彰化縣'),
      ).every((f) => f.value === ''),
    ).toBe(true);
  const raw = sample();
  raw.customerName.ambiguous = true;
  expect(
    resolveOcrFields(raw, '莊佩璇 菲菲 ATM 彰化縣').customerName.value,
  ).toBe('');
  expect(
    resolveOcrFields(sample(), '莊佩萱 菲菲 ATM 彰化縣').customerName.value,
  ).toBe('');
});
it('rejects multiple aliases, ATM, phone, ID number, unlabeled names and competing regions', () => {
  expect(captionCode('菲菲 小美 ATM', '')).toBe('');
  for (const code of ['ATM', '0912345678', 'A123456789']) {
    const raw = sample(code);
    raw.code.value = code;
    expect(resolveOcrFields(raw, `莊佩璇 彰化縣 ${code}`).code.value).toBe('');
  }
  const raw = sample();
  raw.customerName.source = 'caption';
  raw.region.ambiguous = true;
  const result = resolveOcrFields(raw, '莊佩璇 菲菲 ATM 彰化縣 高雄市');
  expect(result.customerName.value).toBe('');
  expect(result.region.value).toBe('');
});
it('keeps only minimal evidence and optional source region', () => {
  const result = resolveOcrFields(
    sample(),
    '莊佩璇 菲菲 ATM 彰化縣 A123456789 地址街道',
    [{ text: '莊佩璇', area: [{ x: 3, y: 4 }] }],
  );
  expect(result.customerName.area).toEqual([{ x: 3, y: 4 }]);
  expect(JSON.stringify(result)).not.toContain('A123456789');
  expect(JSON.stringify(result)).not.toContain('地址街道');
});
let context: Context;
beforeAll(async () => {
  await adminCookie();
  const actor = await env.DB.prepare(
    "SELECT id FROM user WHERE email='boss@test.dev'",
  ).first<{ id: string }>();
  context = await telegramPrincipal(
    {
      env,
      DB: drizzle(env.DB),
      headers: new Headers(),
      user: null,
      session: null,
      isAdmin: false,
    },
    actor?.id ?? '',
  );
});
it('requires signed user-bound review and preserves batch idempotency', async () => {
  const hash = 'a'.repeat(64);
  const receipt = await issueOcrReceipt(context, crypto.randomUUID(), hash);
  expect(
    await verifyOcrReview(context, {
      receipt,
      imageHash: hash,
      confirmed: false,
    }),
  ).toBe(false);
  expect(
    await verifyOcrReview(context, {
      receipt: `${receipt}x`,
      imageHash: hash,
      confirmed: true,
    }),
  ).toBe(false);
  expect(
    await verifyOcrReview(context, {
      receipt,
      imageHash: 'b'.repeat(64),
      confirmed: true,
    }),
  ).toBe(false);
  const input = bulkCreateSchema.parse({
    batchId: crypto.randomUUID(),
    mode: 'historical',
    rows: [
      {
        code: `ocr-${crypto.randomUUID()}`,
        customerName: '測試姓名',
        region: '彰化縣',
        ocrReview: { receipt, imageHash: hash, confirmed: false },
      },
    ],
  });
  expect((await previewBulkCases(context, input))[0].status).toBe('invalid');
  expect((await createBulkCases(context, input)).succeeded).toBe(0);
  if (!input.rows[0].ocrReview) throw Error('missing');
  input.rows[0].ocrReview.confirmed = true;
  const created = await createBulkCases(context, input);
  expect(created.succeeded).toBe(1);
  expect((await createBulkCases(context, input)).results[0].caseId).toBe(
    created.results[0].caseId,
  );
});
it('fails closed before external requests for unauthenticated and disabled callers', async () => {
  let sent = false;
  const send: typeof fetch = async () => {
    sent = true;
    throw Error('must not send');
  };
  await expect(
    recognizeBulkImage(
      { ...context, user: null, session: null },
      new Request('http://localhost/api/cases/bulk-ocr'),
      send,
    ),
  ).rejects.toThrow();
  await expect(
    recognizeBulkImage(
      context,
      new Request('http://localhost/api/cases/bulk-ocr', {
        method: 'POST',
        headers: { Origin: 'http://localhost:3000' },
      }),
      send,
    ),
  ).rejects.toThrow();
  expect(sent).toBe(false);
});
