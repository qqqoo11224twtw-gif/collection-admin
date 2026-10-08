import type { TelegramUpdate } from './telegram-contract';
export function photoFixture(
  updateId: number,
  chatId: number,
  extra: {
    album?: string;
    messageId?: number;
    userId?: number;
    topicId?: number;
    document?: boolean;
  } = {},
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: extra.messageId ?? updateId,
      date: 1791400000,
      chat: { id: chatId, type: 'supergroup' },
      from: {
        id: extra.userId ?? 900001,
        is_bot: false,
        first_name: 'Fictional collector',
      },
      message_thread_id: extra.topicId,
      media_group_id: extra.album,
      ...(extra.document
        ? {
            document: {
              file_id: `fictional-image-${updateId}`,
              file_name: 'fictional.png',
              mime_type: 'image/png',
              file_size: 500,
            },
          }
        : {
            photo: [
              { file_id: `fictional-small-${updateId}`, file_size: 100 },
              { file_id: `fictional-image-${updateId}`, file_size: 500 },
            ],
          }),
    },
  };
}
export function reportFixture(
  updateId: number,
  chatId: number,
  userId: number,
  identifier: string,
  topicId?: number,
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1791400000,
      chat: { id: chatId, type: 'supergroup' },
      from: { id: userId, is_bot: false, first_name: 'Fictional collector' },
      message_thread_id: topicId,
      text: `/回報 ${identifier} 虛構回報：已到訪`,
    },
  };
}
