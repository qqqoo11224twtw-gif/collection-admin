import { readFileSync } from 'node:fs';
import alchemy from 'alchemy';
import {
  computeWorkerDevDomain,
  createCloudflareApi,
  TanStackStart,
} from 'alchemy/cloudflare';
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

const api = await createCloudflareApi();

const app = await alchemy(`${PROJECT_NAME}-web`, {
  stateStore: process.env.CLOUDFLARE_API_TOKEN
    ? // biome-ignore lint/suspicious/noExplicitAny: alchemy scope type is internal
      (scope: any) => new CloudflareStateStore(scope, { forceUpdate: true })
    : undefined,
});

// Resolve backend URL for NEXT_PUBLIC_SERVER_URL (baked into bundle at build time).
//   local stage       -> http://localhost:4000
//   pr-* stage        -> always workers.dev
//   dev/prod          -> SERVER_DOMAIN env if set, else workers.dev
const isPRStage = app.stage.startsWith('pr-');
const webDomain = isPRStage ? undefined : process.env.WEB_DOMAIN;

if (app.stage === 'local') {
  process.env.NEXT_PUBLIC_SERVER_URL = 'http://localhost:4000';
} else {
  const serverDomain =
    (!isPRStage && process.env.SERVER_DOMAIN) ||
    (await computeWorkerDevDomain(api, `${PROJECT_NAME}-server-${app.stage}`));
  process.env.NEXT_PUBLIC_SERVER_URL = `https://${serverDomain}`;
}

export const web = await TanStackStart('web', {
  name: `${app.name}-${app.stage}`,
  adopt: true,
  ...(webDomain ? { domains: [webDomain] } : {}),
});

console.log({ web: web.url });

await app.finalize();
