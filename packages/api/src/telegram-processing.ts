import { ORPCError } from '@orpc/server';
import {
  telegramAlbums,
  telegramRoutes,
  telegramUpdates,
} from '@saasflare-dev/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { queueAssignmentDispatch } from './assignment-outbound';
import type { Context } from './context';
import {
  enqueueImageExtraction,
  processImageExtractionJobs,
} from './image-extraction-service';
import { receiveFromAdapter } from './intake-contract';
import { processIntake } from './intake-resolver';
import { receiveIntake } from './intake-service';
import { imageExtractionProvider } from './openai-image-extraction';
import { cleanupSystemLogs, systemLog } from './system-log';
import {
  TelegramIntakeAdapter,
  telegramAudit,
  telegramFile,
} from './telegram-adapter';
import { botClientForRoute } from './telegram-bots';
import {
  type TelegramClient,
  TelegramFailure,
  telegramClient,
} from './telegram-client';
import {
  albumKey,
  backoff,
  MAX_ATTEMPTS,
  QUIET_PERIOD_MS,
  telegramUpdateSchema,
} from './telegram-contract';
import { handleTelegramId } from './telegram-id-command';

import { receiveTelegramMedia } from './telegram-media';
import {
  processOutbound,
  queueReportDestination,
  queueTelegramMessage,
} from './telegram-outbound';
import { processTelegramPayment } from './telegram-payments';
import { telegramPrincipal } from './telegram-principal';
import {
  processCollectionCallback,
  processCollectionCommand,
  processCollectionMedia,
  processDirectPaymentText,
} from './telegram-quick-collection';
import {
  bindReportMedia,
  cleanupReportMedia,
  receiveReportMedia,
} from './telegram-report-media';
import { processReportStatusCallback } from './telegram-report-status';
import {
  processReportCaseCallback,
  processReportCommand,
  processReportContent,
  queueStatusPrompt,
  validateReportMedia,
} from './telegram-reports';

async function finalizeTelegramDraft(
  context: Context,
  input: { id: string; expectedVersion: number },
) {
  const provider = imageExtractionProvider(context.env);
  return provider
    ? enqueueImageExtraction(context, input.id, provider)
    : processIntake(context, input);
}

async function boundedJson(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('INVALID');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65536) {
      await reader.cancel();
      throw new Error('SIZE');
    }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    data.set(c, offset);
    offset += c.length;
  }
  return JSON.parse(new TextDecoder().decode(data));
}
export async function receiveTelegramUpdate(
  context: Context,
  raw: unknown,
  now = Date.now(),
) {
  const update = telegramUpdateSchema.parse(raw);
  const id = String(update.update_id);
  const existing = await context.env.DB.prepare(
    'SELECT id FROM telegram_updates WHERE id=?',
  )
    .bind(id)
    .first();
  if (existing) {
    await telegramAudit(context, 'telegram.duplicate_ignored', id).run();
    return { id, duplicate: true };
  }
  const m = update.message ?? update.callback_query?.message;
  const hasMedia = !!(update.message?.photo || update.message?.document);
  const reportRoutes =
    m && hasMedia
      ? await context.env.DB.prepare(
          "SELECT id,is_active FROM telegram_routes WHERE chat_id=? AND coalesce(topic_id,0)=? AND route_type='collector_report'",
        )
          .bind(String(m.chat.id), m.message_thread_id ?? 0)
          .all<{ id: string; is_active: number }>()
      : null;
  const retiredRoute =
    m && hasMedia && !reportRoutes?.results.some((r) => r.is_active === 1)
      ? await context.env.DB.prepare(
          "SELECT id FROM telegram_routes WHERE chat_id=? AND coalesce(topic_id,0)=? AND route_type IN ('intake','intake_source') LIMIT 1",
        )
          .bind(String(m.chat.id), m.message_thread_id ?? 0)
          .first<{ id: string }>()
      : null;
  if (retiredRoute) {
    await context.env.DB.prepare(
      "INSERT INTO telegram_updates(id,payload,status,attempts,next_attempt_at,created_at,processed_at,result_code) VALUES(?,'{}','done',0,?,?,?,'TELEGRAM_INTAKE_DISABLED') ON CONFLICT(id) DO NOTHING",
    )
      .bind(id, now, now, now)
      .run();
    await systemLog(context.env.DB, {
      category: 'telegram',
      event: 'TELEGRAM_INTAKE_DISABLED',
      relatedRouteId: retiredRoute.id,
    });
    return { id, duplicate: false };
  }
  const replacementIntake =
    m &&
    reportRoutes?.results.length &&
    !reportRoutes.results.some((route) => route.is_active === 1)
      ? await context.env.DB.prepare(
          "SELECT id FROM telegram_routes WHERE chat_id=? AND coalesce(topic_id,0)=? AND route_type IN ('intake','intake_source') AND is_active=1",
        )
          .bind(String(m.chat.id), m.message_thread_id ?? 0)
          .first()
      : null;
  if (
    update.message &&
    (update.message.photo || update.message.document) &&
    reportRoutes?.results.length &&
    !replacementIntake &&
    !reportRoutes.results.some((r) => r.is_active === 1)
  ) {
    await context.env.DB.prepare(
      "INSERT INTO telegram_updates(id,payload,status,attempts,next_attempt_at,created_at,processed_at,result_code) VALUES(?,'{}','done',0,?,?,?,'REPORT_MEDIA_IGNORED') ON CONFLICT(id) DO NOTHING",
    )
      .bind(id, now, now, now)
      .run();
    await systemLog(context.env.DB, {
      category: 'telegram',
      event: 'REPORT_MEDIA_IGNORED',
    });
    return { id, duplicate: false };
  }
  const [route] =
    m && hasMedia
      ? await context.DB.select()
          .from(telegramRoutes)
          .where(
            and(
              eq(telegramRoutes.chatId, String(m.chat.id)),
              sql`coalesce(${telegramRoutes.topicId},0)=${m.message_thread_id ?? 0}`,
              eq(telegramRoutes.isActive, true),
              inArray(
                telegramRoutes.routeType,
                update.callback_query || m.text?.startsWith('/回報')
                  ? ['collector_report']
                  : ['intake', 'intake_source'],
              ),
            ),
          )
          .limit(1)
      : [];
  const reportMediaRoute = reportRoutes?.results.find((r) => r.is_active === 1);
  if (reportMediaRoute)
    await receiveReportMedia(context, update, reportMediaRoute.id, now);
  if (
    route &&
    !reportMediaRoute &&
    ['intake', 'intake_source'].includes(route.routeType)
  ) {
    await context.env.DB.prepare(
      "INSERT INTO telegram_updates(id,payload,status,attempts,next_attempt_at,created_at,processed_at,result_code) VALUES(?,'{}','done',0,?,?,?,'TELEGRAM_INTAKE_DISABLED') ON CONFLICT(id) DO NOTHING",
    )
      .bind(id, now, now, now)
      .run();
    await systemLog(context.env.DB, {
      category: 'telegram',
      event: 'TELEGRAM_INTAKE_DISABLED',
      relatedRouteId: route.id,
    });
    return { id, duplicate: false };
  }
  const grouping =
    telegramFile(update) &&
    route &&
    ['intake', 'intake_source'].includes(route.routeType)
      ? albumKey(update)
      : null;
  const statements: D1PreparedStatement[] = [];
  if (grouping && route)
    statements.push(
      context.env.DB.prepare(
        'INSERT INTO telegram_albums(id,route_id,due_at,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING',
      ).bind(grouping, route.id, now + QUIET_PERIOD_MS, now),
    );
  statements.push(
    context.env.DB.prepare(
      "INSERT INTO telegram_updates(id,payload,status,attempts,next_attempt_at,album_id,created_at) VALUES(?,?,'pending',0,?,?,?) ON CONFLICT(id) DO NOTHING",
    ).bind(id, JSON.stringify(update), now, grouping, now),
  );
  // Duplicate delivery must not extend the quiet period. changes() refers to the preceding update insert.
  if (grouping)
    statements.push(
      context.env.DB.prepare(
        'UPDATE telegram_albums SET due_at=?,finalized_at=NULL,version=version+1 WHERE id=? AND changes()=1',
      ).bind(now + QUIET_PERIOD_MS, grouping),
    );
  statements.push(
    telegramAudit(
      context,
      'telegram.update_received',
      id,
      {},
      {
        sql: "EXISTS(SELECT 1 FROM telegram_updates WHERE id=? AND created_at=?) AND NOT EXISTS(SELECT 1 FROM audit_logs WHERE entity_id=? AND action='telegram.update_received')",
        values: [id, now, id],
      },
    ),
  );
  const results = await context.env.DB.batch(statements);
  const inserted = results[grouping ? 1 : 0].meta.changes === 1;
  if (!inserted)
    await telegramAudit(context, 'telegram.duplicate_ignored', id).run();
  return { id, duplicate: !inserted, reportMedia: !!reportMediaRoute };
}
export async function telegramWebhook(
  context: Context,
  request: Request,
  suppliedClient?: TelegramClient,
) {
  const started = performance.now();
  const timing = {
    webhook_received_at: Date.now(),
    route_lookup_ms: 0,
    case_lookup_ms: 0,
    conversation_write_ms: 0,
    telegram_send_ms: 0,
  };
  context = { ...context, telegramTiming: timing };
  if (
    !['fake', 'live'].includes(context.env.TELEGRAM_MODE ?? '') ||
    !context.env.TELEGRAM_WEBHOOK_SECRET
  )
    return Response.json({ error: 'UNAVAILABLE' }, { status: 503 });
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(secret)),
    crypto.subtle.digest(
      'SHA-256',
      encoder.encode(context.env.TELEGRAM_WEBHOOK_SECRET),
    ),
  ]);
  let mismatch = 0;
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i];
  if (mismatch)
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  let raw: unknown;
  try {
    raw = await boundedJson(request);
    telegramUpdateSchema.parse(raw);
  } catch {
    return Response.json({ error: 'INVALID_UPDATE' }, { status: 400 });
  }
  try {
    const result =
      (await handleTelegramId(context, telegramUpdateSchema.parse(raw))) ??
      (await receiveTelegramUpdate(context, raw));
    const update = telegramUpdateSchema.parse(raw);
    const interactive =
      !!update.callback_query ||
      !!update.message?.text ||
      !!update.message?.caption?.trim().match(/^\/(回報|收款)(?:@|\s|$)/u) ||
      ('reportMedia' in result && result.reportMedia);
    if (
      interactive &&
      !result.duplicate &&
      !update.message?.text?.trim().match(/^\/id(?:@[A-Za-z0-9_]+)?$/i)
    )
      await processTelegramUpdates(
        context,
        suppliedClient ?? telegramClient(context.env),
        Date.now(),
        String(update.update_id),
      );
    if (interactive) {
      const durations = Object.fromEntries(
        Object.entries(timing).map(([key, value]) => [key, Math.round(value)]),
      );
      const total = Math.round(performance.now() - started);
      // Fixed timing fields only: never include message text, payload, headers or URLs.
      console.info(
        JSON.stringify({
          event: 'TELEGRAM_INTERACTION_LATENCY',
          update_id: update.update_id,
          ...durations,
          total_response_ms: total,
          duplicate: result.duplicate,
        }),
      );
      const { webhook_received_at: _received, ...stageDurations } = durations;
      const log = systemLog(context.env.DB, {
        category: 'telegram',
        event: 'TELEGRAM_INTERACTION_LATENCY',
        durationMs: total,
        safeMessage: JSON.stringify(stageDurations),
      });
      if (context.defer) context.defer(log);
      else await log;
    }
    return Response.json({ ok: true, duplicate: result.duplicate });
  } catch {
    return Response.json({ error: 'TEMPORARILY_UNAVAILABLE' }, { status: 503 });
  }
}
export async function processTelegramUpdates(
  base: Context,
  client: TelegramClient,
  now = Date.now(),
  onlyUpdateId?: string,
) {
  if (!onlyUpdateId)
    await base.env.DB.prepare(
      "UPDATE telegram_updates SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='processing' AND lease_until<=?",
    )
      .bind(now)
      .run();
  const pending = await base.env.DB.prepare(
    onlyUpdateId
      ? "SELECT id FROM telegram_updates WHERE id=? AND status='pending' AND next_attempt_at<=?"
      : "SELECT id FROM telegram_updates WHERE status='pending' AND next_attempt_at<=? ORDER BY CASE WHEN json_type(payload,'$.callback_query') IS NOT NULL THEN 0 ELSE 1 END,next_attempt_at,CAST(id AS INTEGER) LIMIT 20",
  )
    .bind(...(onlyUpdateId ? [onlyUpdateId, now] : [now]))
    .all<{ id: string }>();
  for (const candidate of pending.results) {
    const token = crypto.randomUUID();
    const claim = await base.env.DB.prepare(
      "UPDATE telegram_updates SET status='processing',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=? AND status='pending' AND next_attempt_at<=?",
    )
      .bind(token, Math.max(now, Date.now()) + 120000, candidate.id, now)
      .run();
    if (claim.meta.changes !== 1) continue;
    const [row] = await base.DB.select()
      .from(telegramUpdates)
      .where(eq(telegramUpdates.id, candidate.id));
    let actor = base;
    let replyRoute: typeof telegramRoutes.$inferSelect | null = null;
    let replyClient: TelegramClient | null = null;
    try {
      const update = telegramUpdateSchema.parse(JSON.parse(row.payload));
      const m = update.message ?? update.callback_query?.message;
      if (!m) throw new TelegramFailure('UNSUPPORTED_UPDATE', false);
      const reportMedia = await base.env.DB.prepare(
        'SELECT route_id,conversation_id FROM telegram_report_media WHERE id=?',
      )
        .bind(row.id)
        .first<{ route_id: string; conversation_id: string | null }>();
      const isReport =
        !!update.callback_query ||
        !!m.text ||
        !!m.caption?.trim().match(/^\/(回報|收款)(?:@|\s|$)/u) ||
        !!reportMedia;
      const routeStarted = performance.now();
      const [route] = await base.DB.select()
        .from(telegramRoutes)
        .where(
          and(
            eq(telegramRoutes.chatId, String(m.chat.id)),
            sql`coalesce(${telegramRoutes.topicId},0)=${m.message_thread_id ?? 0}`,
            eq(telegramRoutes.isActive, true),
            inArray(
              telegramRoutes.routeType,
              isReport ? ['collector_report'] : ['intake', 'intake_source'],
            ),
          ),
        )
        .limit(1);
      if (base.telegramTiming)
        base.telegramTiming.route_lookup_ms += performance.now() - routeStarted;
      if (!route) {
        await systemLog(base.env.DB, {
          category: 'telegram',
          event: 'ROUTE_NOT_FOUND',
          status: 'failed',
          level: 'warning',
          errorCode: 'ROUTE_NOT_FOUND',
        });
        if ((m.text ?? m.caption)?.trim().match(/^\/(回報|收款)(?:@|\s|$)/u)) {
          try {
            await client.sendMessage({
              chatId: String(m.chat.id),
              topicId: m.message_thread_id ?? null,
              text: '此群組或 Topic 尚未設定有效回報群組，請聯絡管理員。',
            });
          } catch {
            /* Do not retry an uncertain configuration-error reply. */
          }
        }
        throw new TelegramFailure('SOURCE_DENIED', false);
      }
      if (['intake', 'intake_source'].includes(route.routeType))
        throw new TelegramFailure('TELEGRAM_INTAKE_DISABLED', false);
      const routeLog = systemLog(base.env.DB, {
        category: 'telegram',
        event: 'ROUTE_MATCHED',
        relatedRouteId: route.id,
        relatedCollectorId: route.collectorId,
      });
      if (onlyUpdateId && base.defer) base.defer(routeLog);
      else await routeLog;
      const routeClient = await botClientForRoute(base, route.botId, client);
      if (reportMedia && reportMedia.route_id !== route.id)
        throw new TelegramFailure('ROUTE_CHANGED', false);
      replyRoute = route;
      replyClient = routeClient;
      // Keep the route-manager guard; the report service reuses this verified
      // actor when it is also the collector's route service identity.
      actor = await telegramPrincipal(base, route.managedByUserId);
      if (onlyUpdateId) {
        actor = {
          ...actor,
          telegramReply: async (key) => {
            await processOutbound(base, routeClient, Date.now(), key, route);
          },
        };
        if (update.callback_query) {
          try {
            await routeClient.answerCallbackQuery(update.callback_query.id, '');
          } catch {
            /* Callback acknowledgement must not abort a valid business transition. */
          }
        }
      }
      let intakeId: string | null = row.intakeId;
      let reportId: string | null = row.reportId;
      let resultCode = 'INTAKE_CREATED';
      if (update.callback_query) {
        const result = await (update.callback_query.data?.startsWith('pc:') ||
          update.callback_query.data?.startsWith('pp:')
          ? processCollectionCallback
          : update.callback_query.data?.startsWith('rc:') ||
              update.callback_query.data?.startsWith('rp:')
            ? processReportCaseCallback
            : processReportStatusCallback)(actor, update, route, routeClient);
        reportId = result.reportId;
        resultCode = result.code;
      } else if ((m.text ?? m.caption)?.trim().match(/^\/收款(?:@|\s|$)/u)) {
        const result = await processCollectionCommand(actor, update, route);
        reportId = result.reportId;
        resultCode = result.code;
      } else if ((m.text ?? m.caption)?.trim().startsWith('/回報')) {
        const result = await processReportCommand(actor, update, route);
        reportId = result.reportId;
        resultCode = result.code;
      } else if (reportMedia) {
        const collectionMedia = await processCollectionMedia(
          actor,
          update,
          route,
          reportMedia.conversation_id,
        );
        if (collectionMedia) {
          reportId = collectionMedia.reportId;
          resultCode = collectionMedia.code;
        } else {
          const conv = reportMedia.conversation_id
            ? await base.env.DB.prepare(
                'SELECT id,stage,expires_at FROM telegram_report_conversations WHERE id=? AND route_id=?',
              )
                .bind(reportMedia.conversation_id, route.id)
                .first<{ id: string; stage: string; expires_at: number }>()
            : await base.env.DB.prepare(
                'SELECT c.id,c.stage,c.expires_at FROM telegram_report_conversations c JOIN telegram_report_media m ON m.conversation_id=c.id WHERE m.route_id=? AND m.media_group_id IS NOT NULL AND m.media_group_id=? LIMIT 1',
              )
                .bind(route.id, m.media_group_id ?? null)
                .first<{ id: string; stage: string; expires_at: number }>();
          if (
            conv &&
            ['selecting', 'content', 'submitting', 'status'].includes(
              conv.stage,
            ) &&
            conv.expires_at > Date.now()
          ) {
            const verified = await validateReportMedia(
              actor,
              update,
              route,
              conv.id,
            );
            if (!verified) {
              await base.env.DB.prepare(
                'UPDATE telegram_report_media SET accepted_at=0 WHERE id=? AND accepted_at IS NULL',
              )
                .bind(row.id)
                .run();
              throw new TelegramFailure('REPORT_MEDIA_DENIED', false);
            }
            await bindReportMedia(actor, update, route.id, conv.id);
            const result = m.caption
              ? await processReportContent(
                  actor,
                  { ...update, message: { ...m, text: m.caption } },
                  route,
                )
              : null;
            reportId = result?.reportId ?? verified.report_id;
            resultCode = result?.code ?? 'REPORT_MEDIA_RECEIVED';
            await telegramAudit(
              actor,
              'telegram.report_media_received',
              row.id,
              { reportId },
              {
                sql: "NOT EXISTS(SELECT 1 FROM audit_logs WHERE entity_id=? AND action='telegram.report_media_received')",
                values: [row.id],
              },
            ).run();
            if (verified.report_id)
              await queueStatusPrompt(
                actor,
                route,
                verified.report_id,
                routeClient,
              );
          } else {
            if (conv && conv.expires_at <= Date.now()) {
              await queueTelegramMessage(
                actor,
                route,
                `report-expired:${row.id}`,
                '回報已逾時失敗，請重新輸入 /回報。',
              );
            }
            await base.env.DB.prepare(
              'UPDATE telegram_report_media SET accepted_at=0 WHERE id=? AND accepted_at IS NULL',
            )
              .bind(row.id)
              .run();
            resultCode = 'REPORT_MEDIA_NO_ACTIVE_DRAFT';
          }
        }
      } else if (m.text) {
        const result = (await processDirectPaymentText(actor, update, route)) ??
          (await processReportContent(actor, update, route)) ??
          (await processTelegramPayment(actor, update, route, routeClient)) ?? {
            code: 'REPORT_NO_ACTIVE_DRAFT',
            reportId: null,
          };
        reportId = result.reportId;
        resultCode = result.code;
      } else {
        if (!telegramFile(update))
          throw new TelegramFailure('UNSUPPORTED_MEDIA', false);
        const adapter = new TelegramIntakeAdapter();
        if (row.albumId) {
          const [album] = await base.DB.select()
            .from(telegramAlbums)
            .where(eq(telegramAlbums.id, row.albumId));
          if (!album || album.routeId !== route.id)
            throw new TelegramFailure('ALBUM_ROUTE_CHANGED', false);
          const normalized = await adapter.normalize(update);
          const receipt = await receiveIntake(actor, {
            ...normalized,
            externalId: `album:${row.albumId}`,
            dedupeKey: `telegram-album:${row.albumId}`,
          });
          intakeId = receipt.id;
          await base.env.DB.prepare(
            'UPDATE telegram_albums SET intake_id=? WHERE id=? AND (intake_id IS NULL OR intake_id=?)',
          )
            .bind(intakeId, row.albumId, intakeId)
            .run();
        } else {
          const receipt = await receiveFromAdapter(adapter, update, {
            receive: (input) => receiveIntake(actor, input),
          });
          intakeId = receipt.id;
        }
        await base.env.DB.batch([
          base.env.DB.prepare(
            "UPDATE telegram_updates SET intake_id=? WHERE id=? AND lease_token=? AND status='processing'",
          ).bind(intakeId, row.id, token),
          telegramAudit(
            actor,
            'telegram.intake_created',
            row.id,
            { intakeId },
            {
              sql: "NOT EXISTS(SELECT 1 FROM audit_logs WHERE entity_id=? AND action='telegram.intake_created')",
              values: [row.id],
            },
          ),
        ]);
        await receiveTelegramMedia(actor, update, intakeId, routeClient, token);
      }
      await base.env.DB.prepare(
        "UPDATE telegram_updates SET status='done',report_id=?,result_code=?,processed_at=?,last_error_code=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND status='processing'",
      )
        .bind(reportId, resultCode, now, row.id, token)
        .run();
      if (reportMedia)
        await base.env.DB.prepare(
          "UPDATE telegram_updates SET payload='{}' WHERE id=? AND status='done'",
        )
          .bind(row.id)
          .run();
      if (intakeId && !row.albumId) {
        const r = await base.env.DB.prepare(
          'SELECT version,status FROM intake_items WHERE id=?',
        )
          .bind(intakeId)
          .first<{ version: number; status: string }>();
        if (r && ['received', 'processing'].includes(r.status))
          await finalizeTelegramDraft(actor, {
            id: intakeId,
            expectedVersion: r.version,
          });
      }
    } catch (error: unknown) {
      const failure =
        error instanceof TelegramFailure
          ? error
          : new TelegramFailure(
              error instanceof ORPCError &&
                ['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND'].includes(error.code)
                ? 'PERMISSION_DENIED'
                : 'PROCESSING_RETRY',
              !(
                error instanceof ORPCError &&
                ['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND'].includes(error.code)
              ),
            );
      const retry = failure.retryable && row.attempts < MAX_ATTEMPTS;
      await base.env.DB.batch([
        base.env.DB.prepare(
          'UPDATE telegram_updates SET status=?,next_attempt_at=?,last_error_code=?,lease_until=NULL WHERE id=? AND lease_token=?',
        ).bind(
          retry ? 'pending' : 'failed',
          now + Math.max(backoff(row.attempts), failure.retryAfterMs),
          failure.code,
          row.id,
          token,
        ),
        telegramAudit(
          actor,
          retry ? 'telegram.processing_retry' : 'telegram.processing_failed',
          row.id,
          { code: failure.code, attempt: row.attempts },
          {
            sql: 'EXISTS(SELECT 1 FROM telegram_updates WHERE id=? AND lease_token=?)',
            values: [row.id, token],
          },
        ),
      ]);
      if (
        onlyUpdateId &&
        failure.code === 'PERMISSION_DENIED' &&
        replyRoute &&
        replyClient
      ) {
        const target = replyRoute,
          delivery = replyClient;
        await queueTelegramMessage(
          {
            ...base,
            telegramReply: async (key) => {
              await processOutbound(base, delivery, Date.now(), key, target);
            },
          },
          target,
          `command-reply:${row.id}`,
          '目前無法處理回報，請聯絡管理員確認群組與操作權限。',
        );
      }
    }
  }
  if (onlyUpdateId) return;
  // Legacy intake albums are retained without finalization or AI processing.
  // Repair only already committed manual confirmations, without re-applying status.
  const completed = await base.env.DB.prepare(
    "SELECT r.id FROM reports r WHERE r.source='telegram' AND r.workflow_status='completed' AND r.callback_token IS NOT NULL AND EXISTS(SELECT 1 FROM telegram_routes tr WHERE tr.route_type IN ('business_report','report_destination') AND tr.is_active=1 AND (tr.collector_id IS NULL OR tr.collector_id=r.collector_id) AND NOT EXISTS(SELECT 1 FROM telegram_outbound_jobs j WHERE j.dedupe_key='report-destination:'||r.id||':'||tr.id)) LIMIT 20",
  ).all<{ id: string }>();
  for (const report of completed.results) {
    try {
      await queueReportDestination(base, report.id);
    } catch {
      /* A durable completed report is retried on the next scheduler pass. */
    }
  }
}

export async function finalizeAlbums(base: Context, now = Date.now()) {
  const albums = await base.DB.select()
    .from(telegramAlbums)
    .where(
      and(
        sql`${telegramAlbums.dueAt}<=${now}`,
        sql`${telegramAlbums.finalizedAt} IS NULL`,
      ),
    )
    .limit(20);
  for (const album of albums) {
    if (!album.intakeId) continue;
    const incomplete = await base.env.DB.prepare(
      "SELECT id FROM telegram_updates WHERE album_id=? AND status<>'done' LIMIT 1",
    )
      .bind(album.id)
      .first();
    if (incomplete) continue;
    const [route] = await base.DB.select()
      .from(telegramRoutes)
      .where(
        and(
          eq(telegramRoutes.id, album.routeId),
          eq(telegramRoutes.isActive, true),
        ),
      );
    if (!route) continue;
    const context = await telegramPrincipal(base, route.managedByUserId);
    const result = await base.env.DB.batch([
      base.env.DB.prepare(
        "UPDATE telegram_albums SET finalized_at=? WHERE id=? AND version=? AND finalized_at IS NULL AND due_at<=? AND NOT EXISTS(SELECT 1 FROM telegram_updates WHERE album_id=? AND status<>'done')",
      ).bind(now, album.id, album.version, now, album.id),
      telegramAudit(
        context,
        'telegram.album_finalized',
        album.id,
        { intakeId: album.intakeId },
        {
          sql: "EXISTS(SELECT 1 FROM telegram_albums WHERE id=? AND finalized_at=?) AND NOT EXISTS(SELECT 1 FROM audit_logs WHERE entity_id=? AND action='telegram.album_finalized')",
          values: [album.id, now, album.id],
        },
      ),
    ]);
    if (result[0].meta.changes) {
      const row = await base.env.DB.prepare(
        'SELECT version,status FROM intake_items WHERE id=?',
      )
        .bind(album.intakeId)
        .first<{ version: number; status: string }>();
      if (row && ['received', 'processing'].includes(row.status)) {
        try {
          await finalizeTelegramDraft(context, {
            id: album.intakeId,
            expectedVersion: row.version,
          });
        } catch {
          /* The durable update recovery pass schedules bounded retries. */
        }
      }
    }
  }
}
export async function runTelegramProcessing(
  context: Context,
  client: TelegramClient,
  now = Date.now(),
) {
  const started = Date.now();
  const missing = await context.env.DB.prepare(
    "SELECT a.id FROM assignments a JOIN cases c ON c.id=a.case_id WHERE a.unassigned_at IS NULL AND a.record_type='assignment' AND c.voided_at IS NULL AND NOT EXISTS(SELECT 1 FROM telegram_outbound_jobs j WHERE j.assignment_id=a.id) AND EXISTS(SELECT 1 FROM telegram_routes r WHERE r.collector_id=a.collector_id AND r.route_type IN ('collector_dispatch','collector') AND r.is_active=1 AND (r.bot_id IS NULL OR EXISTS(SELECT 1 FROM telegram_bots b WHERE b.id=r.bot_id AND b.is_active=1))) LIMIT 20",
  ).all<{ id: string }>();
  for (const row of missing.results)
    await queueAssignmentDispatch(context, row.id);
  await processTelegramUpdates(context, client, now);
  await processOutbound(context, client, now);
  const provider = imageExtractionProvider(context.env);
  if (provider) await processImageExtractionJobs(context, provider, now);
  await cleanupSystemLogs(context.env.DB, now);
  await cleanupReportMedia(context, now);
  await systemLog(context.env.DB, {
    category: 'scheduler',
    event: 'SCHEDULER_COMPLETED',
    durationMs: Date.now() - started,
  });
  return { processed: true };
}
