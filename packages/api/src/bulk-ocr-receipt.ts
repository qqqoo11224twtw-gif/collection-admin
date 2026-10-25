import { ORPCError } from '@orpc/server';
import type { z } from 'zod';
import type { ocrReviewSchema } from './bulk-ocr-contract';
import type { Context } from './context';

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
async function key(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
export async function issueOcrReceipt(
  context: Context,
  imageId: string,
  hash: string,
) {
  const secret = context.env.BETTER_AUTH_SECRET;
  if (!secret || !context.user) throw new ORPCError('FORBIDDEN');
  const payload = btoa(
    JSON.stringify({
      user: context.user.id,
      imageId,
      hash,
      expires: Date.now() + 3600000,
    }),
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    await key(secret),
    new TextEncoder().encode(`bulk-ocr-v1:${payload}`),
  );
  return `${payload}.${hex(signature)}`;
}
export async function verifyOcrReview(
  context: Context,
  review: z.infer<typeof ocrReviewSchema>,
) {
  try {
    if (!review.confirmed || !context.user || !context.env.BETTER_AUTH_SECRET)
      return false;
    const [payload, signature, extra] = review.receipt.split('.');
    if (extra || !/^[a-f0-9]{64}$/.test(signature ?? '')) return false;
    const valid = await crypto.subtle.verify(
      'HMAC',
      await key(context.env.BETTER_AUTH_SECRET),
      Uint8Array.from(signature.match(/../g) ?? [], (b) =>
        Number.parseInt(b, 16),
      ),
      new TextEncoder().encode(`bulk-ocr-v1:${payload}`),
    );
    if (!valid) return false;
    const data: unknown = JSON.parse(atob(payload));
    return (
      typeof data === 'object' &&
      data !== null &&
      'user' in data &&
      data.user === context.user.id &&
      'hash' in data &&
      data.hash === review.imageHash &&
      'expires' in data &&
      typeof data.expires === 'number' &&
      data.expires > Date.now()
    );
  } catch {
    return false;
  }
}
