import { createORPCClient, onError } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { AppRouterClient } from '@saasflare-dev/api';

export const link = new RPCLink({
  url: `${import.meta.env.NEXT_PUBLIC_SERVER_URL}/rpc`,
  // Session travels as an httpOnly cookie; web and server are separate
  // workers, so cross-origin requests must opt into credentials.
  fetch: (request, init) =>
    globalThis.fetch(request, { ...init, credentials: 'include' }),
  interceptors: [
    onError((error) => {
      if ((error as Error).name === 'AbortError') {
        return;
      }
      console.error(error);
    }),
  ],
});

export const client: AppRouterClient = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);
