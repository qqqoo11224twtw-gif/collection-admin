import legacy from './legacy-web.js';
import html from './review.html';
import script from './review.js.txt';
import entryScript from './entry.js.txt';

const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob:; connect-src https://api.kpirich.bid; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
};
export default {
  async fetch(request: Request, env: unknown, execution: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === '/cases/bulk-create/telegram')
      return new Response(html, {
        headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
      });
    if (path === '/_telegram-ocr.js')
      return new Response(script, {
        headers: {
          ...headers,
          'Content-Type': 'text/javascript; charset=utf-8',
        },
      });
    if (path === '/_telegram-ocr-panel.html') return new Response(html, {headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
    if (path === '/_telegram-ocr-entry.js') return new Response(entryScript, {headers:{...headers,'Content-Type':'text/javascript; charset=utf-8'}});
    const response = await legacy.fetch(request, env, execution);
    if (
      response.status === 200 &&
      response.headers.get('Content-Type')?.includes('text/html')
    ) {
      const rewritten = new HTMLRewriter()
        .on('body', {
          element(element) {
            element.append(
              '<script type="module" src="/_telegram-ocr-entry.js"></script>',
              { html: true },
            );
          },
        })
        .transform(response);
      const safe = new Response(rewritten.body, rewritten);
      safe.headers.set('Cache-Control', 'no-store');
      safe.headers.delete('Content-Length');
      safe.headers.delete('ETag');
      return safe;
    }
    return response;
  },
};
