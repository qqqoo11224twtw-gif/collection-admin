import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { runInNewContext } from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(
  resolve(root, 'scripts/release-production-ocr.mjs'),
  'utf8',
)
  .replace(/^import[\s\S]*?;\r?\n/gm, '')
  .replaceAll('import.meta.dirname', JSON.stringify(resolve(root, 'scripts')));
async function scenario(lostWebResponse, accessMode = false) {
  const logs = [],
    writes = new Map(),
    versions = new Map();
  let usedFault = false,
    counter = 0;
  const uploadedForms = new Map();
  const original = {},
    current = {},
    settings = {};
  for (const kind of ['api', 'web']) {
    const base = resolve(
      root,
      '../production-backup/2026-10-25T07-26-10-034Z',
      `collection-admin-production-${kind}`,
    );
    original[kind] = JSON.parse(
      readFileSync(resolve(base, 'deployments.json'), 'utf8'),
    ).result.deployments[0].versions[0].version_id;
    current[kind] = original[kind];
    settings[kind] = JSON.parse(
      readFileSync(resolve(base, 'settings.json'), 'utf8'),
    ).result;
  }
  const processStub = {
    argv: ['node', 'release', '--deploy'],
    env: {},
    execPath: process.execPath,
    exitCode: 0,
    chdir() {},
    exit() {
      throw Error('UNEXPECTED_EXIT');
    },
  };
  const cf = (result) => Response.json({ success: true, result });
  const send = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('https://api.cloudflare.com/client/v4/accounts/')) {
      assert.equal(options.headers.Authorization, 'Bearer fixture-cloudflare');
      const kind = target.includes('collection-admin-production-api')
        ? 'api'
        : 'web';
      if (
        target.endsWith('/deployments') &&
        (!options.method || options.method === 'GET')
      )
        return cf({
          deployments: [
            { versions: [{ version_id: current[kind], percentage: 100 }] },
          ],
        });
      if (target.endsWith('/content/v2')) return new Response(uploadedForms.get(current.web));
      if (target.endsWith('/settings')) return cf(settings[kind]);
      if (target.endsWith('/versions')) {
        const meta = JSON.parse(await options.body.get('metadata').text());
        assert.equal(meta.keep_assets, true);
        assert.ok(meta.keep_bindings.includes('secret_text'));
        if (kind === 'api') {
          assert.ok(
            meta.bindings.some(
              (binding) => binding.name === 'DB' && binding.type === 'd1',
            ),
          );
          for (const name of ['GOOGLE_VISION_API_KEY', 'OPENAI_API_KEY'])
            assert.equal(
              meta.bindings.find((binding) => binding.name === name).type,
              'secret_text',
            );
        }
        const id = `fixture-${kind}-${++counter}`;
        versions.set(id, meta);
        uploadedForms.set(id, options.body);
        return cf({ id });
      }
      if (target.endsWith('/deployments') && options.method === 'POST') {
        const value = JSON.parse(options.body);
        assert.equal(value.versions[0].percentage, 100);
        current[kind] = value.versions[0].version_id;
        if (kind === 'web' && lostWebResponse && !usedFault) {
          usedFault = true;
          throw Error('SIMULATED_LOST_DEPLOYMENT_RESPONSE');
        }
        return cf({ id: 'deployment' });
      }
      throw Error('UNEXPECTED_CLOUDFLARE_REQUEST');
    }
    if (target.endsWith('/release-check')) {
      const meta = versions.get(current.api),
        bindings = Object.fromEntries(
          meta.bindings.map((binding) => [binding.name, binding.text]),
        );
      assert.equal(
        options.headers['X-OCR-Release-Probe'],
        bindings.TELEGRAM_OCR_RELEASE_PROBE_SECRET,
      );
      return Response.json({
        releaseId: bindings.TELEGRAM_OCR_RELEASE_ID,
        schemaReady: true,
        botReady: true,
        providersConfigured: true,
        reviewMode: 'backend',
        enabled: bindings.TELEGRAM_OCR_ENABLED === 'true',
      });
    }
    if (target === 'https://admin.kpirich.bid/cases/bulk-create/telegram' && accessMode) return new Response(null,{status:302,headers:{Location: accessMode==='valid' ? 'https://falling-smoke-c05c.cloudflareaccess.com/cdn-cgi/access/login/admin.kpirich.bid?fixture=1' : 'https://untrusted.invalid/login'}});
    if (target === 'https://admin.kpirich.bid/cases/bulk-create/telegram')
      return new Response(
        readFileSync(resolve(root, 'deploy/telegram-ocr/review.html'), 'utf8'),
      );
    if (target === 'https://admin.kpirich.bid/_telegram-ocr.js')
      return new Response(
        readFileSync(resolve(root, 'deploy/telegram-ocr/review.js'), 'utf8'),
      );
    if (target === 'https://api.kpirich.bid/health') return new Response('ok');
    if (target === 'https://api.kpirich.bid/api/telegram-ocr/jobs')
      return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
    throw Error('UNEXPECTED_EXTERNAL_DESTINATION');
  };
  const sandbox = {
    spawnSync: () => ({ status: 0 }),
    createHash,
    randomBytes,
    mkdirSync() {},
    readdirSync,
    readFileSync: (path, encoding) =>
      String(path).endsWith('.dev.vars')
        ? 'CLOUDFLARE_API_TOKEN=fixture-cloudflare\nGOOGLE_VISION_API_KEY=fixture-google\nOPENAI_API_KEY=fixture-openai\nBULK_OCR_MODEL=fixture-model\nBULK_OCR_PRIVACY_APPROVED=true'
        : readFileSync(path, encoding),
    writeFileSync: (path, value) => writes.set(String(path), String(value)),
    resolve,
    parseEnv,
    process: processStub,
    fetch: send,
    AbortSignal,
    Blob,
    FormData,
    Buffer,
    URL,
    Date,
    console: {
      log: (value) => logs.push(String(value)),
      error: (value) => logs.push(String(value)),
    },
  };
  await runInNewContext(`(async()=>{${source}\n})()`, sandbox);
  const state = JSON.parse(
    [...writes.entries()].find(([path]) => path.endsWith('state.json'))[1],
  );
  if (lostWebResponse || accessMode==='invalid') {
    assert.equal(processStub.exitCode, 1);
    assert.equal(state.completed, false);
    assert.equal(current.api, original.api);
    assert.equal(current.web, original.web);
    assert.equal(state.rolledBack.web, true);
    assert.equal(state.rolledBack.api, true);
  } else {
    assert.equal(processStub.exitCode, 0);
    assert.equal(state.completed, true);
    assert.notEqual(current.api, original.api);
    assert.notEqual(current.web, original.web);
  }
  assert.ok(!logs.join('\n').includes('fixture-cloudflare'));
  assert.ok(!logs.join('\n').includes('fixture-google'));
  assert.ok(!logs.join('\n').includes('fixture-openai'));
}
await scenario(false);
await scenario(true);
await scenario(false,'valid');
await scenario(false,'invalid');
console.log(
  JSON.stringify({
    releaseSuccessProtocolPassed: true,
    expectedAccessRedirectVerified: true,
    unexpectedRedirectRejected: true,
    deployedModuleHashesVerified: true,
    lostDeploymentResponseRollbackPassed: true,
    bindingsAndAssetRetentionChecked: true,
    credentialsNotLogged: true,
    realCloudflareRequests: false,
  }),
);
