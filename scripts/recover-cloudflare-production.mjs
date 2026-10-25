import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { gunzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const vars = parseEnv(
  readFileSync(resolve(root, 'apps/server/.dev.vars'), 'utf8'),
);
const token = vars.CLOUDFLARE_API_TOKEN?.trim();
if (!token) {
  console.error(
    'CLOUDFLARE_API_TOKEN_MISSING: fill apps/server/.dev.vars; never paste token into chat.',
  );
  process.exit(1);
}
const account = 'b40151c62acbc2316d833cb980dac6f5';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(root, '..', 'production-backup', stamp);
const secrets = Object.entries(vars)
  .filter(([name, value]) => /KEY|TOKEN|SECRET/.test(name) && value)
  .map(([, value]) => value);
async function api(path) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
    },
  );
  if (!response.ok) throw Error(`CLOUDFLARE_READ_HTTP_${response.status}`);
  return response;
}
function save(base, path, content) {
  const absolute = resolve(base, path);
  if (!absolute.startsWith(resolve(base) + sep))
    throw Error('INVALID_MODULE_PATH');
  if (existsSync(absolute)) throw Error('RECOVERY_WOULD_OVERWRITE_FILE');
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
try {
  const summary = [];
  for (const worker of [
    'collection-admin-production-api',
    'collection-admin-production-web',
  ]) {
    const directory = resolve(output, worker);
    mkdirSync(directory, { recursive: true });
    const settings = await (await api(`${worker}/settings`)).json();
    save(directory, 'settings.json', JSON.stringify(settings, null, 2));
    const deployments = await (await api(`${worker}/deployments`)).json();
    save(directory, 'deployments.json', JSON.stringify(deployments, null, 2));
    const response = await api(`${worker}/content/v2`);
    const hash = createHash('sha256');
    let modules = 0,
      maps = 0,
      projectSources = 0,
      containsKnownSecret = false;
    async function accept(name, bytes, type) {
      hash.update(name);
      hash.update(bytes);
      modules++;
      save(directory, `modules/${name}`, bytes);
      const isMap =
        type === 'application/source-map' || /\.map(?:\.gz)?$/.test(name);
      if (!isMap) return;
      maps++;
      const text = (/\.gz$/.test(name) ? gunzipSync(bytes) : bytes).toString(
        'utf8',
      );
      const map = JSON.parse(text);
      for (let index = 0; index < (map.sources ?? []).length; index++) {
        const source = map.sources[index].replaceAll('\\', '/'),
          content = map.sourcesContent?.[index];
        if (typeof content !== 'string' || /node_modules|\.pnpm/.test(source))
          continue;
        containsKnownSecret ||= secrets.some((secret) =>
          content.includes(secret),
        );
        let path = source.match(
          /(?:^|\/)((?:packages|apps|scripts)\/.*)$/,
        )?.[1];
        if (!path) {
          const relative = source
            .replace(/^(?:\.\.\/)+/, '')
            .replace(/^\.\//, '');
          if (relative.startsWith('src/'))
            path = `apps/${worker.endsWith('-api') ? 'server' : 'web'}/${relative}`;
        }
        if (!path || path.includes('..') || /^(?:https?:|file:)/.test(path))
          continue;
        const target = resolve(directory, 'recovered-source', path);
        if (existsSync(target)) {
          if (readFileSync(target, 'utf8') !== content)
            throw Error('CONFLICTING_SOURCE_MAPS');
          continue;
        }
        save(resolve(directory, 'recovered-source'), path, content);
        projectSources++;
      }
    }
    if (
      response.headers.get('content-type')?.startsWith('multipart/form-data')
    ) {
      const form = await response.formData();
      for (const [name, value] of form.entries()) {
        if (typeof value === 'string')
          await accept(name, Buffer.from(value), 'text/plain');
        else
          await accept(
            name,
            Buffer.from(await value.arrayBuffer()),
            value.type,
          );
      }
    } else
      await accept(
        'index.js',
        Buffer.from(await response.arrayBuffer()),
        'application/javascript',
      );
    summary.push({
      worker,
      modules,
      sourceMaps: maps,
      recoveredProjectSources: projectSources,
      sha256: hash.digest('hex'),
      containsKnownSecret,
    });
  }
  const report = {
    directory: output,
    workers: summary,
    productionChanged: false,
    deployed: false,
  };
  save(output, 'recovery-summary.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const code =
    error instanceof Error && /^[A-Z_]+(?:_\d+)?$/.test(error.message)
      ? error.message
      : 'RECOVERY_READ_FAILED';
  console.error(
    `${code}: no deployment was performed; credentials and provider response omitted.`,
  );
  process.exitCode = 1;
}
