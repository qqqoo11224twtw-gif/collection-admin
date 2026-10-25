import { ORPCError } from '@orpc/server';
import { z } from 'zod';
import { authMode } from './auth';
import type { BulkOcrResult } from './bulk-ocr-contract';
import { recognizeOcrBytes } from './bulk-ocr-engine';
import { issueOcrReceipt } from './bulk-ocr-receipt';
import { detectedImageType } from './case-media-management';
import type { Context } from './context';
import { requirePermission } from './permissions';

const MAX_BYTES = 5 * 1024 * 1024;
export async function recognizeBulkImage(
  context: Context,
  request: Request,
  send: typeof fetch = fetch,
): Promise<BulkOcrResult> {
  if (authMode() === 'disabled' || !context.user || !context.session)
    throw new ORPCError('UNAUTHORIZED');
  requirePermission(context, 'case.create');
  requirePermission(context, 'media.upload');
  requirePermission(context, 'media.view');
  const origin = request.headers.get('Origin');
  if (
    !origin ||
    !(context.env.CORS_ORIGIN ?? '')
      .split(',')
      .map((s) => s.trim())
      .includes(origin)
  )
    throw new ORPCError('FORBIDDEN');
  if (
    context.env.BULK_OCR_ENABLED !== 'true' ||
    context.env.BULK_OCR_PRIVACY_APPROVED !== 'true' ||
    !context.env.GOOGLE_VISION_API_KEY ||
    !context.env.OPENAI_API_KEY ||
    !context.env.BULK_OCR_MODEL
  )
    throw new ORPCError('SERVICE_UNAVAILABLE', {
      status: 503,
      message: '圖片辨識尚未啟用；需由管理者完成供應商與隱私設定。',
    });
  if (request.headers.get('X-OCR-Consent') !== 'google-openai-v1')
    throw new ORPCError('FORBIDDEN');
  const imageId = z.string().uuid().parse(request.headers.get('X-Image-Id'));
  const bucket = Math.floor(Date.now() / 60000);
  const quota = await context.env.DB.prepare(
    'INSERT INTO rate_limit(id,key,count,last_request) VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN last_request<? THEN 1 ELSE count+1 END,last_request=excluded.last_request WHERE last_request<? OR count<20 RETURNING count',
  )
    .bind(
      `bulk-ocr:${context.user.id}`,
      `bulk-ocr:${context.user.id}`,
      bucket * 60000,
      bucket * 60000,
      bucket * 60000,
    )
    .first();
  if (!quota)
    throw new ORPCError('TOO_MANY_REQUESTS', {
      status: 429,
      message: '每位使用者每分鐘最多辨識 20 張，請稍後重試。',
    });
  // Fixed-size raw upload bounds memory even when Content-Length is absent.
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES)
    throw new ORPCError('PAYLOAD_TOO_LARGE', { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) throw new ORPCError('BAD_REQUEST');
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_BYTES) {
      await reader.cancel();
      throw new ORPCError('PAYLOAD_TOO_LARGE', { status: 413 });
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let cursor = 0;
  for (const part of parts) {
    bytes.set(part, cursor);
    cursor += part.length;
  }
  const mediaType = detectedImageType(bytes);
  if (!mediaType || mediaType !== request.headers.get('Content-Type'))
    throw new ORPCError('BAD_REQUEST', {
      message: '請上傳有效 JPG、PNG 或 WEBP 圖片。',
    });
  const extracted = await recognizeOcrBytes(
    {
      GOOGLE_VISION_API_KEY: context.env.GOOGLE_VISION_API_KEY,
      OPENAI_API_KEY: context.env.OPENAI_API_KEY,
      BULK_OCR_MODEL: context.env.BULK_OCR_MODEL,
    },
    bytes,
    mediaType,
    send,
  );
  return {
    ...extracted,
    imageId,
    receipt: await issueOcrReceipt(context, imageId, extracted.imageHash),
    requiresReview: true,
  };
}
