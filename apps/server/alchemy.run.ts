import { readFileSync } from 'node:fs';
import alchemy from 'alchemy';
import {
  AccountId,
  computeWorkerDevDomain,
  createCloudflareApi,
  D1Database,
  KVNamespace,
  R2Bucket,
  Worker,
} from 'alchemy/cloudflare';
import { Exec } from 'alchemy/os';

import { CloudflareStateStore } from 'alchemy/state';

// Single source of truth for the product name: the root package.json
// `saasflare.projectName` field. Rename a fork THERE, once — every
// Worker/DB/KV resource name follows. A dedicated field (not `name`)
// because npm package names allow characters that Cloudflare Worker
// names don't. Read at runtime (not imported) so it works identically
// under node, alchemy, and CI.
const PROJECT_NAME = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).saasflare?.projectName as string | undefined;
if (!PROJECT_NAME || !/^[a-z][a-z0-9-]*$/.test(PROJECT_NAME)) {
  throw new Error(
    `root package.json needs "saasflare": { "projectName": "<lowercase-dashes>" } (got ${JSON.stringify(PROJECT_NAME)})`,
  );
}

const accountId = await AccountId();
console.log('Your Cloudflare Account ID is:', accountId);

const api = await createCloudflareApi();

// Use CloudflareStateStore only if CLOUDFLARE_API_TOKEN is present.
// Without it, state stays local in `.alchemy/` (alchemy login OAuth flow).
const stateStore = process.env.CLOUDFLARE_API_TOKEN
  ? // biome-ignore lint/suspicious/noExplicitAny: alchemy scope type is internal
    (scope: any) => new CloudflareStateStore(scope, { forceUpdate: true })
  : undefined;

const app = await alchemy(`${PROJECT_NAME}-server`, {
  stateStore,
});

// Resolve cross-app URLs.
//   local stage       -> http://localhost:3000..:3009 (vite may shift ports)
//   pr-* stage        -> always workers.dev (PR previews never reuse stage domains)
//   dev/prod stage    -> WEB_DOMAIN / SERVER_DOMAIN env if set, else workers.dev
const serverScriptName = `${PROJECT_NAME}-server-${app.stage}`;
const isPRStage = app.stage.startsWith('pr-');
const serverDomain = isPRStage ? undefined : process.env.SERVER_DOMAIN;

let corsOrigin: string;
let serverUrl: string;
if (app.stage === 'local') {
  corsOrigin = Array.from(
    { length: 10 },
    (_, i) => `http://localhost:${3000 + i}`,
  ).join(',');
  serverUrl = 'http://localhost:4000';
} else {
  const webDomain =
    (!isPRStage && process.env.WEB_DOMAIN) ||
    (await computeWorkerDevDomain(api, `${PROJECT_NAME}-web-${app.stage}`));
  corsOrigin = `https://${webDomain}`;
  const selfDomain =
    serverDomain || (await computeWorkerDevDomain(api, serverScriptName));
  serverUrl = `https://${selfDomain}`;
}

// ── AUTH_MODE and the fail-closed env matrix (docs/auth.md) ──
// The template's single auth switch: open | admin-only | disabled. Unset
// resolves environment-aware (open locally, disabled when deployed) so a
// fresh fork deploys with zero env; a typo must still fail the deploy.
const AUTH_MODES = ['disabled', 'open', 'admin-only'] as const;
const authMode =
  process.env.AUTH_MODE || (app.stage === 'local' ? 'open' : 'disabled');
if (!(AUTH_MODES as readonly string[]).includes(authMode)) {
  throw new Error(
    `invalid AUTH_MODE "${authMode}" — expected ${AUTH_MODES.join(' | ')}`,
  );
}
if (!process.env.AUTH_MODE && app.stage !== 'local') {
  console.log(
    `AUTH_MODE not set → stage "${app.stage}" deploys with auth DISABLED ` +
      '(no sign-in, protected routes 401). To enable, set AUTH_MODE=open ' +
      'plus the mail env — see docs/auth.md.',
  );
}

// Fail closed: a deployed auth-enabled stage without real auth/email secrets
// must not come up half-configured (default signing secret or console-logged
// OTPs). `disabled` deployments need none of these.
if (authMode !== 'disabled' && app.stage !== 'local' && !isPRStage) {
  const missing = ['BETTER_AUTH_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM'].filter(
    (k) => !process.env[k],
  );
  // No admin channel: blocks admin-only outright (nobody could sign in);
  // open mode keeps the requirement too — every product retains the
  // ADMIN_EMAILS admin channel (docs/auth.md).
  if (!process.env.ADMIN_EMAILS) missing.push('ADMIN_EMAILS');
  if (missing.length > 0) {
    throw new Error(
      `stage "${app.stage}" with AUTH_MODE=${authMode} requires env: ${missing.join(', ')} (see docs/auth.md)`,
    );
  }
}

// Create a KV namespace
const KV = await KVNamespace('KV', {
  title: `${app.name}-kv-${app.stage}`,
  adopt: true,
});

await Exec('db-generate', {
  cwd: '../../packages/db',
  command: 'pnpm run db:generate',
});

// Create D1 database with migrations
const DB = await D1Database('DB', {
  name: `${app.name}-db-${app.stage}`,
  migrationsDir: '../../packages/db/migrations/',
  jurisdiction: 'default',
  adopt: true,
});

const hasR2Keys =
  !!process.env.R2_ACCESS_KEY_ID && !!process.env.R2_SECRET_ACCESS_KEY;

const bucketName = `${app.name}-bucket-${app.stage}`;

const BUCKET = await R2Bucket('BUCKET', {
  name: bucketName,
  locationHint: 'apac',
  devDomain: true,
  // To use the r2.dev domain during local development, you must use a deployed R2 bucket:
  dev: {
    remote: true,
  },
  cors: [
    {
      allowed: {
        origins: corsOrigin.split(',').map((o) => o.trim()),
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'],
        headers: ['*'],
      },
    },
  ],
  // do not delete the bucket when the stack is destroyed
  delete: false,
  empty: false,
  adopt: true,
});

if (hasR2Keys) {
  console.log(`Your Bucket dev domain: ${BUCKET.devDomain}`); // [random-id].r2.dev
}

export const server = await Worker('server', {
  name: serverScriptName,
  entrypoint: 'src/index.ts',
  compatibility: 'node',
  compatibilityFlags: ['enable_request_signal'],
  ...(serverDomain ? { domains: [serverDomain] } : {}),
  bindings: {
    CORS_ORIGIN: corsOrigin,
    SERVER_URL: serverUrl,
    // Auth switch + secrets (docs/auth.md). Local defaults are fine for dev;
    // deployed auth-enabled stages fail closed above.
    AUTH_MODE: authMode,
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET ?? 'local-dev-secret-not-for-prod',
    // Comma-separated emails granted the admin role (in admin-only mode, the
    // ONLY emails that may sign in at all).
    ADMIN_EMAILS: process.env.ADMIN_EMAILS ?? '',
    // Transactional email (OTP). Without a key (local only — deployed stages
    // fail closed above), codes are logged to the worker console instead.
    RESEND_API_KEY: process.env.RESEND_API_KEY ?? '',
    EMAIL_FROM: process.env.EMAIL_FROM ?? '',
    CASE_STORAGE_MODE: process.env.CASE_STORAGE_MODE ?? '',
    R2_PUBLIC_DOMAIN: BUCKET.devDomain || '',
    KV,
    DB,
    ...(hasR2Keys
      ? {
          BUCKET,
          R2_ACCOUNT_ID: accountId,
          R2_BUCKET_NAME: bucketName,
          R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
          R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
        }
      : {}),
  },
  dev: {
    port: 4000,
  },
  adopt: true,
});

console.log({ server: server.url });

await app.finalize();
