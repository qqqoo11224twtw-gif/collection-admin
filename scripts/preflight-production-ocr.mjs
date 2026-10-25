import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const root = resolve(import.meta.dirname, '..');
process.chdir(root);
const vars = parseEnv(
  readFileSync(resolve(root, 'apps/server/.dev.vars'), 'utf8'),
);
const token = vars.CLOUDFLARE_API_TOKEN?.trim();
const apiRoot =
  'https://api.cloudflare.com/client/v4/accounts/b40151c62acbc2316d833cb980dac6f5';
async function request(path, body) {
  const response = await fetch(apiRoot + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw Error(`CLOUDFLARE_HTTP_${response.status}`);
  const result = await response.json();
  if (!result.success) throw Error('CLOUDFLARE_REQUEST_REJECTED');
  return result.result;
}
try {
  if (!token) throw Error('CLOUDFLARE_TOKEN_MISSING');
  const clean = { ...process.env };
  for (const name of Object.keys(clean))
    if (/^(CLOUDFLARE_|OPENAI_|GOOGLE_|TELEGRAM_)/.test(name))
      delete clean[name];
  const test = spawnSync(
    process.execPath,
    [resolve(root, 'scripts/test-production-ocr.mjs')],
    { cwd: root, env: clean, stdio: 'inherit', windowsHide: true },
  );
  if (test.status !== 0) throw Error('LOCAL_SMOKE_TEST_FAILED');
  const manifest = JSON.parse(
    readFileSync(
      resolve(root, '../production-restored/build-manifest.json'),
      'utf8',
    ),
  );
  const settings = await request(
    '/workers/scripts/collection-admin-production-api/settings',
  );
  const db = settings.bindings.find(
    (binding) => binding.type === 'd1' && binding.name === 'DB',
  );
  if (!db?.id) throw Error('PRODUCTION_DATABASE_NOT_FOUND');
  async function query(sql) {
    const result = await request(`/d1/database/${db.id}/query`, { sql });
    return result[0]?.results ?? [];
  }
  const tables = await query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cases','telegram_routes','telegram_identities','user','telegram_ocr_jobs')",
  );
  if (
    !['cases', 'telegram_routes', 'telegram_identities', 'user'].every((name) =>
      tables.some((row) => row.name === name),
    )
  )
    throw Error('PRODUCTION_SCHEMA_MISMATCH');
  const routes = await query(
    "SELECT id,name,chat_id,topic_id FROM telegram_routes t WHERE is_active=1 AND route_type IN ('intake','intake_source') AND (bot_id IS NULL OR EXISTS(SELECT 1 FROM telegram_bots b WHERE b.id=t.bot_id AND b.is_active=1)) AND NOT EXISTS(SELECT 1 FROM telegram_routes r WHERE r.chat_id=t.chat_id AND coalesce(r.topic_id,0)=coalesce(t.topic_id,0) AND r.is_active=1 AND r.route_type='collector_report')",
  );
  const creators = await query(
    "SELECT count(*) AS count FROM telegram_identities ti JOIN user u ON u.id=ti.user_id WHERE ti.is_active=1 AND u.active=1 AND u.role='admin' AND coalesce(u.banned,0)=0",
  );
  const report = {
    baselineHash: manifest.baselineHash,
    localSmokeTestsPassed: true,
    activeOcrSourceRoutes: routes.length,
    mappedActiveAdmins: creators[0]?.count ?? 0,
    ocrTableExists: tables.some((row) => row.name === 'telegram_ocr_jobs'),
    productionChanged: false,
    deployed: false,
    needsRouteConfiguration: routes.length === 0,
    needsIdentityConfiguration: !(creators[0]?.count > 0),
  };
  writeFileSync(
    resolve(root, '../production-restored/preflight-report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.needsRouteConfiguration || report.needsIdentityConfiguration)
    process.exitCode = 2;
} catch (error) {
  const code =
    error instanceof Error && /^[A-Z_]+(?:_\d+)?$/.test(error.message)
      ? error.message
      : 'PREFLIGHT_NETWORK_OR_CONFIGURATION_FAILED';
  console.error(
    `${code}: no deployment, schema changes or webhook changes performed; credentials omitted.`,
  );
  process.exitCode = 1;
}
