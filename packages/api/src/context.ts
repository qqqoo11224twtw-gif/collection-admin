import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import type { Context as HonoContext } from 'hono';
import { getSession } from './auth';

export async function createContext(c: HonoContext) {
  // getSession returns null in `disabled` mode without touching better-auth.
  const info = await getSession(c.req.raw.headers);
  return {
    env: env,
    DB: drizzle(env.DB),
    // Raw request headers, for handlers that call back into better-auth
    // (e.g. API key management acts as the session user).
    headers: c.req.raw.headers,
    session: info?.session ?? null,
    user: info?.user ?? null,
    isAdmin: info?.user.role === 'admin',
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
