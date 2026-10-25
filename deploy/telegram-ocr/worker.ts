import type { Context } from '../../packages/api/src/context';
import { handleTelegramOcrAdmin } from '../../packages/api/src/telegram-ocr-admin';
import {
  handleTelegramOcr,
  type ProductionOcrRuntime,
  processTelegramOcrJobs,
} from '../../packages/api/src/telegram-ocr-extension';
// The recovered production artifact is kept intact, with additional module exports only.
import legacy, {
  botClientForRoute,
  createBulkCases,
  createContext,
  requirePermission,
  telegramClient,
  telegramPrincipal,
} from './legacy-api.js';

const runtime: ProductionOcrRuntime = {
  base: async (_env, execution) =>
    createContext({
      req: { raw: new Request('https://api.kpirich.bid/') },
      executionCtx: execution,
    }) as Promise<Context>,
  actor: telegramPrincipal,
  requirePermission,
  client: (context, botId) =>
    botClientForRoute(context, botId, telegramClient(context.env)),
  create: createBulkCases,
};
export default {
  async fetch(request: Request, env: Env, execution: ExecutionContext) {
    if (new URL(request.url).pathname === '/api/telegram-ocr/release-check') {
      const supplied = request.headers.get('X-OCR-Release-Probe') ?? '';
      const expected = env.TELEGRAM_OCR_RELEASE_PROBE_SECRET;
      const hash = (value: string) =>
        crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      const [a, b] = await Promise.all([hash(supplied), hash(expected ?? '')]);
      let diff = 0;
      const left = new Uint8Array(a),
        right = new Uint8Array(b);
      for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
      if (!expected || diff !== 0 || request.method !== 'GET')
        return new Response(null, {
          status: 404,
          headers: { 'Cache-Control': 'no-store' },
        });
      const schema = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_ocr_jobs'",
      ).first();
      const bot = await env.DB.prepare(
        "SELECT id FROM telegram_bots WHERE is_active=1 AND lower(username) IN ('wanwanautoresponder_bot','@wanwanautoresponder_bot') LIMIT 1",
      ).first();
      const columns = schema
        ? await env.DB.prepare('PRAGMA table_info(telegram_ocr_jobs)').all<{
            name: string;
          }>()
        : { results: [] };
      return Response.json(
        {
          schemaReady:
            !!schema &&
            [
              'id',
              'version',
              'batch_id',
              'actor_user_id',
              'expires_at',
              'fields_json',
              'status',
            ].every((name) =>
              columns.results.some((column) => column.name === name),
            ),
          batchReportsReady: (await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('telegram_ocr_report_batches','telegram_ocr_report_items')").first<{n:number}>())?.n === 2,
          botReady: !!bot,
          enabled: env.TELEGRAM_OCR_ENABLED === 'true',
          reviewMode: env.TELEGRAM_OCR_REVIEW_MODE,
          providersConfigured:
            !!env.GOOGLE_VISION_API_KEY &&
            !!env.OPENAI_API_KEY &&
            !!env.BULK_OCR_MODEL,
          releaseId: env.TELEGRAM_OCR_RELEASE_ID,
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (new URL(request.url).pathname.startsWith('/api/telegram-ocr/')) {
      const context = await createContext({
        req: { raw: request },
        executionCtx: execution,
      });
      return handleTelegramOcrAdmin(request, context, execution, runtime);
    }
    if (
      new URL(request.url).pathname === '/api/telegram/webhook' &&
      request.method === 'POST'
    ) {
      try {
        const response = await handleTelegramOcr(
          request,
          env,
          execution,
          runtime,
        );
        if (response) return response;
      } catch {
        return Response.json(
          { error: 'OCR_TEMPORARILY_UNAVAILABLE' },
          { status: 503 },
        );
      }
    }
    return legacy.fetch(request, env, execution);
  },
  async scheduled(
    event: ScheduledController,
    env: Env,
    execution: ExecutionContext,
  ) {
    execution.waitUntil(
      processTelegramOcrJobs(env, execution, runtime).catch(() => {
        console.error('TELEGRAM_OCR_SCHEDULER_FAILED');
      }),
    );
    return legacy.scheduled(event, env, execution);
  },
};
