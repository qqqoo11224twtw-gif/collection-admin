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
import { type TelegramClient, TelegramFailure } from './telegram-client';
import {
  albumKey,
  backoff,
  MAX_ATTEMPTS,
  QUIET_PERIOD_MS,
  telegramUpdateSchema,
} from './telegram-contract';
import { processInstallmentUpdate } from './telegram-installments';
import { receiveTelegramMedia } from './telegram-media';
import { processOutbound, queueReportDestination } from './telegram-outbound';
import { processTelegramPayment } from './telegram-payments';
import { telegramPrincipal } from './telegram-principal';
import { processReportStatusCallback } from './telegram-report-status';
import { processReportCommand } from './telegram-reports';

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
  const reportRoutes = m
    ? await context.env.DB.prepare(
        "SELECT id,is_active FROM telegram_routes WHERE chat_id=? AND coalesce(topic_id,0)=? AND route_type='collector_report'",
      )
        .bind(String(m.chat.id), m.message_thread_id ?? 0)
        .all<{ id: string; is_active: number }>()
    : null;
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
    !replacementIntake
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
  const [route] = m
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
  return { id, duplicate: !inserted };
}
export async function telegramWebhook(context: Context, request: Request) {
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
    const result = await receiveTelegramUpdate(context, raw);
    return Response.json({ ok: true, duplicate: result.duplicate });
  } catch {
    return Response.json({ error: 'TEMPORARILY_UNAVAILABLE' }, { status: 503 });
  }
}
export async function processTelegramUpdates(
  base: Context,
  client: TelegramClient,
  now = Date.now(),
) {
  await base.env.DB.prepare(
    "UPDATE telegram_updates SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='processing' AND lease_until<=?",
  )
    .bind(now)
    .run();
  const pending = await base.env.DB.prepare(
    "SELECT id FROM telegram_updates WHERE status='pending' AND next_attempt_at<=? ORDER BY CASE WHEN json_type(payload,'$.callback_query') IS NOT NULL THEN 0 ELSE 1 END,next_attempt_at,CAST(id AS INTEGER) LIMIT 20",
  )
    .bind(now)
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
    try {
      const update = telegramUpdateSchema.parse(JSON.parse(row.payload));
      const m = update.message ?? update.callback_query?.message;
      if (!m) throw new TelegramFailure('UNSUPPORTED_UPDATE', false);
      const isReport = !!update.callback_query || !!m.text;
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
      if (!route) {
        await systemLog(base.env.DB, {
          category: 'telegram',
          event: 'ROUTE_NOT_FOUND',
          status: 'failed',
          level: 'warning',
          errorCode: 'ROUTE_NOT_FOUND',
        });
        throw new TelegramFailure('SOURCE_DENIED', false);
      }
      await systemLog(base.env.DB, {
        category: 'telegram',
        event: 'ROUTE_MATCHED',
        relatedRouteId: route.id,
        relatedCollectorId: route.collectorId,
      });
      const routeClient = await botClientForRoute(base, route.botId, client);
      actor = await telegramPrincipal(base, route.managedByUserId);
      let intakeId: string | null = row.intakeId;
      let reportId: string | null = row.reportId;
      let resultCode = 'INTAKE_CREATED';
      if (update.callback_query) {
        const result = await (update.callback_query.data?.startsWith('ip:')
          ? processInstallmentUpdate
          : processReportStatusCallback)(actor, update, route, routeClient);
        reportId = result.reportId;
        resultCode = result.code;
      } else if (m.text?.startsWith('/回報')) {
        const result = await processReportCommand(actor, update, route);
        reportId = result.reportId;
        resultCode = result.code;
      } else if (m.text) {
        const result =
          (await processTelegramPayment(actor, update, route, client)) ??
          (await processInstallmentUpdate(actor, update, route, client));
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
    }
  }
  await finalizeAlbums(base, now);
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
  // Repair the crash boundary between media/album completion and review creation.
  const drafts = await base.env.DB.prepare(
    "SELECT i.id,i.version,r.managed_by_user_id,MIN(t.id) AS update_id,MAX(t.attempts) AS attempts FROM intake_items i JOIN telegram_updates t ON t.intake_id=i.id LEFT JOIN telegram_albums a ON a.id=t.album_id JOIN telegram_routes r ON r.chat_id=CAST(json_extract(t.payload,'$.message.chat.id') AS TEXT) AND coalesce(r.topic_id,0)=coalesce(json_extract(t.payload,'$.message.message_thread_id'),0) AND r.route_type IN ('intake','intake_source') AND r.is_active=1 WHERE i.status IN ('received','processing') AND t.status='done' AND (a.id IS NULL OR a.finalized_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM telegram_updates pending WHERE pending.intake_id=i.id AND pending.status<>'done') AND NOT EXISTS(SELECT 1 FROM telegram_albums collecting WHERE collecting.intake_id=i.id AND collecting.finalized_at IS NULL) GROUP BY i.id LIMIT 20",
  ).all<{
    id: string;
    version: number;
    managed_by_user_id: string;
    update_id: string;
    attempts: number;
  }>();
  for (const draft of drafts.results) {
    try {
      await finalizeTelegramDraft(
        await telegramPrincipal(base, draft.managed_by_user_id),
        { id: draft.id, expectedVersion: draft.version },
      );
    } catch {
      const failed = draft.attempts >= MAX_ATTEMPTS;
      await base.env.DB.batch([
        base.env.DB.prepare(
          "UPDATE telegram_updates SET status=?,next_attempt_at=?,last_error_code='FINALIZE_RETRY' WHERE id=? AND status='done'",
        ).bind(
          failed ? 'failed' : 'pending',
          now + backoff(draft.attempts),
          draft.update_id,
        ),
        ...(failed
          ? [
              base.env.DB.prepare(
                "UPDATE intake_items SET status='failed',updated_at=?,version=version+1 WHERE id=? AND status IN ('received','processing')",
              ).bind(now, draft.id),
            ]
          : []),
        telegramAudit(
          base,
          failed ? 'telegram.processing_failed' : 'telegram.finalize_retry',
          draft.update_id,
          { intakeId: draft.id, code: 'FINALIZE_RETRY' },
        ),
      ]);
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
  await systemLog(context.env.DB, {
    category: 'scheduler',
    event: 'SCHEDULER_COMPLETED',
    durationMs: Date.now() - started,
  });
  return { processed: true };
}
