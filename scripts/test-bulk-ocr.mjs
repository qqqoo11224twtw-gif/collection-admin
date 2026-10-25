import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(
  realpathSync(
    new URL('../node_modules/wrangler/package.json', import.meta.url),
  ),
);
const { build } = require('esbuild');
await build({
  entryPoints: ['packages/api/tests/bulk-ocr-rules.test.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: '.wrangler/bulk-ocr-rules.test.mjs',
});
const result = spawnSync(
  process.execPath,
  ['--test', '.wrangler/bulk-ocr-rules.test.mjs'],
  { stdio: 'inherit', windowsHide: true },
);
process.exitCode = result.status ?? 1;
