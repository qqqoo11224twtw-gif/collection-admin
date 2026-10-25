import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const file = join(root, 'apps/server/.dev.vars');
if (!existsSync(file)) {
  console.error('LOCAL_ENV_FILE_MISSING');
  process.exit(1);
}
let values;
try {
  values = parseEnv(readFileSync(file, 'utf8'));
} catch {
  console.error('LOCAL_ENV_INVALID: check quotes; contents omitted.');
  process.exit(1);
}
const keys = [
  'GOOGLE_VISION_API_KEY',
  'OPENAI_API_KEY',
  'TELEGRAM_INSPECT_BOT_TOKEN',
];
const result = Object.fromEntries(
  keys.map((key) => [key, values[key]?.trim() ? 'filled' : 'missing']),
);
const bundledGit = resolve(dirname(process.execPath), '../../native/git/cmd/git.exe');
const git = existsSync(bundledGit) ? bundledGit : 'git';
const ignored = spawnSync(
  git,
  ['check-ignore', '-q', '--', 'apps/server/.dev.vars'],
  { cwd: root, windowsHide: true },
);
const tracked = spawnSync(git, ['ls-files', '-z'], {
  cwd: root,
  windowsHide: true,
  encoding: 'utf8',
});
if (ignored.error || tracked.error || tracked.status !== 0) {
  console.error('GIT_VERIFICATION_UNAVAILABLE');
  process.exit(1);
}
const paths = tracked.stdout.split('\0').filter(Boolean);
let secretInTrackedFile = false;
for (const relative of paths) {
  try {
    const content = readFileSync(join(root, relative), 'utf8');
    if (
      keys.some(
        (key) => values[key]?.trim() && content.includes(values[key].trim()),
      )
    )
      secretInTrackedFile = true;
  } catch {
    /* Deleted tracked files contain no readable key. */
  }
}
let secretInClientBuild = false;
function scan(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (/\.(js|json|html|css|map)$/.test(entry.name)) {
      const content = readFileSync(path, 'utf8');
      if (
        keys.some(
          (key) => values[key]?.trim() && content.includes(values[key].trim()),
        )
      )
        secretInClientBuild = true;
    }
  }
}
scan(join(root, 'apps/web/dist/client'));
const ignoredAndUntracked =
  ignored.status === 0 && !paths.includes('apps/server/.dev.vars');
console.log(
  JSON.stringify(
    {
      localFile: 'apps/server/.dev.vars',
      keys: result,
      ignoredAndUntracked,
      secretInTrackedFile,
      secretInClientBuild,
      clientBuildExists: existsSync(join(root, 'apps/web/dist/client')),
      contentPrinted: false,
    },
    null,
    2,
  ),
);
if (!ignoredAndUntracked || secretInTrackedFile || secretInClientBuild)
  process.exitCode = 1;
