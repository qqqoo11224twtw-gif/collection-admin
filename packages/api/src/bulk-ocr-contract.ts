import { z } from 'zod';
import { REGIONS } from './regions';
export const ocrFieldSchema = z.object({
  value: z.string().nullable(),
  evidence: z.string().max(120),
  source: z.enum([
    'id_front',
    'name_label',
    'caption',
    'household',
    'region_label',
    'unknown',
  ]),
  legible: z.boolean(),
  ambiguous: z.boolean(),
});
export const visualOcrSchema = z.object({
  quality: z.enum(['readable', 'poor', 'multiple_people']),
  code: ocrFieldSchema,
  customerName: ocrFieldSchema,
  region: ocrFieldSchema,
});
export type VisualOcr = z.infer<typeof visualOcrSchema>;
export type OcrArea = { x: number; y: number }[];
export type OcrField = {
  value: string;
  evidence: string;
  area: OcrArea | null;
  status: 'cross_checked' | 'needs_review';
  reason: string;
};
export type BulkOcrResult = {
  imageId: string;
  imageHash: string;
  receipt: string;
  quality: VisualOcr['quality'];
  fields: Record<'code' | 'customerName' | 'region', OcrField>;
  requiresReview: true;
};
export const ocrReviewSchema = z.strictObject({
  receipt: z.string().max(1000),
  imageHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.boolean(),
});
export function normalizeCounty(value: string): string {
  const normalized = value.trim().replaceAll('臺', '台');
  if (REGIONS.includes(normalized as (typeof REGIONS)[number]))
    return normalized;
  const matches = REGIONS.filter((r) => r.slice(0, -1) === normalized);
  return matches.length === 1 ? matches[0] : '';
}
const compact = (s: string) => s.normalize('NFC').replace(/\s/g, '');
export function captionCode(caption: string, name: string): string {
  let rest = caption.replace(/\bATM\b/gi, ' ').replace(/代號\s*[:：]?/g, ' ');
  if (name) rest = rest.replaceAll(name, ' ');
  const candidates = rest
    .trim()
    .split(/[\s,，、|｜:：;；/]+/)
    .filter(Boolean);
  return candidates.length === 1 &&
    /^[\p{L}\p{N}_-]{1,30}$/u.test(candidates[0]) &&
    !/^ATM$/i.test(candidates[0])
    ? candidates[0]
    : '';
}
export function resolveOcrFields(
  raw: VisualOcr,
  text: string,
  blocks: { text: string; area: OcrArea }[] = [],
): BulkOcrResult['fields'] {
  const result = {} as BulkOcrResult['fields'];
  for (const fieldKey of ['customerName', 'code', 'region'] as const) {
    const field = raw[fieldKey];
    let value = field.value?.trim() ?? '';
    let valid =
      raw.quality === 'readable' &&
      field.legible &&
      !field.ambiguous &&
      !!value &&
      !!field.evidence &&
      compact(text).includes(compact(field.evidence)) &&
      compact(field.evidence).includes(compact(value));
    if (fieldKey === 'customerName')
      valid &&=
        ['id_front', 'name_label'].includes(field.source) &&
        /^[\p{Script=Han}·・]{2,20}$/u.test(value) &&
        !/[縣市區鄉鎮路街號]/u.test(value) &&
        value !== '姓名';
    if (fieldKey === 'code')
      valid &&=
        field.source === 'caption' &&
        value !== raw.customerName.value &&
        captionCode(field.evidence, result.customerName.value) === value &&
        !/^[A-Z][12]\d{8}$/i.test(value) &&
        !/^\d{7,}$/.test(value);
    if (fieldKey === 'region') {
      valid &&=
        ['household', 'region_label'].includes(field.source) &&
        !!normalizeCounty(value);
      value = normalizeCounty(value);
    }
    const block = valid
      ? blocks.find((b) => compact(b.text).includes(compact(field.value ?? '')))
      : undefined;
    result[fieldKey] = {
      value: valid ? value : '',
      evidence: valid ? (field.value ?? '') : '',
      area: block?.area ?? null,
      status: valid ? 'cross_checked' : 'needs_review',
      reason: valid
        ? '雙引擎文字相符，仍須人工核對原圖'
        : raw.quality !== 'readable'
          ? '圖片品質不足或包含多位人員，請重新上傳或人工填寫'
          : '缺少明確證據、辨識不一致或存在歧義，請人工填寫',
    };
  }
  return result;
}
