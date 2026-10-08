import { ORPCError } from '@orpc/server';
import { intakeMedia } from '@saasflare-dev/db';
import { and, eq } from 'drizzle-orm';
import { atomicCaseWrite } from './audit';
import {
  detectedImageType,
  limitedFormData,
  sha256,
} from './case-media-management';
import { privateCaseStorage } from './case-storage';
import type { Context } from './context';
import { intakeAudit, requireIntake } from './intake-service';
export async function uploadIntakeImages(
  context: Context,
  intakeId: string,
  request: Request,
) {
  const row = await requireIntake(context, intakeId, 'intake.create');
  if (
    !['received', 'processing', 'needs_review', 'failed'].includes(row.status)
  )
    throw new ORPCError('CONFLICT');
  const origin = request.headers.get('Origin');
  if (
    !origin ||
    !(context.env.CORS_ORIGIN ?? '')
      .split(',')
      .map((v) => v.trim())
      .includes(origin)
  )
    throw new ORPCError('FORBIDDEN');
  const form = await limitedFormData(request);
  if ([...form.keys()].some((k) => k !== 'files' && k !== 'expectedVersion'))
    throw new ORPCError('BAD_REQUEST');
  const raw = form.get('expectedVersion');
  const version =
    typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : -1;
  if (!Number.isSafeInteger(version) || version !== row.version)
    throw new ORPCError('CONFLICT');
  const files = form.getAll('files');
  if (!files.length || files.length > 5) throw new ORPCError('BAD_REQUEST');
  const count = await context.env.DB.prepare(
    'SELECT count(*) AS n,COALESCE(MAX(sort_order),0) AS last FROM intake_media WHERE intake_id=?',
  )
    .bind(intakeId)
    .first<{ n: number; last: number }>();
  if ((count?.n ?? 0) + files.length > 100) throw new ORPCError('BAD_REQUEST');
  const items: {
    id: string;
    key: string;
    bytes: ArrayBuffer;
    type: 'image/png' | 'image/jpeg' | 'image/webp';
    filename: string;
    hash: string;
    duplicate: boolean;
    order: number;
  }[] = [];
  const hashes = new Set<string>();
  for (const [index, value] of files.entries()) {
    if (typeof value === 'string') throw new ORPCError('BAD_REQUEST');
    if (!value.size || value.size > 5 * 1024 * 1024)
      throw new ORPCError('PAYLOAD_TOO_LARGE');
    const bytes = await value.arrayBuffer();
    const type = detectedImageType(new Uint8Array(bytes));
    if (!type || type !== value.type) throw new ORPCError('BAD_REQUEST');
    const filename = value.name
      .split(/[\\/]/)
      .at(-1)
      ?.split('')
      .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
      .join('')
      .trim();
    if (!filename || filename.length > 255) throw new ORPCError('BAD_REQUEST');
    const hash = await sha256(bytes);
    const duplicate =
      hashes.has(hash) ||
      !!(await context.env.DB.prepare(
        'SELECT id FROM intake_media WHERE sha256=? UNION ALL SELECT id FROM case_media WHERE sha256=? LIMIT 1',
      )
        .bind(hash, hash)
        .first());
    hashes.add(hash);
    const id = crypto.randomUUID();
    items.push({
      id,
      key: `intakes/${intakeId}/${id}`,
      bytes,
      type,
      filename,
      hash,
      duplicate,
      order: (count?.last ?? 0) + index + 1,
    });
  }
  const token = crypto.randomUUID();
  const now = Date.now();
  const storage = privateCaseStorage(context.env);
  const written: string[] = [];
  try {
    for (const item of items) {
      await storage.write(item.key, item.bytes, item.type);
      written.push(item.key);
    }
    await atomicCaseWrite(context, [
      context.env.DB.prepare(
        "UPDATE intake_items SET updated_at=?,version=version+1,write_token=? WHERE id=? AND version=? AND status IN ('received','processing','needs_review','failed')",
      ).bind(now, token, intakeId, version),
      ...items.map((item) =>
        context.env.DB.prepare(
          'INSERT INTO intake_media(id,intake_id,storage_key,original_filename,media_type,sha256,sort_order,created_at,is_duplicate) SELECT ?,?,?,?,?,?,?,?,MAX(?,EXISTS(SELECT 1 FROM intake_media WHERE sha256=? UNION ALL SELECT 1 FROM case_media WHERE sha256=?)) WHERE EXISTS(SELECT 1 FROM intake_items WHERE id=? AND write_token=?)',
        ).bind(
          item.id,
          intakeId,
          item.key,
          item.filename,
          item.type,
          item.hash,
          item.order,
          now,
          Number(item.duplicate),
          item.hash,
          item.hash,
          intakeId,
          token,
        ),
      ),
      intakeAudit(
        context,
        intakeId,
        'intake.media_uploaded',
        { mediaIds: items.map((i) => i.id), count: items.length },
        token,
      ),
      context.env.DB.prepare(
        "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,'intake.duplicate_detected','intake',?,?,? WHERE EXISTS(SELECT 1 FROM intake_items WHERE id=? AND write_token=?) AND EXISTS(SELECT 1 FROM intake_media WHERE id IN (SELECT value FROM json_each(?)) AND is_duplicate=1)",
      ).bind(
        crypto.randomUUID(),
        context.user?.id,
        intakeId,
        JSON.stringify({ mediaIds: items.map((i) => i.id) }),
        now,
        intakeId,
        token,
        JSON.stringify(items.map((i) => i.id)),
      ),
    ]);
  } catch (error: unknown) {
    await Promise.allSettled(written.map((key) => storage.delete(key)));
    throw error;
  }
  const duplicates = await context.DB.select({ id: intakeMedia.id })
    .from(intakeMedia)
    .where(
      and(
        eq(intakeMedia.intakeId, intakeId),
        eq(intakeMedia.isDuplicate, true),
      ),
    );
  return {
    ids: items.map((i) => i.id),
    duplicates: duplicates
      .filter((m) => items.some((i) => i.id === m.id))
      .map((m) => m.id),
  };
}
export async function intakeImageResponse(
  context: Context,
  intakeId: string,
  mediaId: string,
): Promise<Response> {
  const headers = {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  try {
    await requireIntake(context, intakeId);
    const [m] = await context.DB.select()
      .from(intakeMedia)
      .where(
        and(eq(intakeMedia.intakeId, intakeId), eq(intakeMedia.id, mediaId)),
      )
      .limit(1);
    if (!m) throw new ORPCError('NOT_FOUND');
    const bytes = await privateCaseStorage(context.env).read(m.storageKey);
    if (!bytes || (await sha256(bytes)) !== m.sha256)
      throw new ORPCError('NOT_FOUND');
    return new Response(bytes, {
      headers: { ...headers, 'Content-Type': m.mediaType },
    });
  } catch (error: unknown) {
    return Response.json(
      { error: error instanceof ORPCError ? error.code : 'IMAGE_UNAVAILABLE' },
      { status: error instanceof ORPCError ? error.status : 503, headers },
    );
  }
}
