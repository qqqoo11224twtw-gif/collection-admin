import { intakeMedia } from '@saasflare-dev/db';
import { and, eq, isNull } from 'drizzle-orm';
import { sha256 } from './case-media-management';
import { privateCaseStorage } from './case-storage';
import type { Context } from './context';
export async function prepareIntakePromotion(
  context: Context,
  intakeId: string,
  caseId: string,
  token: string,
  newCase = false,
) {
  const media = await context.DB.select()
    .from(intakeMedia)
    .where(
      and(eq(intakeMedia.intakeId, intakeId), isNull(intakeMedia.promotedAt)),
    );
  const storage = privateCaseStorage(context.env);
  const keys: string[] = [];
  const now = Date.now();
  const position = newCase
    ? 0
    : ((
        await context.env.DB.prepare(
          'SELECT COALESCE(MAX(sort_order),0) AS n FROM case_media WHERE case_id=?',
        )
          .bind(caseId)
          .first<{ n: number }>()
      )?.n ?? 0);
  const total = newCase
    ? 0
    : ((
        await context.env.DB.prepare(
          'SELECT count(*) AS n FROM case_media WHERE case_id=?',
        )
          .bind(caseId)
          .first<{ n: number }>()
      )?.n ?? 0);
  if (total + media.length > 100)
    throw new Error('A case can hold at most 100 images.');
  const statements: D1PreparedStatement[] = [];
  try {
    for (const [index, m] of media.entries()) {
      const bytes = await storage.read(m.storageKey);
      if (!bytes || (await sha256(bytes)) !== m.sha256)
        throw new Error('Intake image integrity check failed.');
      const id = crypto.randomUUID();
      const key = `cases/${caseId}/${id}`;
      await storage.write(key, bytes, m.mediaType);
      keys.push(key);
      statements.push(
        context.env.DB.prepare(
          'INSERT INTO case_media(id,case_id,storage_key,original_filename,media_type,sort_order,sha256,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM intake_items WHERE id=? AND write_token=? AND matched_case_id=?)',
        ).bind(
          id,
          caseId,
          key,
          m.originalFilename,
          m.mediaType,
          position + index + 1,
          m.sha256,
          now,
          intakeId,
          token,
          caseId,
        ),
      );
      statements.push(
        context.env.DB.prepare(
          'UPDATE intake_media SET promoted_case_media_id=?,promoted_at=? WHERE id=? AND intake_id=? AND promoted_at IS NULL AND EXISTS(SELECT 1 FROM intake_items WHERE id=? AND write_token=?)',
        ).bind(id, now, m.id, intakeId, intakeId, token),
      );
    }
  } catch (error: unknown) {
    await Promise.allSettled(keys.map((key) => storage.delete(key)));
    throw error;
  }
  return {
    statements,
    count: media.length,
    cleanup: () => Promise.allSettled(keys.map((key) => storage.delete(key))),
  };
}
