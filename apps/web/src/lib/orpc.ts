import { createORPCClient, onError } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { AppRouterClient } from '@saasflare-dev/api';

export const link = new RPCLink({
  url: `${import.meta.env.NEXT_PUBLIC_SERVER_URL}/rpc`,
  // Session travels as an httpOnly cookie; web and server are separate
  // workers, so cross-origin requests must opt into credentials.
  fetch: async (request, init) => {
    const response = await globalThis.fetch(request, {
      ...init,
      credentials: 'include',
    });
    if (
      response.status === 401 &&
      typeof window !== 'undefined' &&
      (window.location.pathname === '/' ||
        window.location.pathname.startsWith('/cases'))
    )
      window.location.assign('/login?idle=true');
    return response;
  },
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
