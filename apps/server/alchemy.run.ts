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

const PROJECT_NAME = 'starter';

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
if (app.stage === 'local') {
  corsOrigin = Array.from(
    { length: 10 },
    (_, i) => `http://localhost:${3000 + i}`,
  ).join(',');
} else {
  const webDomain =
    (!isPRStage && process.env.WEB_DOMAIN) ||
    (await computeWorkerDevDomain(api, `${PROJECT_NAME}-web-${app.stage}`));
  corsOrigin = `https://${webDomain}`;
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
