import { z } from 'zod';
import { recognizeOcrBytes, OcrRecognitionError } from './bulk-ocr-engine';
import type { Context } from './context';
import { telegramFile } from './telegram-adapter';
import type { TelegramClient } from './telegram-client';
import { type TelegramUpdate, telegramUpdateSchema } from './telegram-contract';
import {
  confirmedOcrFields,
  isOcrWebhookAuthorized,
  parseOcrEdit,
} from './telegram-ocr-contract';

export interface ProductionOcrRuntime {
  base(env: Env, execution: ExecutionContext): Promise<Context>;
  actor(base: Context, userId: string): Promise<Context>;
  requirePermission(
    context: Context,
    permission:
      | 'case.create'
      | 'media.upload'
      | 'media.view'
      | 'telegram_route.manage'
      | 'case.view_all',
  ): unknown;
  client(context: Context, botId: string | null): Promise<TelegramClient>;
  create(
    context: Context,
    input: unknown,
  ): Promise<{ results: { status: string; caseId: string | null }[] }>;
}
export type OcrRoute = {
  id: string;
  bot_id: string | null;
  chat_id: string;
  topic_id: number | null;
  managed_by_user_id: string;
};
export type TelegramOcrJob = {
  id: string;
  route_id: string;
  actor_user_id: string;
  sender_id: string;
  message_id: number;
  file_id: string | null;
  image_hash: string | null;
  batch_id: string;
  fields_json: string | null;
  evidence_json: string | null;
  status:
    | 'pending'
    | 'recognizing'
    | 'ready'
    | 'creating'
    | 'created'
    | 'failed'
    | 'cancelled';
  version: number;
  notified_version: number;
  attempts: number;
  case_id: string | null;
  lease_token: string | null;
  lease_until: number | null;
  expires_at: number;
};
async function jsonUpdate(request: Request): Promise<TelegramUpdate> {
  const reader = request.body?.getReader();
  if (!reader) throw Error('NO_BODY');
  let length = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 1024 * 1024) {
      await reader.cancel();
      throw Error('BODY_LIMIT');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return telegramUpdateSchema.parse(JSON.parse(new TextDecoder().decode(all)));
}
async function routeById(env: Env, id: string) {
  return env.DB.prepare(
    "SELECT id,bot_id,chat_id,topic_id,managed_by_user_id FROM telegram_routes WHERE id=? AND is_active=1 AND route_type IN ('intake','intake_source') AND (bot_id IS NULL OR EXISTS(SELECT 1 FROM telegram_bots b WHERE b.id=telegram_routes.bot_id AND b.is_active=1)) AND NOT EXISTS(SELECT 1 FROM telegram_routes r WHERE r.chat_id=telegram_routes.chat_id AND coalesce(r.topic_id,0)=coalesce(telegram_routes.topic_id,0) AND r.route_type='collector_report' AND r.is_active=1)",
  )
    .bind(id)
    .first<OcrRoute>();
}
async function verifiedActor(
  base: Context,
  runtime: ProductionOcrRuntime,
  userId: string,
  sender: string,
) {
  if (base.env.TELEGRAM_OCR_REVIEW_MODE === 'backend') {
    const actor = await runtime.actor(base, userId);
    for (const permission of [
      'case.create',
      'media.upload',
      'media.view',
    ] as const)
      runtime.requirePermission(actor, permission);
    return actor;
  }
  const identity = await base.env.DB.prepare(
    'SELECT user_id FROM telegram_identities WHERE telegram_user_id=? AND is_active=1 AND user_id=?',
  )
    .bind(sender, userId)
    .first();
  if (!identity) throw Error('SENDER_DENIED');
  const actor = await runtime.actor(base, userId);
  for (const permission of [
    'case.create',
    'media.upload',
    'media.view',
  ] as const)
    runtime.requirePermission(actor, permission);
  return actor;
}
async function notify(
  context: Context,
  runtime: ProductionOcrRuntime,
  route: OcrRoute,
  job: TelegramOcrJob,
) {
  const client = await runtime.client(context, route.bot_id);
  if (context.env.TELEGRAM_OCR_REVIEW_MODE === 'backend') {
    await context.env.DB.prepare(
      'UPDATE telegram_ocr_jobs SET notified_version=? WHERE id=? AND version=?',
    )
      .bind(job.version, job.id, job.version)
      .run();
    return;
  }
  const fields: unknown = JSON.parse(job.fields_json ?? '{}');
  const valid = confirmedOcrFields(fields);
  const values = z
    .object({
      code: z.string().optional(),
      customerName: z.string().optional(),
      region: z.string().optional(),
    })
    .parse(fields);
  const text =
    job.status === 'created'
      ? `已確認並建立到後台。\n圖片訊息：${job.message_id}\n案件識別：${job.case_id}`
      : job.status === 'failed'
        ? `圖片訊息 ${job.message_id} 無法可靠辨識，沒有建立案件。\n可重新執行：/ocr_retry ${job.id}\n或人工填寫：/ocr_edit ${job.id} 代號|姓名|縣市`
        : `圖片訊息：${job.message_id}\n代號：${values.code || '請人工填寫'}\n姓名：${values.customerName || '請人工填寫'}\n地區：${values.region || '請人工填寫'}\n\n請對照這張原圖，確認三欄後再建立。雙引擎相符不代表保證正確。\n更正：/ocr_edit ${job.id} 代號|姓名|縣市`;
  await client.sendMessage({
    chatId: route.chat_id,
    topicId: route.topic_id,
    text,
    ...(job.status === 'ready' && valid.success
      ? {
          replyMarkup: {
            inline_keyboard: [
              [
                {
                  text: '已核對原圖，確認建立',
                  callback_data: `ocr:c:${job.id}:${job.version}`,
                },
              ],
              [
                {
                  text: '取消這筆',
                  callback_data: `ocr:x:${job.id}:${job.version}`,
                },
              ],
            ],
          },
        }
      : {}),
  });
  await context.env.DB.prepare(
    'UPDATE telegram_ocr_jobs SET notified_version=? WHERE id=? AND version=? AND status=?',
  )
    .bind(job.version, job.id, job.version, job.status)
    .run();
}
export async function handleTelegramOcr(
  request: Request,
  env: Env,
  execution: ExecutionContext,
  runtime: ProductionOcrRuntime,
): Promise<Response | null> {
  if (env.TELEGRAM_OCR_ENABLED !== 'true') return null;
  if (!(await isOcrWebhookAuthorized(env, request)))
    return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  let update: TelegramUpdate;
  try {
    update = await jsonUpdate(request.clone());
  } catch {
    return Response.json({ error: 'INVALID_UPDATE' }, { status: 400 });
  }
  const message = update.message ?? update.callback_query?.message;
  const callback = update.callback_query;
  const command = update.message?.text ?? '';
  const ours =
    callback?.data?.startsWith('ocr:') ||
    /^\/ocr_(edit|retry)(?:@|\s)/.test(command);
  const file = telegramFile(update);
  if (!message || (!ours && !file)) return null;
  const sender = String(callback?.from.id ?? update.message?.from?.id ?? '');
  const routes = await env.DB.prepare(
    "SELECT id FROM telegram_routes WHERE chat_id=? AND coalesce(topic_id,0)=? AND is_active=1 AND route_type IN ('intake','intake_source') LIMIT 2",
  )
    .bind(String(message.chat.id), message.message_thread_id ?? 0)
    .all<{ id: string }>();
  if (routes.results.length !== 1)
    return ours
      ? Response.json({ error: 'SOURCE_DENIED' }, { status: 403 })
      : null;
  const route = await routeById(env, routes.results[0].id);
  if (!route)
    return ours
      ? Response.json({ error: 'SOURCE_DENIED' }, { status: 403 })
      : null;
  const base = await runtime.base(env, execution);
  if (env.TELEGRAM_OCR_REVIEW_MODE === 'backend' && ours)
    return Response.json({ ok: true, code: 'REVIEW_IN_ADMIN' });
  const identity =
    env.TELEGRAM_OCR_REVIEW_MODE === 'backend'
      ? { user_id: route.managed_by_user_id }
      : await env.DB.prepare(
          'SELECT user_id FROM telegram_identities WHERE telegram_user_id=? AND is_active=1 AND user_id IS NOT NULL',
        )
          .bind(sender)
          .first<{ user_id: string }>();
  if (!identity)
    return Response.json({ ok: true, code: 'OCR_SENDER_NOT_PROVISIONED' });
  let actor: Context;
  try {
    actor = await verifiedActor(base, runtime, identity.user_id, sender);
  } catch {
    return Response.json({ ok: true, code: 'OCR_PERMISSION_DENIED' });
  }
  const client = await runtime.client(actor, route.bot_id);
  if (callback && ours) {
    const parsed = callback.data?.match(/^ocr:([cx]):([a-f0-9-]{36}):(\d+)$/);
    await client.answerCallbackQuery(callback.id, '正在檢查確認資料');
    if (!parsed) return Response.json({ ok: true });
    const job = await env.DB.prepare(
      'SELECT * FROM telegram_ocr_jobs WHERE id=? AND route_id=? AND sender_id=? AND actor_user_id=? AND expires_at>?',
    )
      .bind(parsed[2], route.id, sender, identity.user_id, Date.now())
      .first<TelegramOcrJob>();
    if (!job || job.version !== Number(parsed[3]))
      return Response.json({ ok: true, code: 'STALE_CONFIRMATION' });
    if (parsed[1] === 'x') {
      await env.DB.prepare(
        "UPDATE telegram_ocr_jobs SET status='cancelled',file_id=NULL,fields_json=NULL,evidence_json=NULL,version=version+1,updated_at=? WHERE id=? AND status='ready' AND version=?",
      )
        .bind(Date.now(), job.id, job.version)
        .run();
      return Response.json({ ok: true });
    }
    if (job.status === 'created')
      return Response.json({ ok: true, code: 'ALREADY_CREATED' });
    if (
      job.status !== 'ready' ||
      !confirmedOcrFields(JSON.parse(job.fields_json ?? '{}')).success
    )
      return Response.json({ ok: true, code: 'NEEDS_REVIEW' });
    const claimed = await env.DB.prepare(
      "UPDATE telegram_ocr_jobs SET status='creating',updated_at=? WHERE id=? AND status='ready' AND version=? RETURNING id",
    )
      .bind(Date.now(), job.id, job.version)
      .first();
    if (claimed)
      execution.waitUntil(processTelegramOcrJobs(env, execution, runtime));
    return Response.json({ ok: true });
  }
  if (ours) {
    const edit = parseOcrEdit(command),
      retry = command.match(/^\/ocr_retry(?:@[\w]+)?\s+([a-f0-9-]{36})\s*$/);
    if (edit)
      await env.DB.prepare(
        "UPDATE telegram_ocr_jobs SET fields_json=?,status='ready',version=version+1,notified_version=-1,updated_at=? WHERE id=? AND route_id=? AND sender_id=? AND actor_user_id=? AND status IN ('ready','failed') AND expires_at>?",
      )
        .bind(
          JSON.stringify(edit.fields),
          Date.now(),
          edit.id,
          route.id,
          sender,
          identity.user_id,
          Date.now(),
        )
        .run();
    else if (retry)
      await env.DB.prepare(
        "UPDATE telegram_ocr_jobs SET status='pending',version=version+1,notified_version=-1,updated_at=? WHERE id=? AND route_id=? AND sender_id=? AND actor_user_id=? AND status='failed' AND attempts<3 AND expires_at>?",
      )
        .bind(
          Date.now(),
          retry[1],
          route.id,
          sender,
          identity.user_id,
          Date.now(),
        )
        .run();
    return Response.json({ ok: true });
  }
  if (!file || (file.size ?? 0) > 5 * 1024 * 1024)
    return Response.json({ ok: true, code: 'OCR_FILE_TOO_LARGE' });
  if (
    env.BULK_OCR_PRIVACY_APPROVED !== 'true' ||
    !env.GOOGLE_VISION_API_KEY ||
    !env.OPENAI_API_KEY ||
    !env.BULK_OCR_MODEL
  )
    return Response.json({ error: 'OCR_NOT_CONFIGURED' }, { status: 503 });
  const now = Date.now(),
    bucket = Math.floor(now / 60000) * 60000;
  const quota = await env.DB.prepare(
    'INSERT INTO rate_limit(id,key,count,last_request) VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN last_request<? THEN 1 ELSE count+1 END,last_request=excluded.last_request WHERE last_request<? OR count<20 RETURNING count',
  )
    .bind(
      `tg-ocr:${identity.user_id}`,
      `tg-ocr:${identity.user_id}`,
      bucket,
      bucket,
      bucket,
    )
    .first();
  if (!quota) return Response.json({ ok: true, code: 'OCR_RATE_LIMIT' });
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO telegram_ocr_jobs(id,update_key,route_id,actor_user_id,sender_id,message_id,file_id,batch_id,status,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?) ON CONFLICT(update_key) DO NOTHING",
  )
    .bind(
      id,
      `${route.bot_id ?? 'legacy'}:${update.update_id}`,
      route.id,
      identity.user_id,
      sender,
      update.message?.message_id ?? message.message_id,
      file.fileId,
      crypto.randomUUID(),
      now,
      now,
      now + 86400000,
    )
    .run();
  return Response.json({ ok: true, code: 'OCR_QUEUED' });
}
export async function processTelegramOcrJobs(
  env: Env,
  execution: ExecutionContext,
  runtime: ProductionOcrRuntime,
) {
  if (env.TELEGRAM_OCR_ENABLED !== 'true') return;
  const base = await runtime.base(env, execution),
    now = Date.now();
  await env.DB.prepare(
    "UPDATE telegram_ocr_jobs SET status='failed',lease_token=NULL,lease_until=NULL,version=version+1,notified_version=-1 WHERE status='recognizing' AND lease_until<?",
  )
    .bind(now)
    .run();
  await env.DB.prepare(
    'UPDATE telegram_ocr_jobs SET file_id=NULL,evidence_json=NULL WHERE expires_at<?',
  )
    .bind(now)
    .run();
  const jobs = await env.DB.prepare(
    "SELECT * FROM telegram_ocr_jobs WHERE status IN ('pending','creating','ready','failed','created') AND (status='creating' OR expires_at>?) AND (status IN ('pending','creating') OR notified_version<>version) ORDER BY CASE status WHEN 'creating' THEN 0 ELSE 1 END,updated_at LIMIT 2",
  )
    .bind(now)
    .all<TelegramOcrJob>();
  for (const job of jobs.results) {
    const route = await routeById(env, job.route_id);
    if (!route) {
      await env.DB.prepare(
        "UPDATE telegram_ocr_jobs SET status='cancelled',file_id=NULL,fields_json=NULL,evidence_json=NULL,updated_at=? WHERE id=? AND status<>'created'",
      )
        .bind(Date.now(), job.id)
        .run();
      continue;
    }
    try {
      const actor = await verifiedActor(
        base,
        runtime,
        job.actor_user_id,
        job.sender_id,
      );
      if (job.status === 'pending') {
        const lease = crypto.randomUUID();
        const won = await env.DB.prepare(
          "UPDATE telegram_ocr_jobs SET status='recognizing',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=? AND status='pending' RETURNING id",
        )
          .bind(lease, Date.now() + 120000, job.id)
          .first();
        if (!won) continue;
        try {
          if (
            !job.file_id ||
            !env.GOOGLE_VISION_API_KEY ||
            !env.OPENAI_API_KEY ||
            !env.BULK_OCR_MODEL ||
            env.BULK_OCR_PRIVACY_APPROVED !== 'true'
          )
            throw Error('OCR_CONFIGURATION');
          const client = await runtime.client(actor, route.bot_id),
            downloaded = await client.downloadFile(job.file_id);
          if (downloaded.bytes.byteLength > 5 * 1024 * 1024)
            throw Error('IMAGE_LIMIT');
          const { detectedImageType } = await import('./case-media-management');
          const bytes = new Uint8Array(downloaded.bytes),
            type = detectedImageType(bytes);
          if (!type) throw Error('INVALID_IMAGE');
          const output = await recognizeOcrBytes(
            {
              GOOGLE_VISION_API_KEY: env.GOOGLE_VISION_API_KEY,
              OPENAI_API_KEY: env.OPENAI_API_KEY,
              BULK_OCR_MODEL: env.BULK_OCR_MODEL,
            },
            bytes,
            type,
          );
          const values = Object.fromEntries(
            Object.entries(output.fields).map(([key, field]) => [
              key,
              field.value,
            ]),
          );
          const autoCreate = env.TELEGRAM_OCR_AUTO_CREATE === 'true' && output.quality === 'readable' && ['code','customerName','region'].every(key => output.fields[key as keyof typeof output.fields].status === 'cross_checked') && confirmedOcrFields(values).success;
          await env.DB.prepare(
            "UPDATE telegram_ocr_jobs SET status=?,image_hash=?,fields_json=?,evidence_json=?,lease_token=NULL,lease_until=NULL,version=version+1,notified_version=-1,updated_at=? WHERE id=? AND status='recognizing' AND lease_token=?",
          )
            .bind(
              autoCreate ? 'creating' : 'ready',
              output.imageHash,
              JSON.stringify(values),
              JSON.stringify(output.fields),
              Date.now(),
              job.id,
              lease,
            )
            .run();
        } catch (error) {
          const code = error instanceof OcrRecognitionError ? error.diagnosticCode : error instanceof Error && ['OCR_CONFIGURATION','IMAGE_LIMIT','INVALID_IMAGE'].includes(error.message) ? error.message : 'TELEGRAM_DOWNLOAD_OR_PROCESSING_FAILED';
          await env.DB.prepare(
            "UPDATE telegram_ocr_jobs SET evidence_json=?,status='failed',lease_token=NULL,lease_until=NULL,version=version+1,notified_version=-1,updated_at=? WHERE id=? AND status='recognizing' AND lease_token=?",
          )
            .bind(JSON.stringify({diagnostic:{code}}), Date.now(), job.id, lease)
            .run();
        }
      } else if (job.status === 'creating') {
        const lease = crypto.randomUUID();
        const won = await env.DB.prepare(
          "UPDATE telegram_ocr_jobs SET lease_token=?,lease_until=? WHERE id=? AND status='creating' AND (lease_until IS NULL OR lease_until<?) RETURNING id",
        )
          .bind(lease, Date.now() + 60000, job.id, Date.now())
          .first();
        if (!won) continue;
        const fields = confirmedOcrFields(JSON.parse(job.fields_json ?? '{}'));
        if (!fields.success) throw Error('INVALID_CONFIRMED_FIELDS');
        const result = await runtime.create(actor, {
          batchId: job.batch_id,
          mode: 'new',
          formalDispatch: false,
          rows: [
            {
              ...fields.data,
              address: '',
              collector: '',
              imageCount: 0,
              duplicateOverride: false,
            },
          ],
        });
        const row = result.results[0];
        await env.DB.prepare(
          "UPDATE telegram_ocr_jobs SET status=?,case_id=?,lease_token=NULL,lease_until=NULL,version=version+1,notified_version=-1,updated_at=? WHERE id=? AND status='creating' AND lease_token=?",
        )
          .bind(
            row?.status === 'created' ? 'created' : 'failed',
            row?.caseId ?? null,
            Date.now(),
            job.id,
            lease,
          )
          .run();
      }
      const latest = await env.DB.prepare(
        'SELECT * FROM telegram_ocr_jobs WHERE id=?',
      )
        .bind(job.id)
        .first<TelegramOcrJob>();
      if (
        latest &&
        ['ready', 'failed', 'created'].includes(latest.status) &&
        latest.notified_version !== latest.version
      )
        await notify(actor, runtime, route, latest);
    } catch {
      await env.DB.prepare(
        'UPDATE telegram_ocr_jobs SET updated_at=? WHERE id=?',
      )
        .bind(Date.now(), job.id)
        .run();
    }
  }
  await env.DB.prepare(
    "DELETE FROM telegram_ocr_jobs WHERE expires_at<? AND status<>'creating'",
  )
    .bind(Date.now())
    .run();
}
