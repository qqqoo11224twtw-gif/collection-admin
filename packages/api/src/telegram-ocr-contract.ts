import { z } from 'zod';
import { normalizeCounty } from './bulk-ocr-contract';

const fieldsSchema = z
  .strictObject({
    code: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .refine(
        (s) =>
          !/^ATM$/i.test(s) &&
          !/^[A-Z][12]\d{8}$/i.test(s) &&
          !/^\d{7,}$/.test(s),
      ),
    customerName: z
      .string()
      .trim()
      .regex(/^[\p{Script=Han}·・]{2,20}$/u),
    region: z.string().transform(normalizeCounty).refine(Boolean),
  })
  .refine((s) => s.code !== s.customerName);
export function confirmedOcrFields(raw: unknown) {
  return fieldsSchema.safeParse(raw);
}
export function parseOcrEdit(text: string) {
  const matched = text.match(
    /^\/ocr_edit(?:@[\w]+)?\s+([a-f0-9-]{36})\s+(.+)$/u,
  );
  if (!matched) return null;
  const values = matched[2].split('|').map((s) => s.trim());
  if (values.length !== 3) return null;
  const fields = confirmedOcrFields({
    code: values[0],
    customerName: values[1],
    region: values[2],
  });
  return fields.success ? { id: matched[1], fields: fields.data } : null;
}
export async function isOcrWebhookAuthorized(env: Env, request: Request) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest(
      'SHA-256',
      encoder.encode(env.TELEGRAM_WEBHOOK_SECRET),
    ),
    crypto.subtle.digest(
      'SHA-256',
      encoder.encode(
        request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '',
      ),
    ),
  ]);
  let different = 0;
  const left = new Uint8Array(a),
    right = new Uint8Array(b);
  for (let i = 0; i < left.length; i++) different |= left[i] ^ right[i];
  return different === 0;
}
