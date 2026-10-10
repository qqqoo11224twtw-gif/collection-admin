import type { Context } from './context';
import { systemLog } from './system-log';
import type { TelegramClient } from './telegram-client';
import { BotApiTelegramClient } from './telegram-client';
import type { TelegramUpdate } from './telegram-contract';

type IdClient = Pick<TelegramClient, 'sendMessage' | 'getMe'> & {
  isChatAdmin(chatId: string, userId: number): Promise<boolean>;
};
export async function handleTelegramId(
  context: Context,
  update: TelegramUpdate,
  supplied?: IdClient,
) {
  const m = update.message;
  const command = m?.text?.trim().match(/^\/id(?:@([A-Za-z0-9_]+))?$/i);
  if (!m || !command) return null;
  const now = Date.now();
  // Claim before external delivery. A replay never blindly sends a second reply.
  const result = await context.env.DB.prepare(
    "INSERT INTO telegram_updates(id,payload,status,attempts,next_attempt_at,created_at,processed_at,result_code) VALUES(?,'{}','done',0,?,?,?,'ID_COMMAND') ON CONFLICT(id) DO NOTHING",
  )
    .bind(String(update.update_id), now, now, now)
    .run();
  if (!result.meta.changes) return { duplicate: true };
  try {
    if (
      !['group', 'supergroup'].includes(m.chat.type ?? '') ||
      !m.from ||
      m.from.is_bot ||
      m.sender_chat
    )
      return { duplicate: false };
    const token = context.env.TELEGRAM_BOT_TOKEN;
    if (!supplied && !token) throw new Error('UNAVAILABLE');
    const client = supplied ?? new BotApiTelegramClient(token ?? '');
    if (
      command[1] &&
      (!client.getMe ||
        (await client.getMe()).username.toLowerCase() !==
          command[1].toLowerCase())
    )
      return { duplicate: false };
    if (!(await client.isChatAdmin(String(m.chat.id), m.from.id)))
      return { duplicate: false };
    const sendStarted = performance.now();
    await client.sendMessage({
      chatId: String(m.chat.id),
      topicId: m.message_thread_id ?? null,
      text: `Chat ID: ${m.chat.id}\nTopic ID: ${m.message_thread_id ?? '無'}`,
    });
    if (context.telegramTiming)
      context.telegramTiming.telegram_send_ms +=
        performance.now() - sendStarted;
  } catch {
    await systemLog(context.env.DB, {
      category: 'telegram',
      event: 'TELEGRAM_ID_COMMAND_FAILED',
      status: 'failed',
      level: 'warning',
      errorCode: 'ID_COMMAND_FAILED',
      safeMessage: '群組 ID 管理指令未完成，請檢查 Bot 群組權限。',
    });
  }
  return { duplicate: false };
}
