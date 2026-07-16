// Product identity, single-sourced from the root package.json `saasflare`
// block (see docs/ports.md). Bundled at build time — rename the fork there,
// and every title, heading, and placeholder follows.
// `with { type: 'json' }`: required by Node's native ESM loader (the
// Playwright e2e path); Vite/esbuild accept and strip it when bundling.
import pkg from '../../../../package.json' with { type: 'json' };

export const {
  displayName: APP_DISPLAY_NAME,
  appId: APP_ID,
  apiKeyPrefix: API_KEY_PREFIX,
} = pkg.saasflare;
