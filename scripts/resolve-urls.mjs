#!/usr/bin/env node
// Resolve deployed URLs for a given stage.
// Output: JSON { web, server } to stdout.
// Used by CI to compute PR preview URLs without re-running alchemy.
//
// Usage: node scripts/resolve-urls.mjs --stage <stage>
// Env: WEB_DOMAIN, SERVER_DOMAIN (optional overrides — same semantics as alchemy.run.ts)

import {
  computeWorkerDevDomain,
  createCloudflareApi,
} from 'alchemy/cloudflare';

const PROJECT_NAME = 'starter';

const stageIdx = process.argv.indexOf('--stage');
const stage = stageIdx >= 0 ? process.argv[stageIdx + 1] : null;
if (!stage) {
  console.error('Usage: resolve-urls.mjs --stage <stage>');
  process.exit(1);
}

const api = await createCloudflareApi();

async function urlFor(app, domainEnv) {
  if (process.env[domainEnv]) return `https://${process.env[domainEnv]}`;
  const subdomain = await computeWorkerDevDomain(
    api,
    `${PROJECT_NAME}-${app}-${stage}`,
  );
  return `https://${subdomain}`;
}

const [web, server] = await Promise.all([
  urlFor('web', 'WEB_DOMAIN'),
  urlFor('server', 'SERVER_DOMAIN'),
]);

console.log(JSON.stringify({ web, server }));
