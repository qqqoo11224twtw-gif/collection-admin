import { initializeOcr } from '/_telegram-ocr.js';
let host, dispose, loading = false, scheduled = false;
const paths = new Set(['/cases/telegram', '/cases/bulk-create']);
const css = `:host{display:block;min-width:0;color:inherit;font:inherit;margin:24px 0}main{max-width:none;margin:0;padding:0}nav{display:none}h1{font-size:22px;margin:0 0 8px}section,article{background:transparent;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:16px;padding:20px;margin:16px 0}input,select,button{font:inherit;color:inherit;background:transparent;padding:9px;margin:5px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:8px;max-width:100%;box-sizing:border-box}button{cursor:pointer}button:hover{background:color-mix(in srgb,currentColor 9%,transparent)}button:disabled{opacity:.5;cursor:default}label{display:inline-block}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid color-mix(in srgb,currentColor 20%,transparent)}td input{width:150px}output{display:block;white-space:pre-wrap;padding:12px}img{max-width:100%;max-height:65vh;object-fit:contain}details{margin:12px 0}small{display:block;opacity:.75}.scroll{overflow:auto}#content[hidden]{display:none}a{color:inherit}option{color:CanvasText;background:Canvas}@media(max-width:640px){section{padding:12px}label{display:block}input,select{width:100%;margin:5px 0}}`;
async function sync() {
  scheduled = false;
  if (!paths.has(location.pathname)) {
    if (host) { dispose?.(); host.remove(); host = undefined; }
    return;
  }
  if (host?.isConnected || loading) return;
  if (host) { dispose?.(); host = undefined; }
  const main = document.querySelector('main');
  if (!main || !main.querySelector('h1')) return;
  loading = true;
  try {
    const response = await fetch('/_telegram-ocr-panel.html', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw Error('PANEL_LOAD_FAILED');
    const template = new DOMParser().parseFromString(await response.text(), 'text/html').querySelector('main');
    if (!template || !main.isConnected || !paths.has(location.pathname)) return;
    template.querySelector('nav')?.remove();
    host = document.createElement('section');
    host.setAttribute('data-telegram-ocr-panel', '');
    host.setAttribute('aria-label', 'AI 圖片收件與批量建檔');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = css;
    shadow.append(style, template);
    const container = main.firstElementChild;
    if (container?.querySelector('h1') && container.firstElementChild) container.firstElementChild.after(host);
    else main.prepend(host);
    dispose = initializeOcr(shadow);
  } catch {
    // Keep the existing backend usable; offer a normal authenticated fallback.
    if (main.isConnected && !main.querySelector('[data-ocr-fallback]')) {
      const link = document.createElement('a'); link.dataset.ocrFallback = '';
      link.href = '/cases/bulk-create/telegram'; link.textContent = '開啟 AI 圖片收件與待確認建檔'; main.prepend(link);
    }
  } finally { loading = false; }
}
function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(sync); } }
const start = () => { new MutationObserver(schedule).observe(document.body, {childList:true,subtree:true}); window.addEventListener('popstate',schedule); schedule(); };
if (document.readyState === 'complete') start(); else window.addEventListener('load',start,{once:true});
