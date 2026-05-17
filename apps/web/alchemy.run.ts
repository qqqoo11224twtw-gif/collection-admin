import alchemy from 'alchemy';
import {
  computeWorkerDevDomain,
  createCloudflareApi,
  TanStackStart,
} from 'alchemy/cloudflare';
import { CloudflareStateStore } from 'alchemy/state';
import { domainsFor, PROJECT_NAME } from '../../config.ts';

const api = await createCloudflareApi();

const app = await alchemy(`${PROJECT_NAME}-web`, {
  stateStore: process.env.CLOUDFLARE_API_TOKEN
    ? // biome-ignore lint/suspicious/noExplicitAny: alchemy scope type is internal
      (scope: any) => new CloudflareStateStore(scope, { forceUpdate: true })
    : undefined,
});

const { web: webDomain, server: serverDomainConfig } = domainsFor(app.stage);

// Resolve backend URL for NEXT_PUBLIC_SERVER_URL (baked into bundle at build time).
// NEXT_PUBLIC_SERVER_URL env wins so local dev can pin http://localhost:4000
// without needing CF auth.
if (!process.env.NEXT_PUBLIC_SERVER_URL) {
  const serverDomain =
    serverDomainConfig ||
    (await computeWorkerDevDomain(
      api,
      `${PROJECT_NAME}-server-${app.stage}`,
    ));
  process.env.NEXT_PUBLIC_SERVER_URL = `https://${serverDomain}`;
}

export const web = await TanStackStart('web', {
  name: `${app.name}-${app.stage}`,
  adopt: true,
  ...(webDomain ? { domains: [webDomain] } : {}),
});

console.log({ web: web.url });

await app.finalize();
