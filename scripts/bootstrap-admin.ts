import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Offline bootstrap only. Remote environments use the reviewed SQL via their staging-only tooling.
const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || process.argv[3] !== '--local')
  throw new Error('Usage: node scripts/bootstrap-admin.ts <email> --local');
const dir = new URL('../apps/server/.wrangler/', import.meta.url);
mkdirSync(dir, { recursive: true });
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const now = Date.now();
writeFileSync(
  new URL('bootstrap-admin.sql', dir),
  `INSERT INTO user(id,name,email,email_verified,role,active,permission_allow,permission_deny,created_at,updated_at) SELECT ${literal(crypto.randomUUID())},'初始管理員',${literal(email)},0,'admin',1,'[]','[]',${now},${now} WHERE NOT EXISTS(SELECT 1 FROM user WHERE active=1 AND (role='admin' OR EXISTS(SELECT 1 FROM json_each(permission_allow) WHERE value='user_permission.manage')) AND NOT EXISTS(SELECT 1 FROM json_each(permission_deny) WHERE value='user_permission.manage')) ON CONFLICT DO NOTHING;`,
);
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
    ),
    'd1',
    'execute',
    'starter-local-db',
    '--local',
    '--config',
    'wrangler.local.jsonc',
    '--file',
    '.wrangler/bootstrap-admin.sql',
  ],
  {
    cwd: fileURLToPath(new URL('../apps/server/', import.meta.url)),
    stdio: 'inherit',
    windowsHide: true,
  },
);
process.exitCode = result.status ?? 1;
