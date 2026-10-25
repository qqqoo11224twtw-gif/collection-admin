import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captionCode,
  normalizeCounty,
  resolveOcrFields,
  type VisualOcr,
} from '../src/bulk-ocr-contract';

const field = (
  value: string | null,
  source: VisualOcr['code']['source'],
  evidence = value ?? '',
) => ({ value, source, evidence, legible: true, ambiguous: false });
const raw = (caption = '莊佩璇 菲菲 ATM'): VisualOcr => ({
  quality: 'readable',
  code: field('菲菲', 'caption', caption),
  customerName: field('莊佩璇', 'id_front'),
  region: field('彰化縣', 'household'),
});
for (const caption of [
  '莊佩璇 菲菲 ATM',
  '菲菲 莊佩璇 ATM',
  '莊佩璇 菲菲',
  '菲菲 莊佩璇',
  '菲菲 ATM',
  '菲菲',
])
  test(`caption ${caption}`, () => {
    assert.equal(captionCode(caption, '莊佩璇'), '菲菲');
    const fields = resolveOcrFields(raw(caption), `莊佩璇 彰化縣 ${caption}`);
    assert.equal(fields.code.value, '菲菲');
    assert.equal(fields.customerName.value, '莊佩璇');
  });
test('all counties, ambiguous short names and variants', () => {
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
    assert.equal(normalizeCounty(county), county);
  assert.equal(normalizeCounty('臺中市'), '台中市');
  assert.equal(normalizeCounty('彰化'), '彰化縣');
  assert.equal(normalizeCounty('嘉義'), '');
  assert.equal(normalizeCounty('新竹'), '');
});
test('poor or multi-person image abstains', () => {
  for (const quality of ['poor', 'multiple_people'] as const)
    assert.ok(
      Object.values(
        resolveOcrFields({ ...raw(), quality }, '莊佩璇 菲菲 ATM 彰化縣'),
      ).every((f) => !f.value),
    );
});
test('uncertain Chinese glyph and independent OCR disagreement abstain', () => {
  const r = raw();
  r.customerName.ambiguous = true;
  assert.equal(
    resolveOcrFields(r, '莊佩璇 菲菲 ATM 彰化縣').customerName.value,
    '',
  );
  assert.equal(
    resolveOcrFields(raw(), '莊佩萱 菲菲 ATM 彰化縣').customerName.value,
    '',
  );
});
test('ID-only formal name, absent code and household vs current address', () => {
  const r = raw();
  r.code = field(null, 'unknown');
  const f = resolveOcrFields(r, '莊佩璇 戶籍彰化縣 現居高雄市');
  assert.equal(f.code.value, '');
  assert.equal(f.customerName.value, '莊佩璇');
  assert.equal(f.region.value, '彰化縣');
});
test('reject multiple code candidates, ATM, phone and ID', () => {
  assert.equal(captionCode('菲菲 小美 ATM', ''), '');
  for (const code of ['ATM', '0912345678', 'A123456789']) {
    const r = raw(code);
    r.code.value = code;
    assert.equal(resolveOcrFields(r, `莊佩璇 彰化縣 ${code}`).code.value, '');
  }
});
test('no unlabeled name, no conflicting household county', () => {
  const r = raw();
  r.customerName.source = 'caption';
  r.region.ambiguous = true;
  const f = resolveOcrFields(r, '莊佩璇 菲菲 ATM 彰化縣 高雄市');
  assert.equal(f.customerName.value, '');
  assert.equal(f.region.value, '');
});
test('only minimal evidence retained and bounding region tied to field', () => {
  const f = resolveOcrFields(
    raw(),
    '莊佩璇 菲菲 ATM 彰化縣 A123456789 完整街道地址',
    [{ text: '莊佩璇', area: [{ x: 10, y: 20 }] }],
  );
  assert.deepEqual(f.customerName.area, [{ x: 10, y: 20 }]);
  assert.ok(!JSON.stringify(f).includes('A123456789'));
  assert.ok(!JSON.stringify(f).includes('完整街道地址'));
});

test('signed review rejects missing confirmation, tampering, wrong user and expired receipts', async () => {
  const { issueOcrReceipt, verifyOcrReview } = await import(
    '../src/bulk-ocr-receipt'
  );
  const context = {
    user: { id: 'fictional-user' },
    env: { BETTER_AUTH_SECRET: 'test-local-only' },
  } as import('../src/context').Context;
  const hash = 'a'.repeat(64);
  const receipt = await issueOcrReceipt(context, crypto.randomUUID(), hash);
  assert.equal(
    await verifyOcrReview(context, {
      receipt,
      imageHash: hash,
      confirmed: true,
    }),
    true,
  );
  assert.equal(
    await verifyOcrReview(context, {
      receipt,
      imageHash: hash,
      confirmed: false,
    }),
    false,
  );
  assert.equal(
    await verifyOcrReview(context, {
      receipt: `${receipt}x`,
      imageHash: hash,
      confirmed: true,
    }),
    false,
  );
  assert.equal(
    await verifyOcrReview(
      { ...context, user: { ...context.user, id: 'other-user' } },
      { receipt, imageHash: hash, confirmed: true },
    ),
    false,
  );
  assert.equal(
    await verifyOcrReview(context, {
      receipt,
      imageHash: 'b'.repeat(64),
      confirmed: true,
    }),
    false,
  );
});

test('expired review receipt cannot authorize a write', async () => {
  const { issueOcrReceipt, verifyOcrReview } = await import(
    '../src/bulk-ocr-receipt'
  );
  const context = {
    user: { id: 'fictional-user' },
    env: { BETTER_AUTH_SECRET: 'test-local-only' },
  } as import('../src/context').Context;
  const clock = Date.now;
  let receipt: string;
  try {
    Date.now = () => clock() - 7200000;
    receipt = await issueOcrReceipt(
      context,
      crypto.randomUUID(),
      'a'.repeat(64),
    );
  } finally {
    Date.now = clock;
  }
  assert.equal(
    await verifyOcrReview(context, {
      receipt,
      imageHash: 'a'.repeat(64),
      confirmed: true,
    }),
    false,
  );
});
