import type { Context } from '../../packages/api/src/context';
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
