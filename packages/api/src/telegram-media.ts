import { ORPCError } from '@orpc/server';
import { intakeMedia } from '@saasflare-dev/db';
import { eq } from 'drizzle-orm';
import { atomicCaseWrite } from './audit';
import { detectedImageType, sha256 } from './case-media-management';
import { privateCaseStorage } from './case-storage';
import type { Context } from './context';
import { requireIntake } from './intake-service';
import { telegramAudit, telegramFile } from './telegram-adapter';
import type { TelegramClient } from './telegram-client';
import { TelegramFailure } from './telegram-client';
import type { TelegramUpdate } from './telegram-contract';
export async function receiveTelegramMedia(
  context: Context,
  update: TelegramUpdate,
  intakeId: string,
  client: TelegramClient,
  leaseToken: string,
) {
  const updateId = String(update.update_id);
  const mediaId = `telegram-${updateId}`;
  const [existing] = await context.DB.select({ id: intakeMedia.id })
    .from(intakeMedia)
    .where(eq(intakeMedia.id, mediaId))
    .limit(1);
  if (existing) return existing.id;
  const file = telegramFile(update);
  if (!file) throw new TelegramFailure('UNSUPPORTED_MEDIA', false);
  if ((file.size ?? 0) > 5 * 1024 * 1024)
    throw new TelegramFailure('FILE_TOO_LARGE', false);
  const storage = privateCaseStorage(context.env);
  const key = `intakes/${intakeId}/${mediaId}`;
  // A private staged object survives a transient database failure, avoiding a second download.
  const staged = await storage.read(key);
  const bytes = staged ?? (await client.downloadFile(file.fileId)).bytes;
  const type = detectedImageType(new Uint8Array(bytes));
  if (!type || bytes.byteLength > 5 * 1024 * 1024 || !bytes.byteLength)
    throw new TelegramFailure('INVALID_IMAGE', false);
  const row = await requireIntake(context, intakeId, 'intake.create');
  if (
    !['received', 'processing', 'needs_review', 'failed'].includes(row.status)
  )
    throw new TelegramFailure('INTAKE_FINALIZED', false);
  const count = await context.env.DB.prepare(
    'SELECT count(*) AS n FROM intake_media WHERE intake_id=?',
  )
    .bind(intakeId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= 100) throw new TelegramFailure('MEDIA_LIMIT', false);
  const hash = await sha256(bytes);
  if (!staged) await storage.write(key, bytes, type);
  const now = Date.now();
  const filename =
    file.filename
      .split(/[\\/]/)
      .at(-1)
      ?.split('')
      .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
      .join('')
      .slice(0, 255) || 'image';
  try {
    await atomicCaseWrite(context, [
      context.env.DB.prepare(
        "UPDATE intake_items SET updated_at=?,version=version+1,write_token=? WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM telegram_updates WHERE id=? AND lease_token=? AND status='processing')",
      ).bind(now, leaseToken, intakeId, row.version, updateId, leaseToken),
      context.env.DB.prepare(
        'INSERT INTO intake_media(id,intake_id,storage_key,original_filename,media_type,sha256,sort_order,created_at,is_duplicate) SELECT ?,?,?,?,?,?,?,?,EXISTS(SELECT 1 FROM intake_media WHERE sha256=? UNION ALL SELECT 1 FROM case_media WHERE sha256=?) WHERE EXISTS(SELECT 1 FROM intake_items WHERE id=? AND write_token=?)',
      ).bind(
        mediaId,
        intakeId,
        key,
        filename,
        type,
        hash,
        update.message?.message_id ?? 0,
        now,
        hash,
        hash,
        intakeId,
        leaseToken,
      ),
      context.env.DB.prepare(
        'UPDATE telegram_updates SET media_id=? WHERE id=? AND lease_token=? AND EXISTS(SELECT 1 FROM intake_media WHERE id=?)',
      ).bind(mediaId, updateId, leaseToken, mediaId),
      telegramAudit(
        context,
        'telegram.media_received',
        updateId,
        { intakeId, mediaId },
        {
          sql: 'EXISTS(SELECT 1 FROM intake_media WHERE id=?)',
          values: [mediaId],
        },
      ),
    ]);
  } catch (error: unknown) {
    if (error instanceof ORPCError)
      throw new TelegramFailure('DATABASE_RETRY', true);
    throw error;
  }
  return mediaId;
}
