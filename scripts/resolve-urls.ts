#!/usr/bin/env node
// Resolve deployed URLs for a given stage.
// Output: JSON { web, server } to stdout.
// Used by CI to compute PR preview / deploy URLs without re-running alchemy.
//
// Usage: node --env-file apps/server/.{stage}.env scripts/resolve-urls.ts --stage <stage>
//
// Requires Node 23.6+ for unflagged TypeScript stripping and --env-file.

import {
  computeWorkerDevDomain,
  createCloudflareApi,
} from 'alchemy/cloudflare';

const PROJECT_NAME = 'starter';

const stageIdx = process.argv.indexOf('--stage');
const stage = stageIdx >= 0 ? process.argv[stageIdx + 1] : null;
if (!stage) {
  console.error('Usage: resolve-urls.ts --stage <stage>');
  process.exit(1);
}

const isPRStage = stage.startsWith('pr-');
const api = await createCloudflareApi();

async function urlFor(appName: 'web' | 'server', envKey: string) {
  // For PR stages, always use workers.dev (custom domains belong to dev/prod only).
  const custom = isPRStage ? undefined : process.env[envKey];
  if (custom) return `https://${custom}`;
  const subdomain = await computeWorkerDevDomain(
    api,
    `${PROJECT_NAME}-${appName}-${stage}`,
  );
  return `https://${subdomain}`;
}

const [web, server] = await Promise.all([
  urlFor('web', 'WEB_DOMAIN'),
  urlFor('server', 'SERVER_DOMAIN'),
]);

console.log(JSON.stringify({ web, server }));
