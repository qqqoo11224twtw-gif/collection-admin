import { ORPCError } from '@orpc/server';
import { caseMedia } from '@saasflare-dev/db';
import { and, eq } from 'drizzle-orm';
import { atomicCaseWrite, auditStatement } from './audit';
import { requireCaseAccess } from './case-access';
import { mediaDeleteSchema, mediaOrderSchema } from './case-contract';
import { privateCaseStorage } from './case-storage';
import type { Context } from './context';
import { protectedProcedure } from './middleware';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BODY_BYTES = 26 * 1024 * 1024;
export function detectedImageType(
  bytes: Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (
    bytes.length >= 45 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => bytes[index] === byte,
    ) &&
    String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR'
  ) {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = data.getUint32(16);
    const height = data.getUint32(20);
    return width > 0 && height > 0 && width * height <= 40000000
      ? 'image/png'
      : null;
  }
  if (
    bytes.length > 16 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  )
    return 'image/jpeg';
  if (
    bytes.length > 20 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      4,
      true,
    ) ===
      bytes.length - 8
  )
    return 'image/webp';
  return null;
}
export async function sha256(bytes: ArrayBuffer) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function limitedFormData(request: Request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES)
    throw new ORPCError('PAYLOAD_TOO_LARGE', { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) throw new ORPCError('BAD_REQUEST');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ORPCError('PAYLOAD_TOO_LARGE', { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Response(bytes, {
      headers: { 'Content-Type': request.headers.get('Content-Type') ?? '' },
    }).formData();
  } catch {
    throw new ORPCError('BAD_REQUEST', {
      message: 'Invalid multipart upload.',
    });
  }
}
export async function uploadCaseImages(
  context: Context,
  caseId: string,
  request: Request,
) {
  // Authorization and CSRF origin validation happen before consuming the body.
  const record = await requireCaseAccess(context, caseId, 'media.upload');
  const origin = request.headers.get('Origin');
  if (
    !origin ||
    !(context.env.CORS_ORIGIN ?? '')
      .split(',')
      .map((value) => value.trim())
      .includes(origin)
  )
    throw new ORPCError('FORBIDDEN');
  const form = await limitedFormData(request);
  if (
    [...form.keys()].some(
      (key) =>
        key !== 'files' && key !== 'expectedVersion' && key !== 'uploadKey',
    )
  )
    throw new ORPCError('BAD_REQUEST');
  const versionValue = form.get('expectedVersion');
  const expectedVersion =
    typeof versionValue === 'string' && /^\d+$/.test(versionValue)
      ? Number(versionValue)
      : -1;
  const uploadKey = form.get('uploadKey');
  if (
    uploadKey !== null &&
    (typeof uploadKey !== 'string' || !/^[a-f0-9-]{36}$/.test(uploadKey))
  )
    throw new ORPCError('BAD_REQUEST');
  if (uploadKey) {
    const prior = await context.env.DB.prepare(
      "SELECT metadata FROM audit_logs WHERE entity_id=? AND action='media.uploaded' AND json_extract(metadata,'$.uploadKey')=? LIMIT 1",
    )
      .bind(caseId, uploadKey)
      .first<{ metadata: string }>();
    if (prior) {
      const saved = JSON.parse(prior.metadata) as {
        mediaIds: string[];
        fingerprint: string;
      };
      const values = form.getAll('files');
      if (!values.length || values.length > 5)
        throw new ORPCError('BAD_REQUEST');
      const hashes = await Promise.all(
        values.map(async (value) => {
          if (typeof value === 'string') throw new ORPCError('BAD_REQUEST');
          return sha256(await value.arrayBuffer());
        }),
      );
      if (saved.fingerprint !== hashes.join(':'))
        throw new ORPCError('CONFLICT');
      const present = await context.env.DB.prepare(
        `SELECT count(*) count FROM case_media WHERE case_id=? AND id IN (${saved.mediaIds.map(() => '?').join(',')})`,
      )
        .bind(caseId, ...saved.mediaIds)
        .first<{ count: number }>();
      if (present?.count !== saved.mediaIds.length)
        throw new ORPCError('CONFLICT', {
          message: '圖片已被移除，請重新選擇上傳。',
        });
      return { ids: saved.mediaIds, version: record.version };
    }
  }
  if (
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion !== record.version
  )
    throw new ORPCError('CONFLICT');
  const files = form.getAll('files');
  if (
    !files.length ||
    files.length > 5 ||
    files.some((file) => typeof file === 'string')
  )
    throw new ORPCError('BAD_REQUEST', {
      message: 'Choose one to five images.',
    });
  const countRow = await context.env.DB.prepare(
    'SELECT COUNT(*) AS count, COALESCE(MAX(sort_order),0) AS last_order FROM case_media WHERE case_id=?',
  )
    .bind(caseId)
    .first<{ count: number; last_order: number }>();
  if ((countRow?.count ?? 0) + files.length > 100)
    throw new ORPCError('BAD_REQUEST', {
      message: 'A case can hold at most 100 images.',
    });
  const items = [];
  for (const [index, value] of files.entries()) {
    if (typeof value === 'string') throw new ORPCError('BAD_REQUEST');
    if (!value.size || value.size > MAX_FILE_BYTES)
      throw new ORPCError('PAYLOAD_TOO_LARGE', {
        status: 413,
        message: 'Each image must be at most 5 MiB.',
      });
    const bytes = await value.arrayBuffer();
    const mediaType = detectedImageType(new Uint8Array(bytes));
    if (!mediaType || mediaType !== value.type)
      throw new ORPCError('BAD_REQUEST', {
        message: 'Only matching PNG, JPEG and WebP images are allowed.',
      });
    const filename = value.name
      .split(/[\\/]/)
      .at(-1)
      ?.split('')
      .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
      .join('')
      .trim();
    if (!filename || filename.length > 255)
      throw new ORPCError('BAD_REQUEST', { message: 'Invalid filename.' });
    const id = crypto.randomUUID();
    items.push({
      id,
      bytes,
      mediaType,
      filename,
      storageKey: `cases/${caseId}/${id}`,
      hash: await sha256(bytes),
      sortOrder: (countRow?.last_order ?? 0) + index + 1,
    });
  }
  const storage = privateCaseStorage(context.env);
  const written: string[] = [];
  const token = crypto.randomUUID();
  const now = Date.now();
  try {
    for (const item of items) {
      await storage.write(item.storageKey, item.bytes, item.mediaType);
      written.push(item.storageKey);
    }
    const first = context.env.DB.prepare(
      'UPDATE cases SET updated_at=?,version=version+1,write_token=? WHERE id=? AND version=?',
    ).bind(now, token, caseId, expectedVersion);
    const inserts = items.map((item) =>
      context.env.DB.prepare(
        'INSERT INTO case_media (id,case_id,storage_key,original_filename,media_type,sort_order,sha256,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM cases WHERE id=? AND write_token=?)',
      ).bind(
        item.id,
        caseId,
        item.storageKey,
        item.filename,
        item.mediaType,
        item.sortOrder,
        item.hash,
        now,
        caseId,
        token,
      ),
    );
    await atomicCaseWrite(context, [
      first,
      ...inserts,
      auditStatement(
        context,
        'media.uploaded',
        'case',
        caseId,
        {
          mediaIds: items.map((item) => item.id),
          count: items.length,
          version: expectedVersion + 1,
          uploadKey: uploadKey ?? null,
          fingerprint: items.map((item) => item.hash).join(':'),
        },
        token,
      ),
    ]);
  } catch (error: unknown) {
    // Compensate for the object store not sharing the D1 transaction.
    await Promise.allSettled(written.map((key) => storage.delete(key)));
    if (error instanceof ORPCError) throw error;
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      message: 'Images could not be saved.',
    });
  }
  return { ids: items.map((item) => item.id), version: expectedVersion + 1 };
}

export const caseMediaManagementApi = {
  deleteMedia: protectedProcedure
    .input(mediaDeleteSchema)
    .handler(async ({ context, input }) => {
      await requireCaseAccess(context, input.caseId, 'media.delete');
      const [media] = await context.DB.select()
        .from(caseMedia)
        .where(
          and(
            eq(caseMedia.caseId, input.caseId),
            eq(caseMedia.id, input.mediaId),
          ),
        )
        .limit(1);
      if (!media) throw new ORPCError('NOT_FOUND');
      const token = crypto.randomUUID();
      await atomicCaseWrite(context, [
        context.env.DB.prepare(
          'UPDATE cases SET updated_at=?,version=version+1,write_token=? WHERE id=? AND version=?',
        ).bind(Date.now(), token, input.caseId, input.expectedVersion),
        context.env.DB.prepare(
          'DELETE FROM case_media WHERE id=? AND case_id=? AND EXISTS (SELECT 1 FROM cases WHERE id=? AND write_token=?)',
        ).bind(media.id, input.caseId, input.caseId, token),
        auditStatement(
          context,
          'media.deleted',
          'case',
          input.caseId,
          { mediaIds: [media.id], version: input.expectedVersion + 1 },
          token,
        ),
      ]);
      // Metadata revocation is authoritative even if storage cleanup fails.
      let cleanupPending = false;
      try {
        await privateCaseStorage(context.env).delete(media.storageKey);
      } catch {
        cleanupPending = true;
      }
      return { version: input.expectedVersion + 1, cleanupPending };
    }),
  reorderMedia: protectedProcedure
    .input(mediaOrderSchema)
    .handler(async ({ context, input }) => {
      await requireCaseAccess(context, input.caseId, 'media.upload');
      const existing = await context.DB.select({ id: caseMedia.id })
        .from(caseMedia)
        .where(eq(caseMedia.caseId, input.caseId));
      if (
        new Set(input.ids).size !== input.ids.length ||
        existing.length !== input.ids.length ||
        existing.some((media) => !input.ids.includes(media.id))
      )
        throw new ORPCError('BAD_REQUEST', {
          message: 'Supply each image in this case exactly once.',
        });
      const token = crypto.randomUUID();
      await atomicCaseWrite(context, [
        context.env.DB.prepare(
          'UPDATE cases SET updated_at=?,version=version+1,write_token=? WHERE id=? AND version=?',
        ).bind(Date.now(), token, input.caseId, input.expectedVersion),
        ...input.ids.map((id, index) =>
          context.env.DB.prepare(
            'UPDATE case_media SET sort_order=? WHERE id=? AND case_id=? AND EXISTS (SELECT 1 FROM cases WHERE id=? AND write_token=?)',
          ).bind(index + 1, id, input.caseId, input.caseId, token),
        ),
        auditStatement(
          context,
          'media.reordered',
          'case',
          input.caseId,
          { mediaIds: input.ids, version: input.expectedVersion + 1 },
          token,
        ),
      ]);
      return { version: input.expectedVersion + 1 };
    }),
};
