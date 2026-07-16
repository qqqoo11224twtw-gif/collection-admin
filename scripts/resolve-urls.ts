#!/usr/bin/env node
// Resolve deployed URLs for a given stage.
// Output: JSON { web, server } to stdout.
// Used by CI to compute PR preview / deploy URLs without re-running alchemy.
//
// Usage: node --env-file apps/server/.{stage}.env scripts/resolve-urls.ts --stage <stage>
//
// Requires Node 23.6+ for unflagged TypeScript stripping and --env-file.

import { readFileSync } from 'node:fs';
import {
  computeWorkerDevDomain,
  createCloudflareApi,
} from 'alchemy/cloudflare';

// Single source of truth for the product name: the root package.json
// `saasflare.projectName` field. Rename a fork THERE, once — every
// Worker/DB/KV resource name follows. A dedicated field (not `name`)
// because npm package names allow characters that Cloudflare Worker
// names don't. Read at runtime (not imported) so it works identically
// under node, alchemy, and CI.
const PROJECT_NAME = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).saasflare?.projectName as string | undefined;
if (!PROJECT_NAME || !/^[a-z][a-z0-9-]*$/.test(PROJECT_NAME)) {
  throw new Error(
    `root package.json needs "saasflare": { "projectName": "<lowercase-dashes>" } (got ${JSON.stringify(PROJECT_NAME)})`,
  );
}

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
