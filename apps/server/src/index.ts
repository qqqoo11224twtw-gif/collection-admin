import { env } from 'cloudflare:workers';
import { ORPCError, onError } from '@orpc/server';
// orpc
import { RPCHandler } from '@orpc/server/fetch';
// api routes
import { appRouter } from '@saasflare-dev/api';
import {
  authHandler,
  authMode,
  isAdminEmail,
  verifyApiKey,
} from '@saasflare-dev/api/auth';
import { caseImageResponse } from '@saasflare-dev/api/case-image';
import { uploadCaseImages } from '@saasflare-dev/api/case-media-management';
import { createContext } from '@saasflare-dev/api/context';
import { exportSettlements } from '@saasflare-dev/api/finance-export';
import {
  intakeImageResponse,
  uploadIntakeImages,
} from '@saasflare-dev/api/intake-media';
import { createManualCase } from '@saasflare-dev/api/manual-cases';
import { telegramClient } from '@saasflare-dev/api/telegram-client';
import {
  runTelegramProcessing,
  telegramWebhook,
} from '@saasflare-dev/api/telegram-processing';
import { verification } from '@saasflare-dev/db';
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import pkg from '../../../package.json';
import type { server } from '../alchemy.run';

const app = new Hono<{
  Bindings: typeof server.Env;
  Variables: { apiKeyId: string; apiKeyUserId: string };
}>();
app.post('/api/telegram/webhook', async (c) =>
  telegramWebhook(
    {
      env,
      DB: drizzle(env.DB),
      headers: c.req.raw.headers,
      session: null,
      user: null,
      isAdmin: false,
    },
    c.req.raw,
  ),
);
app.use(logger());

app.use(
  '/*',
  cors({
    origin: env.CORS_ORIGIN
      ? env.CORS_ORIGIN.split(',').map((origin) => origin.trim())
      : [],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    // better-auth clients send credentialed requests (session cookie).
    credentials: true,
  }),
);

app.post('/api/cases/manual', async (c) => {
  try {
    const result = await createManualCase(await createContext(c), c.req.raw);
    return c.json(result, result.kind === 'created' ? 201 : 200);
  } catch (error: unknown) {
    if (error instanceof ORPCError)
      return c.json(
        { error: error.code, message: error.message },
        error.status as 400 | 401 | 403 | 409 | 500,
      );
    return c.json({ error: 'INVALID_INPUT' }, 400);
  }
});
app.get('/api/finance/settlements.xlsx', async (c) => {
  try {
    const result = await exportSettlements(await createContext(c), {
      dateFrom: c.req.query('dateFrom'),
      dateTo: c.req.query('dateTo'),
    });
    return new Response(new Uint8Array(result.bytes).buffer, {
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error: unknown) {
    if (error instanceof ORPCError)
      return c.json(
        { error: error.code },
        error.status as 400 | 401 | 403 | 500,
      );
    return c.json({ error: 'INVALID_DATE_RANGE' }, 400);
  }
});

// ── Auth (better-auth), gated by AUTH_MODE — see docs/auth.md ─────────────

// admin-only mode: whitelist gate for OTP requests. Runs BEFORE better-auth
// because it stores the verification value before invoking the send callback
// — a denied email must leave no rows and no mail. Product call: an
// admin-only deployment is a private console with a fixed ADMIN_EMAILS
// whitelist, so a clear error beats anti-enumeration — non-admins get an
// explicit 403 and no code is sent. (In `open` mode this gate is a no-op:
// anyone may sign up.)
app.post('/api/auth/email-otp/send-verification-otp', async (c, next) => {
  if (authMode() !== 'admin-only') return next();
  const body = await c.req.raw
    .clone()
    .json()
    .catch(() => null);
  const email = (body as { email?: unknown } | null)?.email;
  if (typeof email === 'string' && !isAdminEmail(email)) {
    return c.json(
      {
        code: 'EMAIL_NOT_ADMIN',
        message: 'This email is not an administrator account.',
      },
      403,
    );
  }
  // Whitelisted (or malformed → let better-auth reject it): pass through.
  await next();
});

// better-auth: /api/auth/* (email-otp send/verify, session, sign-out, ...).
// In `disabled` mode the surface simply doesn't exist (404).
app.on(['GET', 'POST'], '/api/auth/*', (c) => {
  if (authMode() === 'disabled') return c.notFound();
  return authHandler(c.req.raw);
});

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

// ── External API (managed API keys) ────────────────────────────────────────
// Demo of the machine-credential surface: callers outside the web app
// authenticate with a managed API key created in /keys. Products replace
// /whoami with their real endpoints and keep the middleware.

app.use('/api/v1/*', async (c, next) => {
  if (authMode() === 'disabled') return c.notFound();
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  // One generic rejection for every failure mode — never reveal whether a
  // key exists, is expired, is disabled, or lacks permissions.
  if (!token) return c.json({ error: 'unauthorized' }, 401);

  // Identifiers (never key material) go to request logs.
  const verified = await verifyApiKey(token);
  if (!verified.valid) return c.json({ error: 'unauthorized' }, 401);

  c.set('apiKeyId', verified.keyId);
  c.set('apiKeyUserId', verified.userId);
  console.log(
    JSON.stringify({
      event: 'api_key_auth',
      keyId: verified.keyId,
      userId: verified.userId,
      path: c.req.path,
    }),
  );
  await next();
});

app.get('/api/v1/whoami', (c) => {
  return c.json({
    keyId: c.get('apiKeyId'),
    userId: c.get('apiKeyUserId'),
  });
});

// Dev/test-only OTP readback for E2E login flows. Without RESEND_API_KEY the
// OTP never leaves the worker, so local Playwright fetches the code it
// "received" here. With a mail key configured (every deployed auth-enabled
// stage — enforced fail-closed in alchemy.run.ts) the endpoint does not
// exist.
app.get('/api/dev/otp', async (c) => {
  if (env.RESEND_API_KEY || authMode() === 'disabled') return c.notFound();
  const email = (c.req.query('email') ?? '').trim().toLowerCase();
  if (!email) return c.json({ error: 'email required' }, 400);
  const [row] = await drizzle(env.DB)
    .select({ value: verification.value })
    .from(verification)
    .where(eq(verification.identifier, `sign-in-otp-${email}`))
    .orderBy(desc(verification.createdAt))
    .limit(1);
  if (!row) return c.notFound();
  // better-auth stores `<otp>:<attempts>`.
  return c.json({ otp: row.value.split(':')[0] });
});

app.get('/', (c) => {
  return c.text(`Hello ${pkg.saasflare.projectName} server!`);
});

app.get('/health', (c) => c.json({ status: 'ok' }));

// Session plus case-level authorization; never redirect to an object URL.
app.get('/api/cases/:caseId/media/:mediaId/image', async (c) =>
  caseImageResponse(
    await createContext(c),
    c.req.param('caseId'),
    c.req.param('mediaId'),
  ),
);

app.post('/api/cases/:caseId/media', async (c) => {
  try {
    const result = await uploadCaseImages(
      await createContext(c),
      c.req.param('caseId'),
      c.req.raw,
    );
    return c.json(result, 201);
  } catch (error: unknown) {
    if (error instanceof ORPCError)
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status },
      );
    return c.json({ error: 'UPLOAD_UNAVAILABLE' }, 503);
  }
});

app.get('/api/intake/:intakeId/media/:mediaId/image', async (c) =>
  intakeImageResponse(
    await createContext(c),
    c.req.param('intakeId'),
    c.req.param('mediaId'),
  ),
);
app.post('/api/intake/:intakeId/media', async (c) => {
  try {
    return c.json(
      await uploadIntakeImages(
        await createContext(c),
        c.req.param('intakeId'),
        c.req.raw,
      ),
      201,
    );
  } catch (error: unknown) {
    return Response.json(
      { error: error instanceof ORPCError ? error.code : 'UPLOAD_UNAVAILABLE' },
      { status: error instanceof ORPCError ? error.status : 503 },
    );
  }
});
export default Object.assign(app, {
  async scheduled(
    _controller: ScheduledController,
    _bindings: unknown,
    execution: ExecutionContext,
  ) {
    if (!['fake', 'live'].includes(env.TELEGRAM_MODE ?? '')) return;
    execution.waitUntil(
      runTelegramProcessing(
        {
          env,
          DB: drizzle(env.DB),
          headers: new Headers(),
          session: null,
          user: null,
          isAdmin: false,
        },
        telegramClient(env),
      ),
    );
  },
});
