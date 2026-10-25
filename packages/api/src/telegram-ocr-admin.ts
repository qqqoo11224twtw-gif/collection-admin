import { z } from 'zod';
import type { Context } from './context';
import { routeSchema } from './telegram-contract';
import { confirmedOcrFields } from './telegram-ocr-contract';
import {
  type ProductionOcrRuntime,
  processTelegramOcrJobs,
  type TelegramOcrJob,
} from './telegram-ocr-extension';

async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw Error('INVALID_BODY');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw Error('BODY_LIMIT');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function handleTelegramOcrAdmin(
  request: Request,
  context: Context,
  execution: ExecutionContext,
  runtime: ProductionOcrRuntime,
): Promise<Response> {
  const env = context.env;
  const origin = request.headers.get('Origin');
  const allowed = (env.CORS_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const trusted = origin !== null && allowed.includes(origin);
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  if (trusted) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  const reply = (value: unknown, status = 200) =>
    Response.json(value, { status, headers });
  if (request.method === 'OPTIONS')
    return new Response(null, { status: trusted ? 204 : 403, headers });
  if (!context.user || !context.session)
    return reply({ error: 'UNAUTHORIZED' }, 401);
  try {
    runtime.requirePermission(context, 'case.create');
    runtime.requirePermission(context, 'case.view_all');
    runtime.requirePermission(context, 'media.view');
    runtime.requirePermission(context, 'media.upload');
    // Route administration is required because this API reveals source group metadata.
    runtime.requirePermission(context, 'telegram_route.manage');
  } catch {
    return reply({ error: 'FORBIDDEN' }, 403);
  }
  if (
    env.TELEGRAM_OCR_ENABLED !== 'true' ||
    env.TELEGRAM_OCR_REVIEW_MODE !== 'backend'
  )
    return reply({ error: 'OCR_DISABLED' }, 503);
  if (
    request.method !== 'GET' &&
    (!trusted ||
      !request.headers.get('Content-Type')?.startsWith('application/json'))
  )
    return reply({ error: 'ORIGIN_DENIED' }, 403);
  const path = new URL(request.url).pathname.replace('/api/telegram-ocr', '');
  try {
    if (request.method === 'GET' && path === '/options') {
      const bots = await env.DB.prepare(
        "SELECT id,username,internal_name FROM telegram_bots WHERE is_active=1 AND lower(username) IN ('wanwanautoresponder_bot','@wanwanautoresponder_bot')",
      ).all();
      const routes = await env.DB.prepare(
        "SELECT id,name,bot_id,chat_id,topic_id,is_active FROM telegram_routes WHERE route_type IN ('intake','intake_source') ORDER BY created_at DESC",
      ).all();
      return reply({ bots: bots.results, routes: routes.results });
    }
    if (request.method === 'POST' && path === '/routes') {
      const parsed = routeSchema.safeParse(await body(request));
      if (
        !parsed.success ||
        !['intake', 'intake_source'].includes(parsed.data.routeType) ||
        !parsed.data.botId ||
        !parsed.data.chatId.startsWith('-') ||
        parsed.data.collectorId
      )
        return reply({ error: 'INVALID_ROUTE' }, 422);
      const input = parsed.data;
      const bot = await env.DB.prepare(
        "SELECT id FROM telegram_bots WHERE id=? AND is_active=1 AND lower(username) IN ('wanwanautoresponder_bot','@wanwanautoresponder_bot')",
      )
        .bind(input.botId)
        .first();
      if (!bot) return reply({ error: 'BOT_NOT_AVAILABLE' }, 422);
      if (
        input.id &&
        !(await env.DB.prepare(
          "SELECT id FROM telegram_routes WHERE id=? AND route_type IN ('intake','intake_source')",
        )
          .bind(input.id)
          .first())
      )
        return reply({ error: 'NOT_FOUND' }, 404);
      if (
        input.isActive &&
        (await env.DB.prepare(
          'SELECT id FROM telegram_routes WHERE id<>? AND is_active=1 AND chat_id=? AND coalesce(topic_id,0)=? LIMIT 1',
        )
          .bind(input.id ?? '', input.chatId, input.topicId ?? 0)
          .first())
      )
        return reply({ error: 'ROUTE_CONFLICT' }, 409);
      const now = Date.now(),
        id = input.id ?? crypto.randomUUID();
      if (input.id)
        await env.DB.prepare(
          "UPDATE telegram_routes SET name=?,bot_id=?,chat_id=?,topic_id=?,is_active=?,managed_by_user_id=?,updated_at=? WHERE id=? AND route_type IN ('intake','intake_source')",
        )
          .bind(
            input.name,
            input.botId,
            input.chatId,
            input.topicId,
            input.isActive ? 1 : 0,
            context.user.id,
            now,
            id,
          )
          .run();
      else
        await env.DB.prepare(
          "INSERT INTO telegram_routes(id,name,bot_id,chat_id,topic_id,route_type,collector_id,is_active,managed_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,'intake',NULL,?,?,?,?)",
        )
          .bind(
            id,
            input.name,
            input.botId,
            input.chatId,
            input.topicId,
            input.isActive ? 1 : 0,
            context.user.id,
            now,
            now,
          )
          .run();
      return reply({ id });
    }
    if (request.method === 'GET' && path === '/jobs') {
      const jobs = await env.DB.prepare(
        "SELECT id,route_id,message_id,status,version,fields_json,evidence_json,case_id,created_at,expires_at FROM telegram_ocr_jobs WHERE expires_at>? OR status='creating' ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'failed' THEN 1 WHEN 'recognizing' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END,created_at DESC LIMIT 100",
      )
        .bind(Date.now())
        .all();
      return reply({ jobs: jobs.results });
    }
    const match = path.match(
      /^\/jobs\/([a-f0-9-]{36})\/(image|confirm|retry|cancel)$/,
    );
    if (!match) return reply({ error: 'NOT_FOUND' }, 404);
    const job = await env.DB.prepare(
      'SELECT * FROM telegram_ocr_jobs WHERE id=? AND expires_at>?',
    )
      .bind(match[1], Date.now())
      .first<TelegramOcrJob>();
    if (!job) return reply({ error: 'EXPIRED_OR_NOT_FOUND' }, 404);
    if (request.method === 'GET' && match[2] === 'image') {
      if (!job.file_id) return reply({ error: 'IMAGE_UNAVAILABLE' }, 404);
      const route = await env.DB.prepare(
        "SELECT bot_id FROM telegram_routes WHERE id=? AND is_active=1 AND route_type IN ('intake','intake_source')",
      )
        .bind(job.route_id)
        .first<{ bot_id: string | null }>();
      if (!route) return reply({ error: 'SOURCE_DISABLED' }, 409);
      const client = await runtime.client(context, route.bot_id);
      const file = await client.downloadFile(job.file_id);
      if (file.bytes.byteLength > 5 * 1024 * 1024)
        return reply({ error: 'IMAGE_LIMIT' }, 413);
      const { detectedImageType } = await import('./case-media-management');
      const type = detectedImageType(new Uint8Array(file.bytes));
      if (!type) return reply({ error: 'INVALID_IMAGE' }, 422);
      headers.set('Content-Type', type);
      headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
      return new Response(file.bytes, { headers });
    }
    if (request.method !== 'POST')
      return reply({ error: 'METHOD_NOT_ALLOWED' }, 405);
    const input = z
      .strictObject({
        version: z.number().int().nonnegative(),
        reviewed: z.boolean().optional(),
        fields: z.unknown().optional(),
      })
      .safeParse(await body(request));
    if (!input.success) return reply({ error: 'INVALID_BODY' }, 422);
    if (job.version !== input.data.version)
      return reply({ error: 'STALE_REVIEW' }, 409);
    if (match[2] === 'confirm') {
      const fields = confirmedOcrFields(input.data.fields);
      if (
        !input.data.reviewed ||
        !fields.success ||
        !['ready', 'failed'].includes(job.status)
      )
        return reply({ error: 'NEEDS_REVIEW' }, 422);
      const claimed = await env.DB.prepare(
        "UPDATE telegram_ocr_jobs SET status='creating',fields_json=?,actor_user_id=?,version=version+1,updated_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND version=? AND status IN ('ready','failed') AND expires_at>? RETURNING id",
      )
        .bind(
          JSON.stringify(fields.data),
          context.user.id,
          Date.now(),
          job.id,
          input.data.version,
          Date.now(),
        )
        .first();
      if (!claimed) return reply({ error: 'STALE_REVIEW' }, 409);
      execution.waitUntil(processTelegramOcrJobs(env, execution, runtime));
      return reply({ ok: true, status: 'creating' }, 202);
    }
    if (match[2] === 'retry') {
      const updated = await env.DB.prepare(
        "UPDATE telegram_ocr_jobs SET status='pending',version=version+1,updated_at=? WHERE id=? AND version=? AND status='failed' AND attempts<3 RETURNING id",
      )
        .bind(Date.now(), job.id, input.data.version)
        .first();
      return reply(
        updated ? { ok: true } : { error: 'RETRY_NOT_ALLOWED' },
        updated ? 202 : 409,
      );
    }
    const cancelled = await env.DB.prepare(
      "UPDATE telegram_ocr_jobs SET status='cancelled',file_id=NULL,fields_json=NULL,evidence_json=NULL,version=version+1,updated_at=? WHERE id=? AND version=? AND status IN ('pending','ready','failed') RETURNING id",
    )
      .bind(Date.now(), job.id, input.data.version)
      .first();
    return reply(
      cancelled ? { ok: true } : { error: 'CANNOT_CANCEL' },
      cancelled ? 200 : 409,
    );
  } catch {
    return reply({ error: 'OCR_REQUEST_FAILED' }, 400);
  }
}
