#!/usr/bin/env node
// Resolve deployed URLs for a given stage.
// Output: JSON { web, server } to stdout.
// Used by CI to compute PR preview / deploy URLs without re-running alchemy.
//
// Usage: node scripts/resolve-urls.ts --stage <stage>
// Requires Node 23.6+ for unflagged TypeScript stripping.

import {
  computeWorkerDevDomain,
  createCloudflareApi,
} from 'alchemy/cloudflare';
import { domainsFor, PROJECT_NAME } from '../config.ts';

const stageIdx = process.argv.indexOf('--stage');
const stage = stageIdx >= 0 ? process.argv[stageIdx + 1] : null;
if (!stage) {
  console.error('Usage: resolve-urls.ts --stage <stage>');
  process.exit(1);
}

const api = await createCloudflareApi();
const { web: webDomain, server: serverDomain } = domainsFor(stage);

async function urlFor(app: string, custom?: string) {
  if (custom) return `https://${custom}`;
  const subdomain = await computeWorkerDevDomain(
    api,
    `${PROJECT_NAME}-${app}-${stage}`,
  );
  return `https://${subdomain}`;
}

const [web, server] = await Promise.all([
  urlFor('web', webDomain),
  urlFor('server', serverDomain),
]);

console.log(JSON.stringify({ web, server }));
