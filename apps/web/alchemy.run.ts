import alchemy from 'alchemy';
import {
  computeWorkerDevDomain,
  createCloudflareApi,
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

// Alias hostnames that should 301 to the canonical WEB_DOMAIN.
// Comma-separated. Skipped for local + pr-* stages.
const aliases =
  !isPRStage && webDomain
    ? (process.env.WEB_DOMAIN_ALIASES ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

export const web = await TanStackStart('web', {
  name: `${app.name}-${app.stage}`,
  adopt: true,
  // Bind canonical + every alias as Worker custom domains. The Workers
  // Custom Domain API provisions DNS for each automatically — no Zone
  // DNS Edit scope on the API token required. Aliases never actually
  // hit the Worker because the RedirectRule below runs first
  // (http_request_dynamic_redirect phase precedes Worker execution).
  ...(webDomain ? { domains: [webDomain, ...aliases] } : {}),
});

// Edge-level 301 from each alias to the canonical WEB_DOMAIN.
// Runs in http_request_dynamic_redirect phase (first in the rules
// engine), so the alias request is terminated before reaching the
// Worker. Requires the API token to have Zone > Single Redirect > Edit
// (a.k.a. Dynamic URL Redirects: Edit).
for (const alias of aliases) {
  await RedirectRule(`redirect-${alias.replace(/\./g, '-')}`, {
    zone: webDomain as string,
    requestUrl: `https://${alias}/*`,
    targetUrl: `https://${webDomain}/\${1}`,
    statusCode: 301,
    preserveQueryString: true,
  });
}

console.log({ web: web.url });

await app.finalize();
