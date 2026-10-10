import { telegramOutboundJobs, telegramRoutes } from '@saasflare-dev/db';
import { and, eq, sql } from 'drizzle-orm';
import type { Context } from './context';
import { renderPaymentBusinessReport } from './customer-payments';
import { telegramAudit } from './telegram-adapter';
import {
  botClientForRoute,
  botIsDisabled,
  logDisabledBot,
} from './telegram-bots';
import {
  type TelegramClient,
  TelegramFailure,
  telegramExceptionKind,
} from './telegram-client';
import {
  backoff,
  type InlineKeyboard,
  MAX_ATTEMPTS,
  outboundPayloadSchema,
  type TelegramSettings,
} from './telegram-contract';
import { sendAssignmentMedia } from './telegram-dispatch-media';
import { sendReportMedia } from './telegram-report-media';
export function businessDate(time: number, timezone = 'Asia/Taipei') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(time));
  const value = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${value('year')}/${value('month')}/${value('day')}`;
}
export function renderBusinessReport(
  input: {
    code: string;
    customerName: string;
    content: string;
    createdAt: number;
  },
  timezone: string,
) {
  const oneLine = (value: string) =>
    value
      .split('')
      .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
      .join('');
  return `代號：${oneLine(input.code)}\n客戶姓名：${oneLine(input.customerName)}\n回報內容：${oneLine(input.content)}\n日期：${businessDate(input.createdAt, timezone)}`;
}
export async function queueTelegramMessage(
  context: Context,
  route: typeof telegramRoutes.$inferSelect,
  key: string,
  text: string,
  reportId: string | null = null,
  options: { replyMarkup?: InlineKeyboard; commandReply?: boolean } = {},
) {
  if (await botIsDisabled(context, route.botId)) {
    await logDisabledBot(context, route.botId as string, route.id);
    return;
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const payload = outboundPayloadSchema.parse({
    chatId: route.chatId,
    topicId: route.topicId,
    text,
    replyMarkup: options.replyMarkup,
  });
  await context.env.DB.batch([
    context.env.DB.prepare(
      "INSERT INTO telegram_outbound_jobs(id,dedupe_key,message_type,report_id,route_id,payload,status,attempts,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,'pending',0,?,?) ON CONFLICT(dedupe_key) DO NOTHING",
    ).bind(
      id,
      key,
      reportId && !options.commandReply
        ? 'report_destination'
        : 'command_reply',
      reportId,
      route.id,
      JSON.stringify(payload),
      now,
      now,
    ),
    telegramAudit(
      context,
      reportId && !options.commandReply
        ? 'report.outbound_queued'
        : 'telegram.reply_queued',
      id,
      { reportId, routeId: route.id },
      {
        sql: 'EXISTS(SELECT 1 FROM telegram_outbound_jobs WHERE id=?)',
        values: [id],
      },
    ),
  ]);
  // Interactive replies use the same durable dedupe key and delivery claim.
  // Business forwarding and assignment dispatch remain background jobs.
  if ((!reportId || options.commandReply) && context.telegramReply)
    await context.telegramReply(key);
}
export async function queueReportDestination(
  context: Context,
  reportId: string,
) {
  const settings: TelegramSettings = context.env;
  const report = await context.env.DB.prepare(
    "SELECT r.content,r.created_at,r.collector_id,r.case_id,r.finance_event,c.code,c.customer_name FROM reports r JOIN cases c ON c.id=r.case_id WHERE r.id=? AND r.workflow_status='completed'",
  )
    .bind(reportId)
    .first<{
      content: string;
      created_at: number;
      collector_id: string | null;
      case_id: string;
      finance_event: string | null;
      code: string;
      customer_name: string;
    }>();
  if (!report) throw new TelegramFailure('REPORT_MISSING', false);
  const routes = await context.DB.select()
    .from(telegramRoutes)
    .where(
      and(
        sql`${telegramRoutes.routeType} IN ('business_report','report_destination')`,
        eq(telegramRoutes.isActive, true),
        sql`(${telegramRoutes.collectorId} IS NULL OR ${telegramRoutes.collectorId}=${report.collector_id})`,
      ),
    );
  const payment =
    report.finance_event === 'payment'
      ? await context.env.DB.prepare(
          "SELECT id FROM payments WHERE idempotency_key=? AND status='received'",
        )
          .bind(reportId)
          .first<{ id: string }>()
      : null;
  const text = payment
    ? await renderPaymentBusinessReport(context, {
        caseId: report.case_id,
        paymentId: payment.id,
        code: report.code,
        customerName: report.customer_name,
        content: report.content,
        date: businessDate(
          report.created_at,
          settings.BUSINESS_TIMEZONE ?? 'Asia/Taipei',
        ),
      })
    : renderBusinessReport(
        {
          code: report.code,
          customerName: report.customer_name,
          content: report.content,
          createdAt: report.created_at,
        },
        settings.BUSINESS_TIMEZONE ?? 'Asia/Taipei',
      );
  for (const route of routes)
    await queueTelegramMessage(
      context,
      route,
      `report-destination:${reportId}:${route.id}`,
      text,
      reportId,
    );
  if (!routes.length)
    await telegramAudit(
      context,
      'report.outbound_no_destination',
      reportId,
      {
        reportId,
      },
      {
        sql: "NOT EXISTS(SELECT 1 FROM audit_logs WHERE entity_id=? AND action='report.outbound_no_destination')",
        values: [reportId],
      },
    ).run();
}
export async function processOutbound(
  context: Context,
  client: TelegramClient,
  now = Date.now(),
  replyKey?: string,
  immediateRoute?: typeof telegramRoutes.$inferSelect,
) {
  // A crashed/expired sending lease is uncertain: do not automatically re-send it.
  const expired = replyKey
    ? { results: [] }
    : await context.env.DB.prepare(
        "SELECT id,message_type FROM telegram_outbound_jobs WHERE status='sending' AND lease_until<=? LIMIT 20",
      )
        .bind(now)
        .all<{ id: string; message_type: string }>();
  for (const row of expired.results) {
    const token = crypto.randomUUID();
    await context.env.DB.batch([
      context.env.DB.prepare(
        "UPDATE telegram_outbound_jobs SET status='failed',last_error_code='DELIVERY_UNKNOWN',lease_token=? WHERE id=? AND status='sending' AND lease_until<=?",
      ).bind(token, row.id, now),
      telegramAudit(
        context,
        row.message_type === 'assignment_dispatch'
          ? 'assignment.outbound_failed'
          : 'report.outbound_failed',
        row.id,
        { code: 'DELIVERY_UNKNOWN' },
        {
          sql: 'EXISTS(SELECT 1 FROM telegram_outbound_jobs WHERE id=? AND lease_token=?)',
          values: [row.id, token],
        },
      ),
    ]);
  }
  const immediateJobs =
    replyKey && immediateRoute
      ? await context.DB.update(telegramOutboundJobs)
          .set({
            status: 'sending',
            attempts: sql`${telegramOutboundJobs.attempts}+1`,
            leaseUntil: new Date(now + 120000),
            leaseToken: crypto.randomUUID(),
          })
          .where(
            and(
              eq(telegramOutboundJobs.dedupeKey, replyKey),
              eq(telegramOutboundJobs.messageType, 'command_reply'),
              eq(telegramOutboundJobs.status, 'pending'),
              sql`${telegramOutboundJobs.nextAttemptAt}<=${now}`,
              sql`NOT EXISTS(SELECT 1 FROM telegram_outbound_jobs peer JOIN telegram_routes pr ON pr.id=peer.route_id WHERE peer.id<>${telegramOutboundJobs.id} AND pr.chat_id=${immediateRoute.chatId} AND coalesce(pr.topic_id,0)=${immediateRoute.topicId ?? 0} AND (peer.status='sending' OR (peer.status='pending' AND peer.message_type='report_destination' AND json_extract(peer.dispatch_state,'$.textId') IS NOT NULL)))`,
              sql`EXISTS(SELECT 1 FROM telegram_routes r WHERE r.id=${telegramOutboundJobs.routeId} AND r.id=${immediateRoute.id} AND r.chat_id=${immediateRoute.chatId} AND coalesce(r.topic_id,0)=${immediateRoute.topicId ?? 0} AND r.route_type=${immediateRoute.routeType} AND r.collector_id IS ${immediateRoute.collectorId} AND r.bot_id IS ${immediateRoute.botId} AND r.managed_by_user_id=${immediateRoute.managedByUserId} AND r.is_active=1 AND (r.bot_id IS NULL OR EXISTS(SELECT 1 FROM telegram_bots b WHERE b.id=r.bot_id AND b.is_active=1)))`,
            ),
          )
          .returning()
      : null;
  const pending = immediateJobs
    ? { results: immediateJobs }
    : await context.env.DB.prepare(
        replyKey
          ? "SELECT id FROM telegram_outbound_jobs WHERE dedupe_key=? AND message_type='command_reply' AND status='pending' AND next_attempt_at<=?"
          : "SELECT id FROM telegram_outbound_jobs WHERE status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 20",
      )
        .bind(...(replyKey ? [replyKey, now] : [now]))
        .all<{ id: string }>();
  for (const candidate of pending.results) {
    const ready = immediateJobs?.find((job) => job.id === candidate.id);
    const token = ready?.leaseToken ?? crypto.randomUUID();
    const claim = ready
      ? { meta: { changes: 1 } }
      : await context.env.DB.prepare(
          "UPDATE telegram_outbound_jobs SET status='sending',attempts=attempts+1,lease_until=?,lease_token=? WHERE id=? AND status='pending' AND next_attempt_at<=? AND NOT EXISTS(SELECT 1 FROM telegram_outbound_jobs peer JOIN telegram_routes pr ON pr.id=peer.route_id JOIN telegram_routes target ON target.id=telegram_outbound_jobs.route_id WHERE peer.id<>telegram_outbound_jobs.id AND pr.chat_id=target.chat_id AND coalesce(pr.topic_id,0)=coalesce(target.topic_id,0) AND (peer.status='sending' OR (peer.status='pending' AND peer.message_type='report_destination' AND json_extract(peer.dispatch_state,'$.textId') IS NOT NULL)))",
        )
          .bind(Math.max(now, Date.now()) + 120000, token, candidate.id, now)
          .run();
    if (claim.meta.changes !== 1) continue;
    const [job] = ready
      ? [ready]
      : await context.DB.select()
          .from(telegramOutboundJobs)
          .where(eq(telegramOutboundJobs.id, candidate.id));
    try {
      const [route] =
        ready && immediateRoute
          ? [immediateRoute]
          : await context.DB.select()
              .from(telegramRoutes)
              .where(eq(telegramRoutes.id, job.routeId));
      const payload = outboundPayloadSchema.parse(JSON.parse(job.payload));
      if (!route?.isActive) throw new TelegramFailure('ROUTE_CHANGED', false);
      payload.chatId = route.chatId;
      payload.topicId = route.topicId;
      if (
        job.messageType === 'report_destination' &&
        !['business_report', 'report_destination'].includes(route.routeType)
      )
        throw new TelegramFailure('ROUTE_CHANGED', false);
      if (
        job.messageType === 'command_reply' &&
        job.reportId &&
        route.routeType !== 'collector_report'
      )
        throw new TelegramFailure('ROUTE_CHANGED', false);
      if (job.messageType === 'assignment_dispatch') {
        const valid = await context.env.DB.prepare(
          "SELECT a.id FROM assignments a JOIN cases ca ON ca.id=a.case_id JOIN collectors c ON c.id=a.collector_id JOIN telegram_routes r ON r.id=? WHERE a.id=? AND a.unassigned_at IS NULL AND a.record_type='assignment' AND ca.voided_at IS NULL AND c.is_active=1 AND r.collector_id=c.id AND r.route_type IN ('collector','collector_dispatch')",
        )
          .bind(job.routeId, job.assignmentId)
          .first();
        if (!valid) throw new TelegramFailure('ASSIGNMENT_CHANGED', false);
      }
      const deliveryClient = ready
        ? client
        : await botClientForRoute(context, route.botId, client);
      const sendStarted = performance.now();
      const messageId =
        job.messageType === 'assignment_dispatch'
          ? await sendAssignmentMedia(
              context,
              deliveryClient,
              job,
              payload,
              token,
            )
          : job.messageType === 'report_destination'
            ? await sendReportMedia(
                context,
                deliveryClient,
                job,
                payload,
                token,
              )
            : await deliveryClient.sendMessage(payload);
      if (context.telegramTiming)
        context.telegramTiming.telegram_send_ms +=
          performance.now() - sendStarted;
      await context.env.DB.batch([
        context.env.DB.prepare(
          "UPDATE telegram_outbound_jobs SET status='sent',telegram_message_id=?,sent_at=?,last_error_code=NULL,lease_until=NULL WHERE id=? AND status='sending' AND lease_token=?",
        ).bind(messageId, now, job.id, token),
        telegramAudit(
          context,
          job.messageType === 'report_destination'
            ? 'report.outbound_sent'
            : job.messageType === 'assignment_dispatch'
              ? 'assignment.outbound_sent'
              : 'telegram.reply_sent',
          job.id,
          { reportId: job.reportId },
          {
            sql: "EXISTS(SELECT 1 FROM telegram_outbound_jobs WHERE id=? AND lease_token=? AND status='sent')",
            values: [job.id, token],
          },
        ),
      ]);
    } catch (error: unknown) {
      if (!(error instanceof TelegramFailure))
        console.warn('telegram.diagnostic', {
          stage: 'unexpected_outbound_exception',
          jobId: job.id,
          kind: telegramExceptionKind(error),
        });
      const failure =
        error instanceof TelegramFailure
          ? error
          : new TelegramFailure('DELIVERY_UNKNOWN', false, true);
      if (failure.code === 'BOT_DISABLED') {
        const [disabledRoute] = await context.DB.select()
          .from(telegramRoutes)
          .where(eq(telegramRoutes.id, job.routeId));
        const assignment = job.assignmentId
          ? await context.env.DB.prepare(
              'SELECT case_id FROM assignments WHERE id=?',
            )
              .bind(job.assignmentId)
              .first<{ case_id: string }>()
          : null;
        await logDisabledBot(
          context,
          disabledRoute?.botId ?? 'unavailable',
          job.routeId,
          job.id,
          assignment?.case_id,
        );
      }
      const retry =
        failure.retryable && !failure.uncertain && job.attempts < MAX_ATTEMPTS;
      const status = retry ? 'pending' : 'failed';
      // Never persist raw Telegram errors or token-bearing URLs.
      await context.env.DB.batch([
        context.env.DB.prepare(
          "UPDATE telegram_outbound_jobs SET status=?,next_attempt_at=?,last_error_code=?,lease_until=NULL WHERE id=? AND lease_token=? AND status='sending'",
        ).bind(
          status,
          retry
            ? now + Math.max(backoff(job.attempts), failure.retryAfterMs)
            : null,
          failure.code,
          job.id,
          token,
        ),
        telegramAudit(
          context,
          job.messageType === 'assignment_dispatch'
            ? retry
              ? 'assignment.outbound_retry'
              : 'assignment.outbound_failed'
            : retry
              ? 'report.outbound_retry'
              : 'report.outbound_failed',
          job.id,
          { code: failure.code, attempt: job.attempts },
          {
            sql: 'EXISTS(SELECT 1 FROM telegram_outbound_jobs WHERE id=? AND lease_token=? AND status=?)',
            values: [job.id, token, status],
          },
        ),
      ]);
    }
  }
}
