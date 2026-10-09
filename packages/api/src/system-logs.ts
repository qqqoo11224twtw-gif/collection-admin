import { ORPCError } from '@orpc/server';
import { z } from 'zod';
import { businessToday } from './finance-contract';
import { protectedProcedure } from './middleware';
import { requirePermission } from './permissions';
import { LOG_CATEGORIES, sanitizeLogText, systemLog } from './system-log';

const listSchema = z.strictObject({
  query: z.string().trim().max(120).default(''),
  level: z.enum(['', 'info', 'warning', 'error', 'critical']).default(''),
  category: z.enum(['', ...LOG_CATEGORIES]).default(''),
  status: z.enum(['', 'pending', 'acknowledged', 'resolved']).default(''),
  eventStatus: z.enum(['', 'success', 'failed', 'retry', 'denied']).default(''),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  page: z.number().int().min(1).default(1),
});
export interface LogRow {
  id: string;
  timestamp: number;
  level: string;
  category: string;
  event: string;
  status: string;
  safe_message: string;
  related_case_id: string | null;
  related_collector_id: string | null;
  related_route_id: string | null;
  related_job_id: string | null;
  related_user_id: string | null;
  correlation_id: string;
  duration_ms: number | null;
  retry_count: number | null;
  error_code: string | null;
  handled_status: string;
  handled_by: string | null;
  handled_at: number | null;
  handled_user_name: string | null;
  note: string | null;
  case_no: string | null;
  code: string | null;
  collector_name: string | null;
  route_name: string | null;
  user_name: string | null;
  intake_id: string | null;
  review_item_id: string | null;
  ai_model: string | null;
}
export const systemLogsApi = {
  list: protectedProcedure
    .input(listSchema)
    .handler(async ({ context, input }) => {
      requirePermission(context, 'system_log.view');
      const filters: string[] = [];
      const values: (string | number)[] = [];
      for (const [key, value] of [
        ['level', input.level],
        ['category', input.category],
        ['handled_status', input.status],
        ['status', input.eventStatus],
      ])
        if (value) {
          filters.push(`l.${key}=?`);
          values.push(value);
        }
      if (input.dateFrom) {
        filters.push('l.timestamp>=?');
        values.push(new Date(`${input.dateFrom}T00:00:00+08:00`).getTime());
      }
      if (input.dateTo) {
        filters.push('l.timestamp<?');
        values.push(
          new Date(`${input.dateTo}T00:00:00+08:00`).getTime() + 86400000,
        );
      }
      if (input.query) {
        filters.push(
          "(l.error_code LIKE ? ESCAPE '!' OR l.event LIKE ? ESCAPE '!' OR c.case_no LIKE ? ESCAPE '!' OR c.code LIKE ? ESCAPE '!' OR co.display_name LIKE ? ESCAPE '!' OR l.related_job_id LIKE ? ESCAPE '!' OR r.name LIKE ? ESCAPE '!' OR u.name LIKE ? ESCAPE '!')",
        );
        const q = `%${input.query.replace(/[!%_]/g, (c) => `!${c}`)}%`;
        values.push(...Array(8).fill(q));
      }
      const from =
        'FROM system_logs l LEFT JOIN cases c ON c.id=l.related_case_id LEFT JOIN collectors co ON co.id=l.related_collector_id LEFT JOIN telegram_routes r ON r.id=l.related_route_id LEFT JOIN user u ON u.id=l.related_user_id LEFT JOIN user hu ON hu.id=l.handled_by LEFT JOIN ai_image_jobs aj ON aj.id=l.related_job_id LEFT JOIN intake_items i ON i.id=aj.intake_id';
      const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
      const [count, items] = await Promise.all([
        context.env.DB.prepare(`SELECT count(*) AS total ${from}${where}`)
          .bind(...values)
          .all<{ total: number }>(),
        context.env.DB.prepare(
          `SELECT l.*,c.case_no,c.code,co.display_name AS collector_name,r.name AS route_name,u.name AS user_name,hu.name AS handled_user_name,aj.intake_id,i.review_item_id,aj.model AS ai_model ${from}${where} ORDER BY l.timestamp DESC,l.id LIMIT 25 OFFSET ?`,
        )
          .bind(...values, (input.page - 1) * 25)
          .all<LogRow>(),
      ]);
      return {
        items: items.results,
        total: Number(count.results[0].total),
        page: input.page,
      };
    }),
  summary: protectedProcedure.handler(async ({ context }) => {
    requirePermission(context, 'system_log.view');
    const since = new Date(`${businessToday()}T00:00:00+08:00`).getTime();
    const metrics = await context.env.DB.prepare(
      "SELECT count(CASE WHEN level IN ('error','critical') THEN 1 END) AS errors,count(CASE WHEN category IN ('telegram','outbound') AND status='failed' THEN 1 END) AS telegramFailures,count(CASE WHEN category='openai' AND status='failed' THEN 1 END) AS openaiFailures,count(CASE WHEN category='otp' AND status='failed' THEN 1 END) AS otpFailures,count(CASE WHEN category='auth' AND status='denied' THEN 1 END) AS deniedLogins FROM system_logs WHERE timestamp>=?",
    )
      .bind(since)
      .first<{
        errors: number;
        telegramFailures: number;
        openaiFailures: number;
        otpFailures: number;
        deniedLogins: number;
      }>();
    const retry = await context.env.DB.prepare(
      "SELECT count(*) AS total FROM telegram_outbound_jobs WHERE status='pending' AND attempts>0",
    ).first<{ total: number }>();
    const recent = await context.env.DB.prepare(
      "SELECT id,timestamp,safe_message FROM system_logs WHERE level IN ('error','critical') ORDER BY timestamp DESC LIMIT 5",
    ).all<{ id: string; timestamp: number; safe_message: string }>();
    return {
      ...metrics,
      pendingRetry: retry?.total ?? 0,
      recentErrors: recent.results,
    };
  }),
  handle: protectedProcedure
    .input(
      z.strictObject({
        id: z.string(),
        status: z.enum(['pending', 'acknowledged', 'resolved']),
        note: z.string().trim().max(500),
      }),
    )
    .handler(async ({ context, input }) => {
      const actor = requirePermission(context, 'system_log.manage');
      const result = await context.env.DB.batch([
        context.env.DB.prepare(
          'UPDATE system_logs SET handled_status=?,handled_by=?,handled_at=?,note=? WHERE id=?',
        ).bind(
          input.status,
          actor.id,
          Date.now(),
          sanitizeLogText(input.note),
          input.id,
        ),
        context.env.DB.prepare(
          "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata,created_at) SELECT ?,?,'system_log.handled','system_log',?,?,? WHERE changes()=1",
        ).bind(
          crypto.randomUUID(),
          actor.id,
          input.id,
          JSON.stringify({ status: input.status }),
          Date.now(),
        ),
      ]);
      if (!result[0].meta.changes) throw new ORPCError('NOT_FOUND');
      await systemLog(context.env.DB, {
        category: 'system',
        event: 'LOG_HANDLED',
        relatedUserId: actor.id,
      });
      return { success: true };
    }),
};
