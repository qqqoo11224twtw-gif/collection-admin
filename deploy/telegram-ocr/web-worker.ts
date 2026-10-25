import legacy from './legacy-web.js';
import html from './review.html';
import script from './review.js.txt';

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
    if (path === '/_telegram-ocr-entry.js')
      return new Response(
        `(() => { const add = () => { if (document.querySelector('[data-telegram-ocr-entry]')) return; const target = document.querySelector('a[href="/cases/bulk-create"]'); if (!target || !target.parentElement) return; const link = document.createElement('a'); link.href='/cases/bulk-create/telegram'; link.textContent='AI 圖片收件與待確認建檔'; link.className=target.className; link.setAttribute('data-telegram-ocr-entry',''); target.parentElement.append(link); }; const start=()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{add();new MutationObserver(add).observe(document.body,{childList:true,subtree:true});})); if(document.readyState==='complete') start(); else window.addEventListener('load',start,{once:true}); })();`,
        {
          headers: {
            ...headers,
            'Content-Type': 'text/javascript; charset=utf-8',
          },
        },
      );
    const response = await legacy.fetch(request, env, execution);
    if (
      ['/cases/bulk-create', '/cases/telegram'].includes(path) &&
      response.status === 200 &&
      response.headers.get('Content-Type')?.includes('text/html')
    ) {
      const rewritten = new HTMLRewriter()
        .on('body', {
          element(element) {
            element.append(
              '<script src="/_telegram-ocr-entry.js" defer></script>',
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
