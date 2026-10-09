import { z } from 'zod';
import { renderAssignment } from './bulk-assignment';
import { privateCaseStorage } from './case-storage';
import type { Context } from './context';
import { type TelegramClient, TelegramFailure } from './telegram-client';

const stateSchema = z.strictObject({
  chatId: z.string(),
  topicId: z.number().nullable(),
  caption: z.string().max(1024),
  media: z
    .array(
      z.strictObject({
        id: z.string(),
        storage_key: z.string(),
        original_filename: z.string(),
        media_type: z.string(),
        sha256: z.string(),
      }),
    )
    .max(100),
  done: z.array(z.array(z.string())),
});
// Durable per-album checkpoints allow safe 429 retries without re-sending previous albums.
export async function sendAssignmentMedia(
  context: Context,
  client: TelegramClient,
  job: {
    id: string;
    assignmentId: string | null;
    dispatchState: string | null;
  },
  target: { chatId: string; topicId: number | null },
  token: string,
) {
  const row = await context.env.DB.prepare(
    "SELECT c.id,c.case_no,c.code,c.customer_name,c.address,c.amount_due,c.region FROM cases c JOIN assignments a ON a.case_id=c.id WHERE a.id=? AND a.record_type='assignment' AND a.unassigned_at IS NULL AND c.voided_at IS NULL",
  )
    .bind(job.assignmentId)
    .first<{
      id: string;
      case_no: string;
      code: string;
      customer_name: string;
      address: string;
      amount_due: number;
      region: string | null;
    }>();
  if (!row) throw new TelegramFailure('ASSIGNMENT_CHANGED', false);
  let state: z.infer<typeof stateSchema>;
  if (job.dispatchState)
    state = stateSchema.parse(JSON.parse(job.dispatchState));
  else {
    const media = await context.env.DB.prepare(
      'SELECT id,storage_key,original_filename,media_type,sha256 FROM case_media WHERE case_id=? ORDER BY sort_order,id',
    )
      .bind(row.id)
      .all<z.infer<typeof stateSchema>['media'][number]>();
    state = stateSchema.parse({
      chatId: target.chatId,
      topicId: target.topicId,
      caption: renderAssignment({
        caseNo: row.case_no,
        code: row.code,
        customerName: row.customer_name,
        address: row.address,
        amountDue: row.amount_due,
        region: row.region,
      }),
      media: media.results,
      done: [],
    });
  }
  if (
    state.done.length &&
    (state.chatId !== target.chatId || state.topicId !== target.topicId)
  )
    throw new TelegramFailure('ROUTE_CHANGED', false);
  if (!state.done.length) {
    state.chatId = target.chatId;
    state.topicId = target.topicId;
  }
  const save = async () => {
    const result = await context.env.DB.prepare(
      "UPDATE telegram_outbound_jobs SET dispatch_state=? WHERE id=? AND lease_token=? AND status='sending'",
    )
      .bind(JSON.stringify(state), job.id, token)
      .run();
    if (result.meta.changes !== 1)
      throw new TelegramFailure('DELIVERY_UNKNOWN', false, true);
  };
  await save();
  if (!state.media.length)
    return await client.sendMessage({ ...target, text: state.caption });
  if (!client.sendPhoto || !client.sendMediaGroup)
    throw new TelegramFailure('MEDIA_TRANSPORT_UNAVAILABLE', false);
  const storage = privateCaseStorage(context.env),
    chunks = [];
  for (let i = 0; i < state.media.length; i += 10)
    chunks.push(state.media.slice(i, i + 10));
  for (let part = state.done.length; part < chunks.length; part++) {
    const photos = [];
    for (const item of chunks[part]) {
      let bytes: ArrayBuffer | null;
      try {
        bytes = await storage.read(item.storage_key);
      } catch {
        throw new TelegramFailure('DISPATCH_IMAGE_UNAVAILABLE', true);
      }
      if (!bytes)
        throw new TelegramFailure('DISPATCH_IMAGE_UNAVAILABLE', false);
      const sha = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (v) => v.toString(16).padStart(2, '0'),
      ).join('');
      if (sha !== item.sha256) throw new TelegramFailure('SHA_MISMATCH', false);
      photos.push({
        ...target,
        caption: photos.length ? '' : state.caption,
        bytes,
        mediaType: item.media_type,
        filename: item.original_filename,
      });
    }
    const sent =
      photos.length === 1
        ? [await client.sendPhoto(photos[0])]
        : await client.sendMediaGroup(photos);
    if (sent.length !== photos.length)
      throw new TelegramFailure('DELIVERY_UNKNOWN', false, true);
    state.done.push(sent);
    await save();
  }
  return state.done[0][0];
}
