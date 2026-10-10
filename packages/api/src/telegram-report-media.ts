import { z } from 'zod';
import type { Context } from './context';
import { type TelegramClient, TelegramFailure } from './telegram-client';
import type {
  TelegramMessagePayload,
  TelegramUpdate,
} from './telegram-contract';
import { expireReportConversations } from './telegram-report-expiry';

export const REPORT_MEDIA_QUIET_MS = 3000;
const REF_TTL = 7 * 24 * 60 * 60 * 1000;

// Receipt-time binding is immutable: replacing a conversation must never move
// already received pictures into the next report. Album fragments can precede
// their caption; unbound fragments are adopted by that caption's group only.
export async function receiveReportMedia(
  context: Context,
  update: TelegramUpdate,
  routeId: string,
  now: number,
) {
  const m = update.message;
  if (!m || (!m.photo && !m.document)) return;
  const command = /^\/(回報|收款)(?:@|\s|$)/u.test((m.caption ?? '').trim());
  const group = m.media_group_id ?? null;
  const bound = group
    ? await context.env.DB.prepare(
        'SELECT conversation_id FROM telegram_report_media WHERE route_id=? AND media_group_id=? AND conversation_id IS NOT NULL LIMIT 1',
      )
        .bind(routeId, group)
        .first<{ conversation_id: string }>()
    : null;
  const active = !command
    ? await context.env.DB.prepare(
        "SELECT id FROM telegram_report_conversations WHERE route_id=? AND stage IN ('selecting','content','submitting','status') AND expires_at>? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(routeId, now)
        .first<{ id: string }>()
    : null;
  await context.env.DB.prepare(
    'INSERT INTO telegram_report_media(id,route_id,conversation_id,chat_id,message_id,media_group_id,received_at,expires_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
  )
    .bind(
      String(update.update_id),
      routeId,
      bound?.conversation_id ?? active?.id ?? null,
      String(m.chat.id),
      m.message_id,
      group,
      now,
      now + REF_TTL,
    )
    .run();
}

export async function bindReportMedia(
  context: Context,
  update: TelegramUpdate,
  routeId: string,
  conversationId: string,
) {
  const m = update.message;
  if (!m || (!m.photo && !m.document)) return;
  await context.env.DB.prepare(
    /^\/(回報|收款)(?:@|\s|$)/u.test((m.caption ?? '').trim()) &&
      m.media_group_id
      ? 'UPDATE telegram_report_media SET conversation_id=?,accepted_at=NULL WHERE route_id=? AND (id=? OR media_group_id=?)'
      : 'UPDATE telegram_report_media SET conversation_id=? WHERE route_id=? AND conversation_id IS NULL AND (id=? OR (media_group_id IS NOT NULL AND media_group_id=?))',
  )
    .bind(
      conversationId,
      routeId,
      String(update.update_id),
      m.media_group_id ?? null,
    )
    .run();
  const accepted = await acceptReportMedia(
    context,
    String(update.update_id),
    conversationId,
  );
  if (!accepted)
    await context.env.DB.prepare(
      'UPDATE telegram_report_media SET accepted_at=0 WHERE id=? AND accepted_at IS NULL',
    )
      .bind(String(update.update_id))
      .run();
}

export async function acceptReportMedia(
  context: Context,
  updateId: string,
  conversationId: string,
) {
  const result = await context.env.DB.prepare(
    "UPDATE telegram_report_media SET accepted_at=? WHERE (id=? OR (media_group_id IS NOT NULL AND media_group_id=(SELECT media_group_id FROM telegram_report_media WHERE id=?) AND route_id=(SELECT route_id FROM telegram_report_media WHERE id=?))) AND conversation_id=? AND accepted_at IS NULL AND EXISTS(SELECT 1 FROM telegram_report_conversations c JOIN telegram_routes r ON r.id=c.route_id JOIN collectors col ON col.id=c.collector_id WHERE c.id=telegram_report_media.conversation_id AND c.stage IN ('selecting','content','submitting','status') AND c.expires_at>? AND r.is_active=1 AND r.collector_id=c.collector_id AND col.is_active=1 AND (c.report_id IS NULL OR EXISTS(SELECT 1 FROM reports rp WHERE rp.id=c.report_id AND rp.workflow_status='awaiting_status' AND rp.selected_status IS NULL)) AND (c.case_id IS NULL OR EXISTS(SELECT 1 FROM cases ca JOIN assignments a ON a.case_id=ca.id WHERE ca.id=c.case_id AND ca.voided_at IS NULL AND a.id=c.assignment_id AND a.collector_id=c.collector_id AND a.unassigned_at IS NULL)))",
  )
    .bind(Date.now(), updateId, updateId, updateId, conversationId, Date.now())
    .run();
  return result.meta.changes;
}

export async function reportMediaReady(context: Context, reportId: string) {
  const conversation = await context.env.DB.prepare(
    'SELECT stage,expires_at FROM telegram_report_conversations WHERE report_id=?',
  )
    .bind(reportId)
    .first<{ stage: string; expires_at: number }>();
  if (
    conversation &&
    conversation.stage !== 'completed' &&
    (conversation.expires_at <= Date.now() ||
      ['expired', 'cancelled'].includes(conversation.stage))
  )
    return false;
  const row = await context.env.DB.prepare(
    'SELECT max(CASE WHEN m.accepted_at>0 THEN m.received_at ELSE NULL END) AS latest,sum(CASE WHEN m.accepted_at IS NULL THEN 1 ELSE 0 END) AS pending FROM telegram_report_media m JOIN telegram_report_conversations c ON c.id=m.conversation_id WHERE c.report_id=?',
  )
    .bind(reportId)
    .first<{ latest: number | null; pending: number }>();
  return (
    !row?.pending &&
    (!row?.latest || row.latest + REPORT_MEDIA_QUIET_MS <= Date.now())
  );
}

const checkpoint = z.strictObject({
  kind: z.literal('report-media'),
  chatId: z.string(),
  topicId: z.number().nullable(),
  sourceChatId: z.string().nullable(),
  messageIds: z.array(z.number().int().positive()).max(100),
  textId: z.string().nullable(),
  completed: z.array(z.array(z.string())),
  presentation: z
    .enum(['caption', 'text-before-media'])
    .default('text-before-media'),
  captionApplied: z.boolean().default(false),
  expiresAt: z.number(),
});

export async function sendReportMedia(
  context: Context,
  client: TelegramClient,
  job: { id: string; reportId: string | null; dispatchState: string | null },
  target: TelegramMessagePayload,
  token: string,
) {
  let state: z.infer<typeof checkpoint>;
  if (job.dispatchState)
    state = checkpoint.parse(JSON.parse(job.dispatchState));
  else {
    if (!(await reportMediaReady(context, job.reportId ?? '')))
      throw new TelegramFailure('REPORT_MEDIA_RECEIVING', true);
    const rows = await context.env.DB.prepare(
      'SELECT m.chat_id,m.message_id,m.expires_at FROM telegram_report_media m JOIN telegram_report_conversations c ON c.id=m.conversation_id WHERE c.report_id=? AND m.accepted_at>0 ORDER BY m.message_id',
    )
      .bind(job.reportId)
      .all<{ chat_id: string; message_id: number; expires_at: number }>();
    if (
      rows.results.length > 100 ||
      rows.results.some((r) => r.chat_id !== rows.results[0].chat_id)
    )
      throw new TelegramFailure('INVALID_MEDIA_GROUP', false);
    state = checkpoint.parse({
      kind: 'report-media',
      chatId: target.chatId,
      topicId: target.topicId,
      sourceChatId: rows.results[0]?.chat_id ?? null,
      messageIds: rows.results.map((r) => r.message_id),
      textId: null,
      completed: [],
      presentation: rows.results.length ? 'caption' : 'text-before-media',
      captionApplied: false,
      expiresAt: Math.min(
        Date.now() + REF_TTL,
        ...rows.results.map((r) => r.expires_at),
      ),
    });
  }
  if (state.chatId !== target.chatId || state.topicId !== target.topicId)
    throw new TelegramFailure('ROUTE_CHANGED', false);
  if (state.expiresAt <= Date.now())
    throw new TelegramFailure('REPORT_MEDIA_EXPIRED', false);
  if (state.presentation === 'caption' && target.text.length > 1024)
    throw new TelegramFailure('REPORT_CAPTION_TOO_LONG', false);
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
  if (!state.textId && state.presentation === 'text-before-media') {
    state.textId = await client.sendMessage(target);
    await save();
  }
  if (state.messageIds.length && !client.copyReportMedia)
    throw new TelegramFailure('MEDIA_TRANSPORT_UNAVAILABLE', false);
  const applyCaption = async () => {
    if (
      state.presentation !== 'caption' ||
      state.captionApplied ||
      !state.textId
    )
      return;
    if (!client.editReportCaption)
      throw new TelegramFailure('MEDIA_TRANSPORT_UNAVAILABLE', false);
    await client.editReportCaption({
      chatId: target.chatId,
      messageId: state.textId,
      caption: target.text,
    });
    state.captionApplied = true;
    await save();
  };
  // A retry after native copying resumes only the idempotent caption edit.
  await applyCaption();
  for (
    let part = state.completed.length;
    part * 10 < state.messageIds.length;
    part++
  ) {
    const ids = state.messageIds.slice(part * 10, part * 10 + 10);
    const result = await client.copyReportMedia?.({
      chatId: target.chatId,
      topicId: target.topicId,
      sourceChatId: state.sourceChatId as string,
      messageIds: ids,
      ...(state.presentation === 'caption'
        ? { caption: part === 0 ? target.text : '' }
        : {}),
    });
    if (!result || result.length !== ids.length)
      throw new TelegramFailure('DELIVERY_UNKNOWN', false, true);
    state.completed.push(result);
    if (state.presentation === 'caption' && part === 0) {
      state.textId = result[0];
      // copyMessage attaches a single-picture caption in the same Telegram call.
      state.captionApplied = ids.length === 1;
    }
    await save();
    await applyCaption();
  }
  if (!state.textId) throw new TelegramFailure('DELIVERY_UNKNOWN', false, true);
  return state.textId;
}

export async function cleanupReportMedia(context: Context, now: number) {
  await expireReportConversations(context.env.DB, now);
  await context.env.DB.batch([
    context.env.DB.prepare(
      "UPDATE telegram_outbound_jobs SET status='failed',last_error_code='REPORT_MEDIA_EXPIRED',lease_until=NULL WHERE message_type='report_destination' AND status='pending' AND report_id IN (SELECT c.report_id FROM telegram_report_conversations c JOIN telegram_report_media m ON m.conversation_id=c.id WHERE m.expires_at<=?)",
    ).bind(now),
    context.env.DB.prepare(
      "UPDATE telegram_updates SET payload='{}',status=CASE WHEN status IN ('pending','processing') THEN 'failed' ELSE status END,last_error_code=CASE WHEN status IN ('pending','processing') THEN 'REPORT_MEDIA_EXPIRED' ELSE last_error_code END WHERE id IN (SELECT id FROM telegram_report_media WHERE expires_at<=?)",
    ).bind(now),
    context.env.DB.prepare(
      "UPDATE telegram_outbound_jobs SET status='failed',last_error_code='REPORT_MEDIA_EXPIRED',lease_until=NULL WHERE message_type='report_destination' AND status='pending' AND json_extract(dispatch_state,'$.expiresAt')<=?",
    ).bind(now),
    context.env.DB.prepare(
      'DELETE FROM telegram_report_media WHERE expires_at<=?',
    ).bind(now),
    context.env.DB.prepare(
      "UPDATE telegram_outbound_jobs SET dispatch_state=NULL WHERE message_type='report_destination' AND status IN ('sent','failed') AND json_extract(dispatch_state,'$.expiresAt')<=?",
    ).bind(now),
  ]);
}
