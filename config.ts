// Deploy topology: project name + per-stage custom domains.
// Imported by apps/{server,web}/alchemy.run.ts and scripts/resolve-urls.mjs.
//
// To add a custom domain, fill in the entries below (zone must be on
// Cloudflare DNS). Leave undefined to use the auto-generated workers.dev URL.
// Unknown stages (e.g., pr-123) fall back to workers.dev.

export const PROJECT_NAME = 'starter';

export interface StageDomains {
  /** Frontend custom domain. */
  web?: string;
  /** Backend custom domain. */
  server?: string;
}

export const domains: Record<string, StageDomains> = {
  dev: {
    // web: 'dev.example.com',
    // server: 'api-dev.example.com',
  },
  prod: {
    // web: 'example.com',
    // server: 'api.example.com',
  },
};

export function domainsFor(stage: string): StageDomains {
  return domains[stage] ?? {};
}
