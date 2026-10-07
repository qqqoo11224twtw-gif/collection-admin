// Auto-generated Cloudflare binding types.
// @see https://alchemy.run/concepts/bindings/#type-safe-bindings

import type { server } from './alchemy.run.ts';

export type ServerEnv = typeof server.Env & { CASE_BUCKET?: R2Bucket };

declare module 'cloudflare:workers' {
  namespace Cloudflare {
    export interface Env extends ServerEnv {}
  }
}
