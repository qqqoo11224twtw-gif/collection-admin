import { env } from 'cloudflare:workers';
import { onError } from '@orpc/server';
// orpc
import { RPCHandler } from '@orpc/server/fetch';
// api routes
import { appRouter } from '@saasflare-dev/api';
import { createContext } from '@saasflare-dev/api/context';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import type { server } from '../alchemy.run';

const app = new Hono<{ Bindings: typeof server.Env }>();
app.use(logger());

app.use(
  '/*',
  cors({
    origin: env.CORS_ORIGIN
      ? env.CORS_ORIGIN.split(',').map((origin) => origin.trim())
      : [],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  }),
);

// orpc handler
export const rpcHandler = new RPCHandler(appRouter, {
  interceptors: [
    onError((error: unknown) => {
      console.error(error);
    }),
  ],
});

app.use('/rpc/*', async (c, next) => {
  const context = await createContext(c);
  const { matched, response } = await rpcHandler.handle(c.req.raw, {
    prefix: '/rpc',
    context,
  });

  if (matched) {
    return c.newResponse(response.body, response);
  }

  await next();
});

app.get('/', (c) => {
  return c.text('Hello saasflare starter server!');
});

app.get('/health', (c) => c.json({ status: 'ok' }));

export default app;
