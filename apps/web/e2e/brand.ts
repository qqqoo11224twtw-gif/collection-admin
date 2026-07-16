// Same identity values as src/lib/brand.ts, but read via fs: the e2e suite
// runs in plain Node, where importing JSON keeps this file independent of
// any bundler config.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as {
  saasflare: { displayName: string; appId: string; apiKeyPrefix: string };
};

export const {
  displayName: APP_DISPLAY_NAME,
  appId: APP_ID,
  apiKeyPrefix: API_KEY_PREFIX,
} = pkg.saasflare;
