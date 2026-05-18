import alchemy from 'alchemy';
import {
  computeWorkerDevDomain,
  createCloudflareApi,
  DnsRecords,
  RedirectRule,
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

// Alias hostnames (e.g. www.) — proxied DNS + edge-level 301 to the
// canonical WEB_DOMAIN. Skipped for local + pr-* stages and when no
// canonical domain is configured. WEB_DOMAIN_ALIASES is comma-separated.
// Requires WEB_DOMAIN to equal its Cloudflare zone name (apex).
const aliases = (process.env.WEB_DOMAIN_ALIASES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!isPRStage && webDomain && aliases.length > 0) {
  await DnsRecords('web-aliases-dns', {
    zoneId: webDomain,
    records: aliases.map((alias) => ({
      name: alias,
      type: 'A' as const,
      content: '192.0.2.1',
      proxied: true,
    })),
  });

  for (const alias of aliases) {
    await RedirectRule(`redirect-${alias.replace(/\./g, '-')}`, {
      zone: webDomain,
      requestUrl: `https://${alias}/*`,
      targetUrl: `https://${webDomain}/\${1}`,
      statusCode: 301,
      preserveQueryString: true,
    });
  }
}

console.log({ web: web.url });

await app.finalize();
