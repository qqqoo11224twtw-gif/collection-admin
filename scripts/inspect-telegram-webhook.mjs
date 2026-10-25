import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const values = parseEnv(
  readFileSync(new URL('../apps/server/.dev.vars', import.meta.url), 'utf8'),
);
const token = values.TELEGRAM_INSPECT_BOT_TOKEN?.trim();
if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
  console.error(
    'TELEGRAM_INSPECT_BOT_TOKEN_MISSING_OR_INVALID: fill apps/server/.dev.vars; token not printed.',
  );
  process.exit(1);
}
try {
  // This method reads configuration only. Never set/delete a webhook or consume updates.
  const response = await fetch(
    `https://api.telegram.org/bot${token}/getWebhookInfo`,
    { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000) },
  );
  if (!response.ok) {
    console.error(`TELEGRAM_READ_FAILED_HTTP_${response.status}`);
    process.exitCode = 1;
  } else {
    const data = await response.json();
    if (
      data.ok !== true ||
      !data.result ||
      typeof data.result.url !== 'string'
    ) {
      console.error('TELEGRAM_READ_INVALID_RESPONSE');
      process.exitCode = 1;
    } else {
      let host = null;
      if (data.result.url) {
        try {
          host = new URL(data.result.url).hostname;
        } catch {
          host = 'configured-url-hidden';
        }
      }
      console.log(
        JSON.stringify(
          {
            webhookConfigured: Boolean(data.result.url),
            destinationHost: host,
            pendingUpdates: data.result.pending_update_count ?? null,
            hasCustomCertificate: data.result.has_custom_certificate ?? null,
            hasDeliveryError: Boolean(data.result.last_error_date),
            fullUrlHidden: true,
            configurationChanged: false,
            updatesConsumed: false,
          },
          null,
          2,
        ),
      );
    }
  }
} catch {
  console.error(
    'TELEGRAM_READ_NETWORK_OR_TIMEOUT: URL and credentials omitted.',
  );
  process.exitCode = 1;
}
