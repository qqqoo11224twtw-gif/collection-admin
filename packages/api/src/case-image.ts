import { ORPCError } from '@orpc/server';
import { caseMedia } from '@saasflare-dev/db';
import { and, eq } from 'drizzle-orm';
import { authMode } from './auth';
import { requireCaseAccess } from './case-access';
import { privateCaseStorage } from './case-storage';
import type { Context } from './context';
import { systemLog } from './system-log';

export async function caseImageResponse(
  context: Context,
  caseId: string,
  mediaId: string,
): Promise<Response> {
  const headers = {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  try {
    if (authMode() === 'disabled' || !context.user || !context.session)
      throw new ORPCError('UNAUTHORIZED');
    await requireCaseAccess(context, caseId, 'media.view');
    const [media] = await context.DB.select()
      .from(caseMedia)
      .where(and(eq(caseMedia.id, mediaId), eq(caseMedia.caseId, caseId)))
      .limit(1);
    if (!media) throw new ORPCError('NOT_FOUND');
    const bytes = await privateCaseStorage(context.env).read(media.storageKey);
    if (!bytes) throw new ORPCError('NOT_FOUND');
    // Defend against storage corruption; the DB hash identifies the exact image.
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    if (digest !== media.sha256) throw new Error('SHA_MISMATCH');
    return new Response(bytes, {
      headers: { ...headers, 'Content-Type': media.mediaType },
    });
  } catch (error: unknown) {
    await systemLog(context.env.DB, {
      category: 'storage',
      event:
        error instanceof ORPCError ? 'MEDIA_READ_DENIED' : 'MEDIA_READ_FAILED',
      level: 'warning',
      status: 'failed',
      relatedUserId: context.user?.id,
      errorCode:
        error instanceof ORPCError
          ? 'PERMISSION_DENIED'
          : error instanceof Error && error.message === 'SHA_MISMATCH'
            ? 'SHA_MISMATCH'
            : 'R2_READ_FAILED',
    });
    if (error instanceof ORPCError) {
      return Response.json(
        { error: error.code },
        { status: error.status, headers },
      );
    }
    return Response.json(
      { error: 'IMAGE_UNAVAILABLE' },
      { status: 503, headers },
    );
  }
}
