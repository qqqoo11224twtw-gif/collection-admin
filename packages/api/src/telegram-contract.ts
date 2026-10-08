import { z } from 'zod';

const id = z.number().int().safe();
const photo = z.object({
  file_id: z.string().min(1).max(512),
  file_size: z.number().int().nonnegative().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});
export const telegramUpdateSchema = z.object({
  update_id: id.nonnegative(),
  message: z
    .object({
      message_id: id.positive(),
      date: id.nonnegative(),
      chat: z.object({ id, type: z.string().optional() }),
      from: z
        .object({
          id: id.positive(),
          is_bot: z.boolean().optional(),
          first_name: z.string().optional(),
        })
        .optional(),
      sender_chat: z.object({ id }).optional(),
      message_thread_id: id.positive().optional(),
      text: z.string().max(10000).optional(),
      caption: z.string().max(1024).optional(),
      photo: z.array(photo).max(10).optional(),
      document: z
        .object({
          file_id: z.string().min(1).max(512),
          file_name: z.string().max(255).optional(),
          mime_type: z.string().max(100).optional(),
          file_size: z.number().int().nonnegative().optional(),
        })
        .optional(),
      media_group_id: z.string().min(1).max(120).optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
export function albumKey(update: TelegramUpdate) {
  const m = update.message;
  return m?.media_group_id
    ? `${m.chat.id}:${m.message_thread_id ?? 0}:${m.media_group_id}`
    : null;
}
export const routeSchema = z
  .object({
    id: z.string().optional(),
    collectorId: z.string().nullable().default(null),
    chatId: z.string().regex(/^-?[1-9]\d{0,15}$/),
    topicId: z.number().int().positive().nullable().default(null),
    routeType: z.enum(['collector', 'report_destination', 'intake_source']),
    isActive: z.boolean().default(true),
  })
  .strict();
export const identitySchema = z
  .object({
    id: z.string().optional(),
    telegramUserId: z.string().regex(/^[1-9]\d{0,15}$/),
    collectorId: z.string().nullable().default(null),
    userId: z.string().nullable().default(null),
    displayName: z.string().trim().max(120).nullable().default(null),
    isActive: z.boolean().default(true),
  })
  .strict();
export const outboundPayloadSchema = z
  .object({
    chatId: z.string().regex(/^-?[1-9]\d{0,15}$/),
    topicId: z.number().int().positive().nullable(),
    text: z.string().min(1).max(4096),
  })
  .strict();
export type TelegramSettings = {
  TELEGRAM_MODE?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  BUSINESS_TIMEZONE?: string;
  SERVER_URL?: string;
};
export const MAX_ATTEMPTS = 5;
export const QUIET_PERIOD_MS = 3000;
export function backoff(attempt: number) {
  return Math.min(300000, 1000 * 2 ** Math.max(0, attempt - 1));
}
