// Auto-generated Cloudflare binding types.
// @see https://alchemy.run/concepts/bindings/#type-safe-bindings

import type { server } from './alchemy.run.ts';

export type ServerEnv = typeof server.Env & {
  TELEGRAM_OCR_ENABLED?: string;
  TELEGRAM_OCR_AUTO_CREATE?: string;
  TELEGRAM_OCR_BATCH_REPORTS?: string;
  TELEGRAM_OCR_ATTACH_IMAGES?: string;
  TELEGRAM_OCR_FAST_START?: string;
    TELEGRAM_OCR_REVIEW_MODE?: string;
    TELEGRAM_OCR_RELEASE_PROBE_SECRET?: string;
    TELEGRAM_OCR_RELEASE_ID?: string;
  BULK_OCR_ENABLED?: string;
  BULK_OCR_PRIVACY_APPROVED?: string;
  BULK_OCR_MODEL?: string;
  GOOGLE_VISION_API_KEY?: string;
  ACCESS_ACCOUNT_ID?: string;
  ACCESS_GROUP_ID?: string;
  ACCESS_API_TOKEN?: string;
  ACCESS_APPLICATION_ID?: string;
  ACCESS_HOSTNAME?: string;
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
