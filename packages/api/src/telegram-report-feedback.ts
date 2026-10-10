import type { telegramRoutes } from '@saasflare-dev/db';
import type { Context } from './context';
import type { TelegramClient } from './telegram-client';
import type { TelegramUpdate } from './telegram-contract';
import { queueTelegramMessage } from './telegram-outbound';

export const REPORT_EXPIRED_TEXT = '回報已逾時失敗，請重新輸入 /回報。';

export async function acknowledgeReportExpiry(
  context: Context,
  conversationId: string,
) {
  await context.env.DB.prepare(
    "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,NULL,'TELEGRAM_REPORT_EXPIRY_ACKNOWLEDGED','telegram',?,'{}',? WHERE NOT EXISTS(SELECT 1 FROM audit_logs WHERE entity_id=? AND action='TELEGRAM_REPORT_EXPIRY_ACKNOWLEDGED')",
  )
    .bind(crypto.randomUUID(), conversationId, Date.now(), conversationId)
    .run();
}

export async function notifyExpiredReportCallback(
  context: Context,
  update: TelegramUpdate,
  route: typeof telegramRoutes.$inferSelect,
  client: TelegramClient,
) {
  const query = update.callback_query;
  if (!query) return;
  if (!context.telegramCallbackAcknowledged) {
    try {
      await client.answerCallbackQuery(query.id, '');
    } catch {
      // Telegram may expire its callback query before the conversation does.
    }
  }
  // A second callback answer is not a reliable notification after the fast ACK.
  // The durable reply deduplicates even when a callback ID is replayed in a new update.
  await queueTelegramMessage(
    context,
    route,
    `report-expired-callback:${query.id}`,
    REPORT_EXPIRED_TEXT,
  );
  const data = query.data ?? '';
  const selection = /^(?:rc|rp):([a-f0-9]{32}):/.exec(data);
  const status = /^report_status:([a-f0-9]{32}):/.exec(data);
  const conversation = selection
    ? await context.env.DB.prepare(
        'SELECT id FROM telegram_report_conversations WHERE id=? AND route_id=? AND expires_at<=?',
      )
        .bind(selection[1], route.id, Date.now())
        .first<{ id: string }>()
    : status
      ? await context.env.DB.prepare(
          'SELECT c.id FROM telegram_report_conversations c JOIN reports r ON r.id=c.report_id WHERE r.callback_token=? AND c.route_id=? AND c.expires_at<=?',
        )
          .bind(status[1], route.id, Date.now())
          .first<{ id: string }>()
      : null;
  if (conversation) await acknowledgeReportExpiry(context, conversation.id);
}
