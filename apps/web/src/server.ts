import handler, { createServerEntry } from '@tanstack/react-start/server-entry';
import { secureWebResponse } from './lib/security-headers';

export default createServerEntry({
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith('.map')) {
      return secureWebResponse(new Response('Not found', { status: 404 }));
    }
    if (new URL(request.url).pathname === '/robots.txt') {
      return secureWebResponse(
        new Response('User-agent: *\nDisallow: /\n', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }),
      );
    }
    try {
      const response = await handler.fetch(request);
      if (import.meta.env.PROD && response.status >= 500) {
        console.error('WEB_RESPONSE_FAILED');
        return secureWebResponse(
          new Response('服務暫時無法使用，請稍後再試。', {
            status: response.status,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-store',
            },
          }),
        );
      }
      return secureWebResponse(response);
    } catch (error) {
      if (!import.meta.env.PROD) throw error;
      console.error('WEB_REQUEST_FAILED');
      return secureWebResponse(
        new Response('服務暫時無法使用，請稍後再試。', {
          status: 500,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        }),
      );
    }
  },
});
