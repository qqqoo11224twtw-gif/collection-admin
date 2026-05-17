import alchemy from 'alchemy';
import {
  computeWorkerDevDomain,
  createCloudflareApi,
  TanStackStart,
} from 'alchemy/cloudflare';
import { CloudflareStateStore } from 'alchemy/state';

const PROJECT_NAME = 'starter';

const api = await createCloudflareApi();

const app = await alchemy(`${PROJECT_NAME}-web`, {
  stateStore: process.env.CLOUDFLARE_API_TOKEN
    ? // biome-ignore lint/suspicious/noExplicitAny: alchemy scope type is internal
      (scope: any) => new CloudflareStateStore(scope, { forceUpdate: true })
    : undefined,
});

// Resolve backend URL for NEXT_PUBLIC_SERVER_URL (baked into bundle at build time).
// Priority: NEXT_PUBLIC_SERVER_URL > SERVER_DOMAIN > workers.dev fallback.
// Skip the CF API call when an explicit value is provided (e.g., local dev).
if (!process.env.NEXT_PUBLIC_SERVER_URL) {
  const serverDomain =
    process.env.SERVER_DOMAIN ||
    (await computeWorkerDevDomain(
      api,
      `${PROJECT_NAME}-server-${app.stage}`,
    ));
  process.env.NEXT_PUBLIC_SERVER_URL = `https://${serverDomain}`;
}

const webDomain = process.env.WEB_DOMAIN;

export const web = await TanStackStart('web', {
  name: `${app.name}-${app.stage}`,
  adopt: true,
  ...(webDomain ? { domains: [webDomain] } : {}),
});

console.log({ web: web.url });

await app.finalize();
