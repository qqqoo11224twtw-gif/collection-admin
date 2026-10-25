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
let stopRequested = false,
  recovering = false;
process.on?.('SIGINT', () => {
  stopRequested = true;
  console.log('收到停止要求，將先完成必要的版本回復。');
});
process.on?.('message', (message) => {
  if (message?.type === 'cancel-release') stopRequested = true;
});

process.channel?.unref();
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
  state.currentCheck = file;
  save();
  const clean = { ...process.env };
  for (const key of Object.keys(clean))
    if (/^(CLOUDFLARE_|OPENAI_|GOOGLE_|TELEGRAM_)/.test(key)) delete clean[key];
  const result = spawnSync(process.execPath, [resolve(root, file), ...args], {
    cwd: root,
    env: clean,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    state.failedCheck = file;
    state.checkExitCode = result.status;
    throw Error('LOCAL_CHECK_FAILED');
  }
}
async function api(name, path, options = {}) {
  if (stopRequested && !recovering) throw Error('RELEASE_CANCELLED');
  state.operation = `${options.method ?? 'GET'} ${name}${path}`;
  save();
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
async function verifyWebModules() {
  state.operation='verify-deployed-web-modules';save();
  const response=await fetch(apiRoot+names.web+'/content/v2',{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw Error(`WEB_CONTENT_HTTP_${response.status}`);
  if(!response.headers.get('Content-Type')?.startsWith('multipart/form-data'))throw Error('WEB_CONTENT_FORMAT_UNEXPECTED');
  const actual=await response.formData();
  for(const file of files(resolve(output,'web'))) {
    const part=actual.get(file.name);if(!part)throw Error('DEPLOYED_WEB_MODULE_MISSING');
    const bytes=typeof part==='string'?Buffer.from(part):Buffer.from(await part.arrayBuffer());
    if(createHash('sha256').update(bytes).digest('hex')!==createHash('sha256').update(file.bytes).digest('hex'))throw Error('DEPLOYED_WEB_MODULE_MISMATCH');
  }
  state.webModulesVerified=true;save();
}
function expectedAccessRedirect(response) {
  if(![301,302,303,307,308].includes(response.status))return false;
  try {const location=new URL(response.headers.get('Location'));return location.protocol==='https:'&&location.hostname==='falling-smoke-c05c.cloudflareaccess.com'&&location.pathname.startsWith('/cdn-cgi/access/login/admin.kpirich.bid');}catch{return false;}
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
  recovering = true;
  console.log('正在恢復發布前版本，請勿關閉視窗。');
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
  if (!token) throw Error('CLOUDFLARE_CONFIGURATION_MISSING');
  run('scripts/check-local-ocr-env.mjs');
  run('scripts/build-production-ocr.mjs');
  run('scripts/test-ocr-interface.mjs');
  run('scripts/test-ocr-diagnostics.mjs');
  run('scripts/test-real-ocr-sample.mjs');
  run('scripts/test-bulk-ocr.mjs');
  run('scripts/test-telegram-ocr-flow.mjs');
  const receipt=JSON.parse(readFileSync(resolve(output,'deployment-result.json'),'utf8'));
  if (!receipt.completed) throw Error('OCR_RELEASE_NOT_COMPLETE');
  state.original.web=await active(names.web);
  if(state.original.web!==receipt.webVersion)throw Error('PRODUCTION_BASELINE_CHANGED');
  const originalApi=await active(names.api);
  if(originalApi!==receipt.apiVersion)throw Error('API_BASELINE_CHANGED');
  state.original.api=originalApi;
  const apiSettings=await api(names.api,'/settings');
  const apiVersion=await upload('api',apiSettings,true);
  await deploy('api',apiVersion,originalApi);
  await readiness(true);
  const settings=await api(names.web,'/settings');
  phase='web-interface-update';save();
  console.log('Updating the existing backend interface. OCR diagnostics and output budget are being updated; database and Telegram settings are unchanged.');
  const version=await upload('web',settings,false);
  await deploy('web',version,state.original.web);
  await verifyWebModules();
  if(await active(names.api)!==apiVersion)throw Error('API_CHANGED_DURING_RELEASE');
  state.completed=true;save();
  const result={...receipt,apiVersion,recognitionDiagnostics:true,webVersion:version,interfaceIntegrated:true,browserAcceptancePending:true,previousWebVersion:state.original.web};
  writeFileSync(resolve(output,'deployment-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({completed:true,interfaceIntegrated:true,apiChanged:true,databaseChanged:false,browserAcceptancePending:true}));
} catch(error) {
  state.error=String(error.message||'UNKNOWN').replace(/[^A-Z0-9_]/g,'').slice(0,100);save();
  if(state.productionChanged)await rollback();
  console.error(JSON.stringify({completed:false,error:state.error,rolledBack:state.rolledBack}));
  process.exitCode=1;
}
