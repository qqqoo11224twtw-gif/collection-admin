import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import type { Context as HonoContext } from 'hono';
import { getSession } from './auth';

export async function createContext(c: HonoContext) {
  // getSession returns null in `disabled` mode without touching better-auth.
  const info = await getSession(c.req.raw.headers);
  let defer: ((task: Promise<unknown>) => void) | undefined;
  try {
    const execution = c.executionCtx;
    defer = (task) => execution.waitUntil(task);
  } catch {
    /* Direct integration requests have no execution context. */
  }
  const context = {
    env: env,
    DB: drizzle(env.DB),
    // Raw request headers, for handlers that call back into better-auth
    // (e.g. API key management acts as the session user).
    headers: c.req.raw.headers,
    session: info?.session ?? null,
    user: info?.user ?? null,
    isAdmin: info?.user.role === 'admin',
  };
  return {
    ...context,
    correlationId: crypto.randomUUID(),
    defer,
  } as typeof context & {
    correlationId?: string;
    defer?: (task: Promise<unknown>) => void;
  };
}

export type Context = Awaited<ReturnType<typeof createContext>> & {
  telegramCollectorId?: string;
  // Only set by telegramPrincipal, scoped to one claimed update/request.
  telegramPrincipalRecord?: typeof import('@saasflare-dev/db').user['$inferSelect'];
  telegramReply?: (key: string) => Promise<void>;
  telegramTiming?: {
    webhook_received_at: number;
    route_lookup_ms: number;
    case_lookup_ms: number;
    conversation_write_ms: number;
    telegram_send_ms: number;
  };
};
