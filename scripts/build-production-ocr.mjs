import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const backup = resolve(root, '../production-backup/2026-10-25T07-26-10-034Z');
const destination = resolve(root, '../production-restored');
const require = createRequire(
  realpathSync(resolve(root, 'node_modules/wrangler/package.json')),
);
const { build } = require('esbuild');
const source = readFileSync(
  resolve(backup, 'collection-admin-production-api/modules/index.js'),
);
const baselineHash = createHash('sha256').update(source).digest('hex');
const suffix =
  '\nexport { createContext, telegramPrincipal, requirePermission, botClientForRoute, telegramClient, createBulkCases };\n';
for (const symbol of [
  'createContext',
  'telegramPrincipal',
  'requirePermission',
  'botClientForRoute',
  'telegramClient',
  'createBulkCases',
])
  if (!source.toString().includes(`function ${symbol}(`))
    throw Error('EXPECTED_PRODUCTION_EXPORT_MISSING');
mkdirSync(resolve(destination, 'api'), { recursive: true });
writeFileSync(
  resolve(destination, 'api/legacy-api.js'),
  Buffer.concat([source, Buffer.from(suffix)]),
);
await build({
  entryPoints: [resolve(root, 'deploy/telegram-ocr/worker.ts')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  outfile: resolve(destination, 'api/worker.js'),
  external: ['cloudflare:workers', './legacy-api.js'],
  logLevel: 'silent',
});
const settings = JSON.parse(
  readFileSync(
    resolve(backup, 'collection-admin-production-api/settings.json'),
    'utf8',
  ),
).result;
const config = {
  name: 'collection-admin-production-api',
  account_id: 'b40151c62acbc2316d833cb980dac6f5',
  main: 'api/worker.js',
  no_bundle: true,
  find_additional_modules: true,
  rules: [{ type: 'ESModule', globs: ['**/*.js'], fallthrough: true }],
  keep_vars: true,
  compatibility_date: settings.compatibility_date,
  compatibility_flags: settings.compatibility_flags,
  vars: Object.fromEntries(
    settings.bindings
      .filter((b) => b.type === 'plain_text')
      .map((b) => [b.name, b.text]),
  ),
  d1_databases: settings.bindings
    .filter((b) => b.type === 'd1')
    .map((b) => ({
      binding: b.name,
      database_id: b.id,
      database_name: 'collection-admin-production-db',
    })),
  kv_namespaces: settings.bindings
    .filter((b) => b.type === 'kv_namespace')
    .map((b) => ({ binding: b.name, id: b.namespace_id })),
  r2_buckets: settings.bindings
    .filter((b) => b.type === 'r2_bucket')
    .map((b) => ({ binding: b.name, bucket_name: b.bucket_name })),
  workers_dev: false,
  preview_urls: false,
  observability: settings.observability,
};
// OCR remains off in the generated configuration until production preflight succeeds.
config.vars.TELEGRAM_OCR_ENABLED = 'false';
config.vars.TELEGRAM_OCR_REVIEW_MODE = 'backend';
writeFileSync(
  resolve(destination, 'wrangler.jsonc'),
  JSON.stringify(config, null, 2),
);
copyFileSync(
  resolve(root, 'deploy/telegram-ocr/migration.sql'),
  resolve(destination, 'migration.sql'),
);
const candidateHash = createHash('sha256')
  .update(readFileSync(resolve(destination, 'api/worker.js')))
  .digest('hex');
const manifest = {
  baselineSource: 'production-backup/2026-10-25T07-26-10-034Z',
  baselineHash,
  candidateHash,
  baselineBytesPreserved: true,
  featureEnabled: false,
  deployed: false,
  sourceMapsRecovered: false,
};
writeFileSync(
  resolve(destination, 'build-manifest.json'),
  JSON.stringify(manifest, null, 2),
);
console.log(JSON.stringify(manifest, null, 2));

const webSource = resolve(backup, 'collection-admin-production-web/modules');
const webDestination = resolve(destination, 'web');
cpSync(webSource, webDestination, { recursive: true });
copyFileSync(
  resolve(webDestination, 'index.js'),
  resolve(webDestination, 'legacy-web.js'),
);
await build({
  entryPoints: [resolve(root, 'deploy/telegram-ocr/web-worker.ts')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  outfile: resolve(webDestination, 'index.js'),
  external: ['./legacy-web.js'],
  plugins: [
    {
      name: 'review-text',
      setup(builder) {
        builder.onResolve({ filter: /(review|entry)\.js\.txt$/ }, (args) => ({
          path: resolve(root, 'deploy/telegram-ocr', args.path.endsWith('entry.js.txt') ? 'entry.js' : 'review.js'),
          namespace: 'review-text',
        }));
        builder.onLoad(
          { filter: /.*/, namespace: 'review-text' },
          ({ path }) => ({
            contents: readFileSync(path, 'utf8'),
            loader: 'text',
          }),
        );
      },
    },
  ],
  loader: { '.html': 'text' },
  logLevel: 'silent',
});
const webConfig = {
  name: 'collection-admin-production-web',
  account_id: config.account_id,
  main: 'web/index.js',
  no_bundle: true,
  find_additional_modules: true,
  rules: config.rules,
  keep_vars: true,
  compatibility_date: '2026-04-01',
  compatibility_flags: ['nodejs_compat'],
  workers_dev: false,
  preview_urls: false,
};
writeFileSync(
  resolve(destination, 'wrangler-web.jsonc'),
  JSON.stringify(webConfig, null, 2),
);
