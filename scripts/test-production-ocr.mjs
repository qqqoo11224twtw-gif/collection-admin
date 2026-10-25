import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(
  realpathSync(resolve(root, 'node_modules/wrangler/package.json')),
);
const { Miniflare } = require('miniflare');
const directory = resolve(root, '../production-restored');
const mf = new Miniflare({
  modulesRoot: resolve(directory, 'api'),
  modules: [
    { type: 'ESModule', path: resolve(directory, 'api/worker.js') },
    { type: 'ESModule', path: resolve(directory, 'api/legacy-api.js') },
  ],
  compatibilityDate: '2026-04-01',
  compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
  bindings: {
    AUTH_MODE: 'open',
    ACCOUNT_AUTH_MODE: 'managed',
    BETTER_AUTH_SECRET: 'local-production-smoke-test-only',
    CORS_ORIGIN: 'http://localhost:3000',
    SERVER_URL: 'http://localhost:4100',
    TELEGRAM_MODE: 'fake',
    TELEGRAM_WEBHOOK_SECRET: 'smoke-test-only',
    TELEGRAM_OCR_ENABLED: 'false',
  },
  d1Databases: ['DB'],
  kvNamespaces: ['KV'],
  r2Buckets: ['CASE_BUCKET'],
});
try {
  const health = await mf.dispatchFetch('http://localhost/health');
  assert.equal(health.status, 200);
  const auth = await mf.dispatchFetch('http://localhost/rpc/cases/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"json":{}}',
  });
  assert.equal(auth.status, 401);
  const webhook = await mf.dispatchFetch(
    'http://localhost/api/telegram/webhook',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  assert.equal(webhook.status, 401);
  const db = await mf.getD1Database('DB');
  const folder = resolve(root, 'packages/db/migrations');
  for (const file of readdirSync(folder)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const queries = readFileSync(resolve(folder, file), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const query of queries) await db.prepare(query).run();
  }
  const ocrQueries=readFileSync(resolve(root,'deploy/telegram-ocr/migration.sql'),'utf8').replace(/--[^\n]*/g,'').split(';').map(q=>q.trim()).filter(Boolean);
  for(const query of ocrQueries) await db.prepare(query).run();
  const created = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='telegram_ocr_jobs'",
    )
    .first();
  assert.equal(created.name, 'telegram_ocr_jobs');
  console.log(
    JSON.stringify({
      health: 200,
      unauthenticatedCases: 401,
      invalidWebhookSecret: 401,
      existingMigrationsApplied: true,
      ocrAdditiveSchemaApplied: true,
      productionTouched: false,
    }),
  );
} finally {
  await mf.dispose();
}
