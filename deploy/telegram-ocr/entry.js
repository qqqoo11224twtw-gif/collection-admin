import { initializeOcr } from '/_telegram-ocr.js';
let host, dispose, refreshTabs, loading = false, scheduled = false;
const paths = new Set(['/cases/telegram', '/cases/bulk-create']);
const css = `:host{display:block;min-width:0;color:inherit;font:inherit;margin:24px 0}.tabs{display:flex;gap:6px;flex-wrap:wrap;padding:5px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:12px;margin-bottom:20px;width:fit-content}.tabs button{margin:0;border:0;padding:10px 18px;border-radius:8px}.tabs button[aria-selected="true"]{background:#6687ef;color:#fff}.tabs button:focus-visible{outline:2px solid #6687ef;outline-offset:3px}[hidden]{display:none!important}main{max-width:none;margin:0;padding:0}nav{display:none}h1{font-size:22px;margin:0 0 8px}section,article{background:transparent;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:16px;padding:20px;margin:16px 0}input,select,button{font:inherit;color:inherit;background:transparent;padding:9px;margin:5px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:8px;max-width:100%;box-sizing:border-box}button{cursor:pointer}button:hover{background:color-mix(in srgb,currentColor 9%,transparent)}button:disabled{opacity:.5;cursor:default}label{display:inline-block}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid color-mix(in srgb,currentColor 20%,transparent)}td input{width:150px}output{display:block;white-space:pre-wrap;padding:12px}img{max-width:100%;max-height:65vh;object-fit:contain}details{margin:12px 0}small{display:block;opacity:.75}.scroll{overflow:auto}#content[hidden]{display:none}a{color:inherit}option{color:CanvasText;background:Canvas}@media(max-width:640px){section{padding:12px}label{display:block}input,select{width:100%;margin:5px 0}}`;
async function sync() {
  scheduled = false;
  if (!paths.has(location.pathname)) {
    if (host) { dispose?.(); host.remove(); host = undefined; }
    return;
  }
  if (host?.isConnected) { refreshTabs?.(); return; }
  if (loading) return;
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
    const tabs = document.createElement('div');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '建檔與收件功能');
    tabs.className = 'tabs';
    const legacyTab = document.createElement('button');
    const aiTab = document.createElement('button');
    const settingsPage = location.pathname === '/cases/telegram';
    legacyTab.textContent = settingsPage ? '原有群組設定' : '手動批量建檔';
    aiTab.textContent = settingsPage ? 'AI 圖片收件' : 'Telegram 圖片辨識';
    legacyTab.id = 'legacy-tab'; aiTab.id = 'ai-tab';
    for (const button of [legacyTab, aiTab]) { button.type = 'button'; button.setAttribute('role','tab'); }
    aiTab.setAttribute('aria-controls', 'ocr-panel');
    template.id = 'ocr-panel';
    template.setAttribute('role','tabpanel'); template.setAttribute('aria-labelledby','ai-tab');
    template.querySelector('h1')?.remove();
    tabs.append(legacyTab, aiTab);
    shadow.append(style, tabs, template);
    const container = main.firstElementChild;
    if (container?.querySelector('h1') && container.firstElementChild) container.firstElementChild.after(host);
    else main.prepend(host);
    let active = false, cleanupOcr;
    const saved = new Map();
    const originals = () => [...(container?.children ?? main.children)].filter(node => node !== host && !node.contains(host) && !node.querySelector('h1') && node.tagName !== 'H1');
    const update = () => {
      template.hidden = !active;
      for (const [button, selected] of [[legacyTab,!active],[aiTab,active]]) {
        button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      }
      for (const node of originals()) {
        if (active) {
          if (!saved.has(node)) saved.set(node, [node.style.getPropertyValue('display'),node.style.getPropertyPriority('display')]);
          node.style.setProperty('display','none','important');
        }
      }
      if (!active) {
        for (const [node, [value,priority]] of saved) {
          if(value) node.style.setProperty('display',value,priority); else node.style.removeProperty('display');
        }
        saved.clear();
      }
    };
    const select = (value) => { active = value; update(); if(active && !cleanupOcr) cleanupOcr = initializeOcr(shadow); };
    legacyTab.onclick = () => select(false); aiTab.onclick = () => select(true);
    for (const button of [legacyTab,aiTab]) button.onkeydown = event => {
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault(); select(event.key === 'End' ? true : event.key === 'Home' ? false : !active);
      (active ? aiTab : legacyTab).focus();
    };
    refreshTabs = update;
    dispose = () => { active = false; update(); cleanupOcr?.(); refreshTabs = undefined; };
    update();
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
