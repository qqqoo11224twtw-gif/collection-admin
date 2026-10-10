import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(async () => {
  const migrationsPath = path.resolve(
    __dirname,
    '../../packages/db/migrations',
  );
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        main: './src/index.ts',
        miniflare: {
          // External HTTP fixture; D1/KV/R2 still use real Workers bindings.
          outboundService: 'telegram-api-fixture',
          workers: [
            {
              name: 'telegram-api-fixture',
              modules: true,
              compatibilityDate: '2026-04-01',
              script: readFileSync(
                path.resolve(__dirname, 'tests/telegram-api-fixture.js'),
                'utf8',
              ),
            },
          ],
          compatibilityDate: '2025-01-01',
          // The pool force-enables the runner-support flags anyway and prints
          // a noisy `[vpw:debug] Adding …` line for each missing one — declare
          // them up front so the test output stays quiet.
          compatibilityFlags: [
            'nodejs_compat',
            'enable_nodejs_tty_module',
            'enable_nodejs_fs_module',
            'enable_nodejs_http_modules',
            'enable_nodejs_perf_hooks_module',
            'enable_nodejs_v8_module',
            'enable_nodejs_process_v2',
          ],
          bindings: {
            CORS_ORIGIN: 'http://localhost:3000',
            SERVER_URL: 'http://localhost',
            // Tests default to the template default; mode-specific suites
            // mutate env.AUTH_MODE per test (authMode() reads it lazily).
            AUTH_MODE: 'open',
            BETTER_AUTH_SECRET: 'test-secret',
            // Messy on purpose: the whitelist must trim + lowercase entries.
            ADMIN_EMAILS: ' Boss@Test.dev ',
            ACCOUNT_AUTH_MODE: 'legacy-test',
            RESEND_API_KEY: '',
            EMAIL_FROM: '',
            CASE_STORAGE_MODE: 'demo',
            TELEGRAM_MODE: 'fake',
            TELEGRAM_WEBHOOK_SECRET: 'test-webhook-placeholder',
            BUSINESS_TIMEZONE: 'Asia/Taipei',
            TEST_MIGRATIONS: migrations,
            // Dummy R2 credentials so storage.presign can be smoke-tested.
            // getSignedUrl() signs locally (no network), so fake values are
            // enough to exercise the @aws-sdk/* code path end-to-end.
            R2_ACCOUNT_ID: 'test-account',
            R2_ACCESS_KEY_ID: 'test-access-key',
            R2_SECRET_ACCESS_KEY: 'test-secret-key',
            R2_BUCKET_NAME: 'test-bucket',
          },
          d1Databases: {
            MIGRATION_DB: { id: 'migration-compatibility-db' },
            DB: {
              id: 'test-db',
            },
          },
          kvNamespaces: {
            KV: {
              id: 'test-kv',
            },
          },
          r2Buckets: {
            CASE_BUCKET: { id: 'case-private-test' },
            BUCKET: {
              id: 'test-bucket',
            },
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./tests/setup.ts'],
      // False-positive filter: oRPC / better-auth convert thrown errors
      // (ORPCError 401/403, better-auth APIError) into proper HTTP responses
      // — the tests assert those responses — but the workers pool still
      // reports the rejected promise as an unhandled rejection and fails the
      // run. Ignore exactly those shapes; anything else still fails.
      onUnhandledError(error: unknown) {
        const e = error as {
          code?: unknown;
          status?: unknown;
          statusCode?: unknown;
        };
        const isOrpcError =
          typeof e.code === 'string' && typeof e.status === 'number';
        const isBetterAuthApiError =
          typeof e.statusCode === 'number' && typeof e.status === 'string';
        if (isOrpcError || isBetterAuthApiError) return false;
      },
    },
  };
});
