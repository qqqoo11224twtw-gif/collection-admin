import type { Context } from './context';
import type { IntakeSourceAdapter } from './intake-contract';
import { type TelegramUpdate, telegramUpdateSchema } from './telegram-contract';
export class TelegramIntakeAdapter implements IntakeSourceAdapter {
  readonly source = 'telegram' as const;
  async normalize(raw: unknown) {
    const update = telegramUpdateSchema.parse(raw);
    return {
      source: this.source,
      externalId: String(update.update_id),
      dedupeKey: `telegram-update:${update.update_id}`,
      proposedData: {
        code: null,
        customer_name: null,
        address: null,
        amount_due: null,
      },
    };
  }
}
export function telegramAudit(
  context: Context,
  action: string,
  id: string,
  metadata: Record<string, string | number | null> = {},
  guard?: { sql: string; values: (string | number | null)[] },
) {
  return context.env.DB.prepare(
    `INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,?,'telegram',?,?,?${guard ? ` WHERE ${guard.sql}` : ''}`,
  ).bind(
    crypto.randomUUID(),
    context.user?.id ?? null,
    action,
    id,
    JSON.stringify(metadata),
    Date.now(),
    ...(guard?.values ?? []),
  );
}
export function telegramFile(update: TelegramUpdate) {
  const m = update.message;
  if (m?.photo?.length) {
    const p = [...m.photo].sort(
      (a, b) =>
        (b.file_size ?? (b.width ?? 0) * (b.height ?? 0)) -
        (a.file_size ?? (a.width ?? 0) * (a.height ?? 0)),
    )[0];
    return {
      fileId: p.file_id,
      filename: `telegram-${m.message_id}.jpg`,
      size: p.file_size,
    };
  }
  if (
    m?.document &&
    ['image/png', 'image/jpeg', 'image/webp'].includes(
      m.document.mime_type ?? '',
    )
  )
    return {
      fileId: m.document.file_id,
      filename: m.document.file_name ?? `telegram-${m.message_id}`,
      size: m.document.file_size,
    };
  return null;
}
