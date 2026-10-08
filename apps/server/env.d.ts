// Auto-generated Cloudflare binding types.
// @see https://alchemy.run/concepts/bindings/#type-safe-bindings

import type { server } from './alchemy.run.ts';

export type ServerEnv = typeof server.Env & {
  CASE_BUCKET?: R2Bucket;
  TELEGRAM_MODE?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  BUSINESS_TIMEZONE?: string;
  IMAGE_EXTRACTION_MODE?: string;
  OPENAI_API_KEY?: string;
  OPENAI_IMAGE_MODEL?: string;
  OPENAI_REQUEST_TIMEOUT_MS?: string;
  OPENAI_MAX_RETRIES?: string;
  COMMISSION_RATE?: string;
};

declare module 'cloudflare:workers' {
  namespace Cloudflare {
    export interface Env extends ServerEnv {
      TELEGRAM_MODE?: string;
      TELEGRAM_BOT_TOKEN?: string;
      TELEGRAM_WEBHOOK_SECRET?: string;
      BUSINESS_TIMEZONE?: string;
    }
  }
}
