import { z } from 'zod';

export const LOG_CATEGORIES = [
  'telegram',
  'intake',
  'outbound',
  'openai',
  'storage',
  'otp',
  'auth',
  'permission',
  'finance',
  'installment',
  'database',
  'scheduler',
  'system',
] as const;
export const logSchema = z.strictObject({
  level: z.enum(['info', 'warning', 'error', 'critical']).default('info'),
  category: z.enum(LOG_CATEGORIES),
  event: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
  status: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,50}$/)
    .default('success'),
  safeMessage: z.string().max(500).default(''),
  relatedCaseId: z.string().max(120).nullish(),
  relatedCollectorId: z.string().max(120).nullish(),
  relatedJobId: z.string().max(120).nullish(),
  relatedRouteId: z.string().max(120).nullish(),
  relatedUserId: z.string().max(120).nullish(),
  correlationId: z.string().max(120).optional(),
  durationMs: z.number().int().nonnegative().nullish(),
  retryCount: z.number().int().nonnegative().nullish(),
  errorCode: z
    .string()
    .regex(/^[A-Z0-9_]{1,100}$/)
    .nullish(),
});
export const DIAGNOSTICS: Record<string, string> = {
  DELIVERY_UNKNOWN: 'Telegram 送達狀態無法確認，請人工檢查群組。',
  API_403: 'Bot 可能沒有該群組權限。',
  API_400: 'Telegram API 拒絕，請確認群組與 Topic 設定。',
  ROUTE_NOT_FOUND: '尚未設定有效 Telegram 路由。',
  ROUTE_CHANGED: 'Telegram 路由已變更。',
  R2_UPLOAD_FAILED: '圖片儲存失敗。',
  OTP_SEND_FAILED: '驗證碼寄送失敗。',
  EMAIL_NOT_ALLOWED: '此 Email 未被管理員授權登入。',
  USER_INACTIVE: '此帳號目前已被停用。',
  PERMISSION_DENIED: '此帳號沒有執行此操作的權限。',
};
// Drop arbitrary URLs, credentials and provider error prose instead of trusting redaction alone.
export function sanitizeLogText(value: string) {
  if (
    /(https?:\/\/|authorization|cookie|bearer|token|secret|api[_ -]?key|sk-[A-Za-z0-9]|re_[A-Za-z0-9]|\b\d{7,12}:[A-Za-z0-9_-]{30,}\b|otp\s*[:=]|\b\d{6}\b)/i.test(
      value,
    )
  )
    return '敏感內容已隱藏。';
  return [...value]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .slice(0, 500);
}
export async function systemLog(
  db: D1Database,
  raw: z.input<typeof logSchema>,
) {
  try {
    const data = logSchema.parse(raw);
    const safe = (value: string | null | undefined) =>
      value ? sanitizeLogText(value) : null;
    await db
      .prepare(
        'INSERT INTO system_logs(id,timestamp,level,category,event,status,safe_message,related_case_id,related_collector_id,related_job_id,related_route_id,related_user_id,correlation_id,duration_ms,retry_count,error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        data.level,
        data.category,
        sanitizeLogText(data.event),
        sanitizeLogText(data.status),
        sanitizeLogText(
          data.safeMessage || DIAGNOSTICS[data.errorCode ?? ''] || data.event,
        ),
        safe(data.relatedCaseId),
        safe(data.relatedCollectorId),
        safe(data.relatedJobId),
        safe(data.relatedRouteId),
        safe(data.relatedUserId),
        safe(data.correlationId) ?? crypto.randomUUID(),
        data.durationMs ?? null,
        data.retryCount ?? null,
        data.errorCode && sanitizeLogText(data.errorCode) === data.errorCode
          ? data.errorCode
          : null,
      )
      .run();
  } catch {
    console.warn('system_log_unavailable');
  }
}
export async function cleanupSystemLogs(db: D1Database, now = Date.now()) {
  const day = 86400000;
  return db
    .prepare(
      "DELETE FROM system_logs WHERE (level='info' AND timestamp<?) OR (level IN ('warning','error') AND timestamp<?) OR (level='critical' AND timestamp<?)",
    )
    .bind(now - 30 * day, now - 90 * day, now - 180 * day)
    .run();
}
