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
  attach?(context: Context, caseId: string, uploadKey: string, bytes: Uint8Array, mediaType: string): Promise<unknown>;
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
async function attachJobImage(env: Env, actor: Context, runtime: ProductionOcrRuntime, route: OcrRoute, job: TelegramOcrJob, caseId: string) {
  if(!job.file_id || !runtime.attach)throw Error('SOURCE_IMAGE_UNAVAILABLE');
  const client=await runtime.client(actor,route.bot_id),downloaded=await client.downloadFile(job.file_id);
  const bytes=new Uint8Array(downloaded.bytes);
  const {detectedImageType,sha256}=await import('./case-media-management');
  const type=detectedImageType(bytes);
  if(!type || !bytes.length || bytes.length>5*1024*1024)throw Error('INVALID_IMAGE');
  if(job.image_hash && await sha256(Uint8Array.from(bytes).buffer)!==job.image_hash)throw Error('SOURCE_IMAGE_CHANGED');
  await runtime.attach(actor,caseId,job.batch_id,bytes,type);
}
async function attachReport(env: Env, route: OcrRoute, actorId: string, sender: string, jobKey: string, album: string | undefined) {
  const job = await env.DB.prepare('SELECT id FROM telegram_ocr_jobs WHERE update_key=?').bind(jobKey).first<{id:string}>();
  if(!job || await env.DB.prepare('SELECT job_id FROM telegram_ocr_report_items WHERE job_id=?').bind(job.id).first()) return null;
  const now=Date.now(), group=album ? 'album:'+album : 'loose', candidate=crypto.randomUUID();
  const cutoff=album ? now-86400000 : now-30000;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO telegram_ocr_report_batches(id,route_id,actor_user_id,sender_id,group_key,received_at) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM telegram_ocr_report_batches WHERE route_id=? AND sender_id=? AND group_key=? AND summary_state='pending' AND received_at>=?)").bind(candidate,route.id,actorId,sender,group,now,route.id,sender,group,cutoff),
    env.DB.prepare("INSERT INTO telegram_ocr_report_items(job_id,report_id) SELECT ?,id FROM telegram_ocr_report_batches WHERE route_id=? AND sender_id=? AND group_key=? AND summary_state='pending' AND received_at>=? ORDER BY received_at DESC,id LIMIT 1 ON CONFLICT(job_id) DO NOTHING").bind(job.id,route.id,sender,group,cutoff),
    env.DB.prepare('UPDATE telegram_ocr_report_batches SET received_at=? WHERE id=(SELECT report_id FROM telegram_ocr_report_items WHERE job_id=?)').bind(now,job.id),
  ]);
  return env.DB.prepare('SELECT report_id FROM telegram_ocr_report_items WHERE job_id=?').bind(job.id).first<{report_id:string}>();
}
async function sendReportMessage(env: Env, id: string, stage: 'ack_state'|'summary_state', client: TelegramClient, route: OcrRoute, text: string) {
  const won=await env.DB.prepare(`UPDATE telegram_ocr_report_batches SET ${stage}='sending' WHERE id=? AND ${stage}='pending' RETURNING id`).bind(id).first();
  if(!won)return;
  try {
    await client.sendMessage({chatId:route.chat_id,topicId:route.topic_id,text});
    await env.DB.prepare(`UPDATE telegram_ocr_report_batches SET ${stage}='sent' WHERE id=? AND ${stage}='sending'`).bind(id).run();
  } catch {
    // Telegram cannot guarantee sendMessage idempotency after a lost response.
    // Preserve an uncertain delivery for operator inspection instead of sending duplicates.
    await env.DB.prepare(`UPDATE telegram_ocr_report_batches SET ${stage}='unknown' WHERE id=? AND ${stage}='sending'`).bind(id).run();
  }
}
async function reportFinishedBatches(env: Env, execution: ExecutionContext, runtime: ProductionOcrRuntime) {
  if(env.TELEGRAM_OCR_BATCH_REPORTS!=='true')return;
  const batches=await env.DB.prepare("SELECT * FROM telegram_ocr_report_batches WHERE summary_state='pending' AND received_at<? ORDER BY received_at LIMIT 10").bind(Date.now()-30000).all<{id:string;route_id:string;actor_user_id:string;sender_id:string;ack_state:string}>();
  for(const batch of batches.results){
    const route=await routeById(env,batch.route_id);if(!route)continue;
    const actor=await verifiedActor(await runtime.base(env,execution),runtime,batch.actor_user_id,batch.sender_id);
    const client=await runtime.client(actor,route.bot_id);
    if(batch.ack_state==='pending')await sendReportMessage(env,batch.id,'ack_state',client,route,'已收到案件，排入建檔');
    const jobs=await env.DB.prepare('SELECT j.status,j.fields_json,j.case_id FROM telegram_ocr_jobs j JOIN telegram_ocr_report_items i ON i.job_id=j.id WHERE i.report_id=? ORDER BY j.message_id').bind(batch.id).all<{status:string;fields_json:string|null;case_id:string|null}>();
    if(!jobs.results.length || jobs.results.some(job=>!['created','failed','cancelled'].includes(job.status)))continue;
    const created=jobs.results.filter(job=>job.status==='created' && job.case_id);
    const lines=created.map(job=>{const fields=confirmedOcrFields(JSON.parse(job.fields_json??'{}'));if(!fields.success)throw Error('INVALID_REPORT_FIELDS');return [fields.data.code,fields.data.customerName,fields.data.region.replace(/[縣市]$/,'')].join(' ');});
    const failed=jobs.results.filter(job=>job.status==='failed').length;
    const text=[...lines,`共 ${created.length} 件，已建檔`,...(failed?[`另有 ${failed} 件未完成，請至後台查看`]:[])].join('\n');
    // Keep each Telegram message below its text limit; source rate limit bounds batch size.
    await sendReportMessage(env,batch.id,'summary_state',client,route,text);
  }
  await env.DB.prepare('DELETE FROM telegram_ocr_report_batches WHERE received_at<?').bind(Date.now()-86400000).run();
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
  if(env.TELEGRAM_OCR_BATCH_REPORTS==='true') {
    const report=await attachReport(env,route,identity.user_id,sender,`${route.bot_id ?? 'legacy'}:${update.update_id}`,message.media_group_id);
    if(report) execution.waitUntil(sendReportMessage(env,report.report_id,'ack_state',client,route,'已收到案件，排入建檔'));
  }
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
        const result = job.case_id ? {results:[{status:'created',caseId:job.case_id}]} : await runtime.create(actor, {
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
        if(row?.status==='created' && row.caseId && env.TELEGRAM_OCR_ATTACH_IMAGES==='true') {
          await env.DB.prepare("UPDATE telegram_ocr_jobs SET case_id=? WHERE id=? AND status='creating' AND lease_token=?").bind(row.caseId,job.id,lease).run();
          await attachJobImage(env,actor,runtime,route,job,row.caseId);
        }
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
  if(env.TELEGRAM_OCR_ATTACH_IMAGES==='true') {
    const missing=await env.DB.prepare("SELECT j.* FROM telegram_ocr_jobs j WHERE j.status='created' AND j.case_id IS NOT NULL AND j.file_id IS NOT NULL AND j.expires_at>? AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.entity_id=j.case_id AND a.action='media.uploaded' AND json_extract(a.metadata,'$.uploadKey')=j.batch_id) ORDER BY j.created_at LIMIT 5").bind(Date.now()).all<TelegramOcrJob>();
    for(const job of missing.results) {
      try {const route=await routeById(env,job.route_id);if(!route)continue;const actor=await verifiedActor(base,runtime,job.actor_user_id,job.sender_id);await attachJobImage(env,actor,runtime,route,job,job.case_id!);} catch { console.error('TELEGRAM_OCR_IMAGE_BACKFILL_PENDING'); }
    }
  }
  await reportFinishedBatches(env,execution,runtime);
  await env.DB.prepare(
    "DELETE FROM telegram_ocr_jobs WHERE expires_at<? AND status<>'creating'",
  )
    .bind(Date.now())
    .run();
}
