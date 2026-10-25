import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const root = resolve(import.meta.dirname, '..');
process.chdir(root);
const output = resolve(root, '../production-restored');
const baseline = resolve(root, '../production-backup/2026-10-25T07-26-10-034Z');
const account = 'b40151c62acbc2316d833cb980dac6f5';
const names = {
  api: 'collection-admin-production-api',
  web: 'collection-admin-production-web',
};
const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/`;
const vars = parseEnv(
  readFileSync(resolve(root, 'apps/server/.dev.vars'), 'utf8'),
);
const token = vars.CLOUDFLARE_API_TOKEN?.trim();
const releaseId = new Date().toISOString().replace(/[:.]/g, '-');
const probe = randomBytes(32).toString('hex');
const privateDirectory = resolve(
  root,
  '.secrets/production-releases',
  releaseId,
);
let phase = 'local-checks';
const state = {
  releaseId,
  phase,
  productionChanged: false,
  completed: false,
  original: {},
  deployed: {},
  rolledBack: {},
};
function save() {
  mkdirSync(privateDirectory, { recursive: true });
  state.phase = phase;
  writeFileSync(
    resolve(privateDirectory, 'state.json'),
    JSON.stringify(state, null, 2),
  );
}
function run(file, args = []) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean))
    if (/^(CLOUDFLARE_|OPENAI_|GOOGLE_|TELEGRAM_)/.test(key)) delete clean[key];
  const result = spawnSync(process.execPath, [resolve(root, file), ...args], {
    cwd: root,
    env: clean,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) throw Error('LOCAL_CHECK_FAILED');
}
async function api(name, path, options = {}) {
  const response = await fetch(apiRoot + name + path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw Error(`CLOUDFLARE_HTTP_${response.status}`);
  const value = await response.json();
  if (!value.success) throw Error('CLOUDFLARE_REQUEST_REJECTED');
  return value.result;
}
async function active(name) {
  const value = await api(name, '/deployments');
  const versions = value.deployments?.[0]?.versions;
  if (versions?.length !== 1 || versions[0].percentage !== 100)
    throw Error('GRADUAL_OR_UNKNOWN_DEPLOYMENT');
  return versions[0].version_id;
}
function files(directory, prefix = '') {
  const result = [];
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix + item.name;
    if (item.isDirectory())
      result.push(...files(resolve(directory, item.name), relative + '/'));
    else if (relative.endsWith('.js'))
      result.push({
        name: relative,
        bytes: readFileSync(resolve(directory, item.name)),
      });
  }
  return result;
}
function metadata(settings, entry, enabled, apiWorker) {
  const replaced = new Set([
    'TELEGRAM_OCR_ENABLED',
    'TELEGRAM_OCR_REVIEW_MODE',
    'GOOGLE_VISION_API_KEY',
    'OPENAI_API_KEY',
    'BULK_OCR_MODEL',
    'BULK_OCR_PRIVACY_APPROVED',
    'TELEGRAM_OCR_RELEASE_PROBE_SECRET',
    'TELEGRAM_OCR_RELEASE_ID',
  ]);
  const bindings = (settings.bindings ?? []).filter(
    (binding) =>
      binding.type !== 'secret_text' &&
      (!apiWorker || !replaced.has(binding.name)),
  );
  if (apiWorker) {
    bindings.push(
      ...Object.entries({
        TELEGRAM_OCR_ENABLED: enabled ? 'true' : 'false',
        TELEGRAM_OCR_REVIEW_MODE: 'backend',
        BULK_OCR_MODEL: vars.BULK_OCR_MODEL,
        BULK_OCR_PRIVACY_APPROVED: 'true',
        TELEGRAM_OCR_RELEASE_ID: releaseId,
      }).map(([name, text]) => ({ name, type: 'plain_text', text })),
    );
    bindings.push(
      ...Object.entries({
        GOOGLE_VISION_API_KEY: vars.GOOGLE_VISION_API_KEY,
        OPENAI_API_KEY: vars.OPENAI_API_KEY,
        TELEGRAM_OCR_RELEASE_PROBE_SECRET: probe,
      }).map(([name, text]) => ({ name, type: 'secret_text', text })),
    );
  }
  const result = {
    main_module: entry,
    bindings,
    keep_bindings: ['secret_text'],
    keep_assets: true,
    compatibility_date: settings.compatibility_date,
    compatibility_flags: settings.compatibility_flags ?? [],
    annotations: {
      'workers/message': `Telegram OCR backend review ${releaseId}`,
    },
  };
  for (const key of [
    'observability',
    'limits',
    'placement',
    'logpush',
    'tail_consumers',
  ])
    if (settings[key] !== undefined) result[key] = settings[key];
  return result;
}
async function upload(kind, settings, enabled) {
  const form = new FormData();
  form.append(
    'metadata',
    new Blob(
      [
        JSON.stringify(
          metadata(
            settings,
            kind === 'api' ? 'worker.js' : 'index.js',
            enabled,
            kind === 'api',
          ),
        ),
      ],
      { type: 'application/json' },
    ),
  );
  for (const file of files(resolve(output, kind))) {
    if (file.name === 'index.js' && kind === 'api') continue;
    form.append(
      file.name,
      new Blob([file.bytes], { type: 'application/javascript+module' }),
      file.name,
    );
  }
  const result = await api(names[kind], '/versions', {
    method: 'POST',
    body: form,
  });
  if (!result.id) throw Error('VERSION_UPLOAD_FAILED');
  return result.id;
}
async function deploy(kind, version, expected) {
  if ((await active(names[kind])) !== expected)
    throw Error('CONCURRENT_PRODUCTION_CHANGE');
  // A lost response may still have applied the deployment; retain its ID for recovery.
  state.productionChanged = true;
  state.deployed[kind] = version;
  save();
  await api(names[kind], '/deployments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      strategy: 'percentage',
      versions: [{ version_id: version, percentage: 100 }],
      annotations: { 'workers/message': `Telegram OCR release ${releaseId}` },
    }),
  });
  state.productionChanged = true;
  state.deployed[kind] = version;
  save();
  if ((await active(names[kind])) !== version)
    throw Error('DEPLOYMENT_NOT_ACTIVE');
}
async function readiness(enabled) {
  const response = await fetch(
    'https://api.kpirich.bid/api/telegram-ocr/release-check',
    {
      headers: { 'X-OCR-Release-Probe': probe },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!response.ok) throw Error('READINESS_HTTP_FAILED');
  const value = await response.json();
  if (
    value.releaseId !== releaseId ||
    !value.schemaReady ||
    !value.botReady ||
    !value.providersConfigured ||
    value.reviewMode !== 'backend' ||
    value.enabled !== enabled
  )
    throw Error('OCR_READINESS_FAILED');
}
async function rollback() {
  for (const kind of ['web', 'api'])
    if (state.deployed[kind]) {
      try {
        if ((await active(names[kind])) !== state.deployed[kind]) {
          state.rolledBack[kind] = 'SKIPPED_CONCURRENT_CHANGE';
          continue;
        }
        await deploy(kind, state.original[kind], state.deployed[kind]);
        state.rolledBack[kind] = true;
      } catch {
        state.rolledBack[kind] = 'FAILED_REQUIRES_OPERATOR';
      }
    }
  save();
}
try {
  if (
    !token ||
    !vars.GOOGLE_VISION_API_KEY ||
    !vars.OPENAI_API_KEY ||
    !vars.BULK_OCR_MODEL ||
    vars.BULK_OCR_PRIVACY_APPROVED !== 'true'
  )
    throw Error('REQUIRED_LOCAL_CONFIGURATION_MISSING');
  run('scripts/check-local-ocr-env.mjs');
  run('scripts/build-production-ocr.mjs');
  run('scripts/test-bulk-ocr.mjs');
  run('scripts/test-telegram-ocr-flow.mjs');
  run('scripts/test-production-release.mjs');
  run('scripts/test-production-ocr.mjs');
  if (!process.argv.includes('--deploy')) {
    console.log(
      'CHECKS_PASSED: no production changes; run with --deploy to publish.',
    );
    process.exit(0);
  }
  phase = 'baseline-check';
  save();
  const settings = {};
  for (const kind of ['api', 'web']) {
    state.original[kind] = await active(names[kind]);
    const expected = JSON.parse(
      readFileSync(resolve(baseline, names[kind], 'deployments.json'), 'utf8'),
    ).result.deployments[0].versions[0].version_id;
    if (state.original[kind] !== expected)
      throw Error('PRODUCTION_BASELINE_CHANGED');
    settings[kind] = await api(names[kind], '/settings');
  }
  const cors =
    settings.api.bindings.find(
      (binding) =>
        binding.name === 'CORS_ORIGIN' && binding.type === 'plain_text',
    )?.text ?? '';
  if (
    !cors
      .split(',')
      .map((value) => value.trim())
      .includes('https://admin.kpirich.bid')
  )
    throw Error('PRODUCTION_CORS_CONFIGURATION_MISMATCH');
  const db = settings.api.bindings.find(
    (binding) => binding.name === 'DB' && binding.type === 'd1',
  );
  if (db?.id !== '16b9cba4-9223-4cea-b969-5cc3dfe25872')
    throw Error('DATABASE_BINDING_MISMATCH');
  const receipt = JSON.parse(
    readFileSync(resolve(output, 'schema-prepared.json'), 'utf8'),
  );
  const migrationHash = createHash('sha256')
    .update(readFileSync(resolve(root, 'deploy/telegram-ocr/migration.sql')))
    .digest('hex');
  if (
    receipt.databaseId !== db.id ||
    receipt.migrationHash !== migrationHash ||
    !receipt.bookmark
  )
    throw Error('SCHEMA_BACKUP_RECEIPT_MISSING');
  save();
  phase = 'provider-check';
  run('scripts/verify-ocr-providers.mjs');
  phase = 'api-feature-off';
  console.log(
    'Publishing API with OCR disabled; existing bindings and secrets retained.',
  );
  const candidate = await upload('api', settings.api, false);
  await deploy('api', candidate, state.original.api);
  await readiness(false);
  phase = 'web-extension';
  console.log(
    'Publishing review page while retaining existing frontend modules and static assets.',
  );
  const web = await upload('web', settings.web, false);
  await deploy('web', web, state.original.web);
  const page = await fetch(
    'https://admin.kpirich.bid/cases/bulk-create/telegram',
    {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    },
  );
  if (page.status !== 200 || !(await page.text()).includes('/_telegram-ocr.js'))
    throw Error('REVIEW_PAGE_FAILED');
  const script = await fetch('https://admin.kpirich.bid/_telegram-ocr.js', {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!script.ok || !(await script.text()).includes('/api/telegram-ocr'))
    throw Error('REVIEW_SCRIPT_FAILED');
  phase = 'enable-ocr';
  const live = await upload('api', settings.api, true);
  await deploy('api', live, candidate);
  await readiness(true);
  const health = await fetch('https://api.kpirich.bid/health', {
    signal: AbortSignal.timeout(20000),
  });
  if (health.status !== 200) throw Error('HEALTH_CHECK_FAILED');
  const denied = await fetch('https://api.kpirich.bid/api/telegram-ocr/jobs', {
    signal: AbortSignal.timeout(20000),
  });
  if (denied.status !== 401) throw Error('UNAUTHENTICATED_ACCESS_NOT_DENIED');
  phase = 'complete';
  state.completed = true;
  state.entry = 'https://admin.kpirich.bid/cases/bulk-create/telegram';
  save();
  writeFileSync(
    resolve(output, 'deployment-result.json'),
    JSON.stringify(
      {
        releaseId,
        completed: true,
        apiVersion: live,
        webVersion: web,
        entry: state.entry,
        existingWebhookChanged: false,
        realImageAccuracyVerified: false,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      completed: true,
      entry: state.entry,
      existingWebhookChanged: false,
      realImageAccuracyVerified: false,
    }),
  );
} catch (error) {
  const code =
    error instanceof Error && /^[A-Z_]+(?:_\d+)?$/.test(error.message)
      ? error.message
      : 'RELEASE_FAILED_CREDENTIALS_OMITTED';
  if (state.productionChanged) await rollback();
  save();
  console.error(
    JSON.stringify({
      completed: false,
      phase,
      error: code,
      productionChanged: state.productionChanged,
      rolledBack: state.rolledBack,
      credentialsPrinted: false,
    }),
  );
  process.exitCode = 1;
}
