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
  entryPoints: ['packages/api/tests/telegram-ocr-flow.test.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: '.wrangler/telegram-ocr-flow.test.mjs',
  banner: {
    js: "import { createRequire as __makeRequire } from 'node:module'; const require=__makeRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'local-env',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
          path: 'cloudflare:workers',
          namespace: 'local-env',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'local-env' }, () => ({
          contents: 'export const env = {};',
          loader: 'js',
        }));
      },
    },
  ],
});
const result = spawnSync(
  process.execPath,
  ['--test', '.wrangler/telegram-ocr-flow.test.mjs'],
  { stdio: 'inherit', windowsHide: true },
);
process.exitCode = result.status ?? 1;
