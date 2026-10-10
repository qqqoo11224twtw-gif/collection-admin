import type { telegramRoutes } from '@saasflare-dev/db';
import type { Context } from './context';
import type { TelegramClient } from './telegram-client';
import type { TelegramUpdate } from './telegram-contract';
import { queueTelegramMessage } from './telegram-outbound';

export const REPORT_EXPIRED_TEXT = '回報已逾時失敗，請重新輸入 /回報。';

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
}
