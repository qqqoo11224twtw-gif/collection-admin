import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

// An isolated local runtime: never load Cloudflare or email credentials.
const root = fileURLToPath(new URL('../', import.meta.url));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  LOCAL_ONLY: '1',
  NEXT_PUBLIC_SERVER_URL: 'http://localhost:4000',
  WRANGLER_SEND_METRICS: 'false',
};
for (const key of Object.keys(env)) {
  if (/^(CLOUDFLARE_|ALCHEMY_|R2_|RESEND_)/.test(key)) delete env[key];
}
const children = new Set<ReturnType<typeof spawn>>();
function run(args: string[], cwd: string) {
  // Windows command shims require a shell; arguments here are fixed literals.
  const cli = process.env.npm_execpath;
  const child = cli
    ? spawn(process.execPath, [cli, ...args], { cwd, env, stdio: 'inherit' })
    : spawn('pnpm', args, {
        cwd,
        env,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
  children.add(child);
  return new Promise<number>((resolve, reject) => {
    child.once('error', (error) => {
      children.delete(child);
      reject(error);
    });
    child.once('exit', (code) => {
      children.delete(child);
      resolve(code ?? 1);
    });
  });
}
function stop() {
  for (const child of children) {
    // pnpm launches nested processes; terminate only this launcher's live trees.
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else child.kill('SIGTERM');
  }
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const serverDir = `${root}/apps/server`;
const webDir = `${root}/apps/web`;
async function requireFreePort(port: number) {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () =>
      reject(
        new Error(
          `Local port ${port} is in use. Stop the previous dev process before starting dev:local.`,
        ),
      ),
    );
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
}
if (process.argv[2] === 'build') {
  process.exitCode = await run(['exec', 'vite', 'build'], webDir);
} else if (process.argv[2] === 'dev') {
  await requireFreePort(4000);
  await requireFreePort(3000);
  const migrated = await run(
    [
      'exec',
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'starter-local-db',
      '--local',
      '--config',
      'wrangler.local.jsonc',
    ],
    serverDir,
  );
  if (migrated !== 0) process.exitCode = migrated;
  else {
    await import('./seed-cases.ts');
    const seeded = await run(
      [
        'exec',
        'wrangler',
        'd1',
        'execute',
        'starter-local-db',
        '--local',
        '--config',
        'wrangler.local.jsonc',
        '--file',
        '.wrangler/demo-cases.sql',
      ],
      serverDir,
    );
    if (seeded !== 0) process.exit(seeded);
    process.exitCode = await Promise.race([
      run(
        [
          'exec',
          'wrangler',
          'dev',
          '--local',
          '--config',
          'wrangler.local.jsonc',
          '--port',
          '4000',
        ],
        serverDir,
      ),
      run(['exec', 'vite', '--host', '127.0.0.1', '--strictPort'], webDir),
    ]);
    stop();
  }
} else {
  throw new Error('Usage: node scripts/local.ts dev|build');
}
