import type { server } from '../../apps/server/alchemy.run';

// This file infers types for the cloudflare:workers environment from your Alchemy Worker.
// @see https://alchemy.run/concepts/bindings/#type-safe-bindings

export type CloudflareEnv = typeof server.Env & {
  ACCOUNT_AUTH_MODE?: string;
  ACCOUNT_TOTP_ENCRYPTION_KEY?: string;
  ACCOUNT_TOTP_KEY_VERSION?: string;
  ACCOUNT_TOTP_ENCRYPTION_KEYS?: string;
  CASE_BUCKET?: R2Bucket;
  TELEGRAM_MODE?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_TOKEN_ENCRYPTION_KEY?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  BUSINESS_TIMEZONE?: string;
  IMAGE_EXTRACTION_MODE?: string;
  OPENAI_API_KEY?: string;
  OPENAI_IMAGE_MODEL?: string;
  OPENAI_REQUEST_TIMEOUT_MS?: string;
  OPENAI_MAX_RETRIES?: string;
};

declare global {
  type Env = CloudflareEnv;
}

declare module 'cloudflare:workers' {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {
      CASE_BUCKET?: R2Bucket;
      TELEGRAM_MODE?: string;
      TELEGRAM_BOT_TOKEN?: string;
      TELEGRAM_WEBHOOK_SECRET?: string;
      BUSINESS_TIMEZONE?: string;
    }
  }
}
