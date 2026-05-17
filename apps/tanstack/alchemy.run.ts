import alchemy from 'alchemy';
import { TanStackStart } from 'alchemy/cloudflare';
import { CloudflareStateStore } from 'alchemy/state';

const PROJECT_NAME = 'starter';

const app = await alchemy(`${PROJECT_NAME}-tanstack`, {
  stateStore: process.env.CLOUDFLARE_API_TOKEN
    ? // biome-ignore lint/suspicious/noExplicitAny: alchemy scope type is internal
      (scope: any) => new CloudflareStateStore(scope, { forceUpdate: true })
    : undefined,
});

export const tanstack = await TanStackStart('tanstack', {
  name: `${app.name}-${app.stage}`,
  adopt: true,
});

console.log({ tanstack: tanstack.url });

await app.finalize();
