import type { server } from '../../apps/server/alchemy.run';

// This file infers types for the cloudflare:workers environment from your Alchemy Worker.
// @see https://alchemy.run/concepts/bindings/#type-safe-bindings

export type CloudflareEnv = typeof server.Env & { CASE_BUCKET?: R2Bucket };

declare global {
  type Env = CloudflareEnv;
}

declare module 'cloudflare:workers' {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {
      CASE_BUCKET?: R2Bucket;
    }
  }
}
