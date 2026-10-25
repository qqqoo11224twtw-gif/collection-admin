export function initializeOcr(root = document) {
const document = { getElementById: (id) => root.getElementById(id), querySelectorAll: (selector) => root.querySelectorAll(selector), createElement: (tag) => root.ownerDocument ? root.ownerDocument.createElement(tag) : root.createElement(tag) };
const API = 'https://api.kpirich.bid/api/telegram-ocr';
const notice = document.getElementById('notice'),
  jobs = document.getElementById('jobs'),
  routes = document.getElementById('routes'),
  form = document.getElementById('routeForm');
let disposed = false;
let automatic = false;
function scheduleRefresh() { clearTimeout(refreshTimer); if(!disposed) refreshTimer=setTimeout(()=>{
  const editing=[...jobs.querySelectorAll('input')].some(input=>input.dataset.edited === 'true' || input === root.activeElement);
  if(!editing && !busy && !globalThis.document.hidden) refresh(); else scheduleRefresh();
},5000); }
let busy = false,
  refreshTimer;
const images = new Set();
const previews = new Map();
const loadingPreviews = new Map();
let visibleJobIds = new Set();
let previewObserver;
const previewLoads = new WeakMap();
async function imageUrl(job) {
 if(previews.has(job.id))return previews.get(job.id);
 if(loadingPreviews.has(job.id))return loadingPreviews.get(job.id);
 const pending=(async()=>{
  const response=await fetch(`${API}/jobs/${job.id}/image`,{credentials:'include',cache:'no-store'});
  if(!response.ok)throw Error('IMAGE_UNAVAILABLE');
  const blob=await response.blob();if(disposed || !visibleJobIds.has(job.id))return null;
  const url=URL.createObjectURL(blob);images.add(url);previews.set(job.id,url);return url;
 })().finally(()=>loadingPreviews.delete(job.id));
 loadingPreviews.set(job.id,pending);return pending;
}
const messages = {
  ROUTE_CONFLICT: '此群組／話題已有啟用中的路由，請選擇獨立收件位置。',
  STALE_REVIEW: '資料已更新，請重新核對最新結果。',
  NEEDS_REVIEW: '請填妥三個欄位並核對原圖。',
  OCR_DISABLED: 'OCR 尚未啟用，請聯絡管理員。',
  FORBIDDEN: '目前帳號沒有收件及建檔管理權限。',
  UNAUTHORIZED: '請先登入後台。',
  OCR_REQUEST_FAILED: '處理失敗，請重新整理後再試。',
};
function el(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
async function request(path, options = {}) {
  const response = await fetch(API + path, {
    credentials: 'include',
    cache: 'no-store',
    ...options,
  });
  if (response.status === 401) {
    location.assign('/login');
    throw Error('UNAUTHORIZED');
  }
  const value = await response.json();
  if (!response.ok) throw Error(value.error || 'OCR_REQUEST_FAILED');
  return value;
}
function post(path, value) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
}
function display(error) {
  notice.textContent =
    messages[error.message] || '操作未完成，請更新結果後重試。';
}
async function options() {
  const value = await request('/options');
  automatic = value.autoCreate === true;
  document.getElementById('modeNote').textContent = automatic ? '自動建檔已啟用：三欄通過雙引擎核對、驗證與去重後建立；不確定資料保留待處理。' : '目前為人工確認模式，辨識結果不會直接建立案件。';
  document.getElementById('reviewHelp').textContent = '建檔成功會從此清單隱藏，案件與去重紀錄仍保留。清單每 5 秒自動更新。正在編輯時暫停更新，避免覆蓋輸入內容。待處理資料可修正後確認建立；重複或驗證失敗不會強制寫入。原圖預覽權限與暫存資料最長保留 24 小時。';
  form.elements.botId.replaceChildren();
  for (const bot of value.bots) {
    const option = el('option', '@' + bot.username);
    option.value = bot.id;
    form.elements.botId.append(option);
  }
  routes.replaceChildren();
  for (const route of value.routes) {
    const row = el(
      'p',
      `${route.name} · 群組 ${route.chat_id} · Topic ${route.topic_id || '無'} · ${route.is_active ? '啟用' : '停用'}`,
    );
    const button = el('button', route.is_active ? '停用' : '啟用');
    button.type = 'button';
    button.onclick = async () => {
      button.disabled = true;
      try {
        await post('/routes', {
          id: route.id,
          name: route.name,
          botId: route.bot_id,
          chatId: route.chat_id,
          topicId: route.topic_id,
          collectorId: null,
          routeType: 'intake',
          isActive: !route.is_active,
        });
        await options();
      } catch (error) {
        display(error);
        button.disabled = false;
      }
    };
    row.append(button);
    routes.append(row);
  }
}
const states = {
  pending: '等待辨識',
  recognizing: '辨識中',
  ready: '待人工確認',
  creating: '正在建檔',
  created: '已建檔',
  failed: '辨識或建檔未完成，請人工核對',
  cancelled: '已取消',
};
function fields(row) {
  return {
    code: row.querySelector('[name=code]').value,
    customerName: row.querySelector('[name=customerName]').value,
    region: row.querySelector('[name=region]').value,
  };
}
async function confirm(row, job) {
  const reviewed = row.querySelector('[type=checkbox]').checked;
  if (!reviewed) throw Error('NEEDS_REVIEW');
  await post(`/jobs/${job.id}/confirm`, {
    version: job.version,
    reviewed: true,
    fields: fields(row),
  });
}
async function refresh() {
  if (disposed) return;
  if (busy) return;
  busy = true;
  try {
    const value = await request('/jobs');
    visibleJobIds = new Set(value.jobs.map(job=>job.id));
    for(const [id,url] of previews) if(!visibleJobIds.has(id)){URL.revokeObjectURL(url);images.delete(url);previews.delete(id);}
    previewObserver?.disconnect();
    previewObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries=>{
      for(const entry of entries)if(entry.isIntersecting){previewObserver.unobserve(entry.target);previewLoads.get(entry.target)?.();}
    },{rootMargin:'300px'}) : null;
    jobs.replaceChildren();
    jobs.oninput = (event) => { if(event.target instanceof HTMLInputElement) event.target.dataset.edited = 'true'; };
    for (const job of value.jobs) {
      const row = el('tr');
      row.dataset.id = job.id;
      row.job = job;
      const first = el(
        'td',
        `圖片訊息 ${job.message_id} · ${job.status==='failed' && job.existing_case_id ? '已有相同案件，未重複建立' : states[job.status] || job.status}`,
      );
      if (job.status === 'failed' && !job.existing_case_id) {
        let code;
        try { code = JSON.parse(job.evidence_json || '{}').diagnostic?.code; } catch {}
        const reasons = { GOOGLE_REQUEST_FAILED:'Google 辨識請求未能送出，請重新辨識', OPENAI_REQUEST_FAILED:'AI 辨識請求未能送出，請重新辨識', GOOGLE_RESPONSE_INVALID:'Google 回應格式不完整，請重新辨識', GOOGLE_NO_TEXT:'Google 未讀到清楚文字，請改傳清晰原圖', GOOGLE_IMAGE_REJECTED:'Google 無法處理這張圖片', OPENAI_INCOMPLETE:'AI 輸出未完成，請重新辨識', OPENAI_TIMEOUT:'AI 處理逾時，請稍後重試', GOOGLE_TIMEOUT:'Google 辨識逾時，請稍後重試', OPENAI_REFUSAL:'AI 無法處理此圖片，請人工核對', OPENAI_RESPONSE_INVALID:'AI 回傳格式不完整，請重試', TELEGRAM_DOWNLOAD_OR_PROCESSING_FAILED:'圖片下載或處理失敗，請確認機器人仍可存取原訊息', IMAGE_LIMIT:'圖片超過 5 MB，請縮小後重傳' };
        first.append(el('small', reasons[code] || (code && /^(GOOGLE|OPENAI)_HTTP_[0-9]{3}$/.test(code) ? '辨識服務回應錯誤：' + code : '此筆為先前失敗紀錄，請重新辨識以取得原因')));
      }
      if(job.existing_case_id && /^[a-f0-9-]{36}$/.test(job.existing_case_id)) {
        const link=el('a','查看既有案件');link.href='/cases/'+job.existing_case_id;first.append(link);
      }
      const preview=el('div','正在載入原圖…');first.append(preview);
      const load=async()=>{
        try{
          const url=await imageUrl(job);if(!url || disposed || !preview.isConnected)return;
          const image=el('img');image.src=url;image.alt='圖片訊息 '+job.message_id+' 原圖';image.loading='lazy';image.width=220;
          image.style.cssText='display:block;width:220px;max-width:100%;max-height:300px;object-fit:contain;cursor:zoom-in;margin-top:10px';
          image.onclick=()=>{image.style.maxHeight=image.style.maxHeight==='300px'?'80vh':'300px';image.style.width=image.style.width==='220px'?'100%':'220px';};
          preview.replaceChildren(image);
        }catch{preview.replaceChildren(el('small','原圖暫時無法載入'));const retry=el('button','重試載入圖片');retry.onclick=load;preview.append(retry);}
      };
      // Load after the row has entered the document, without requiring a click.
      previewLoads.set(preview,load);
      if(previewObserver)previewObserver.observe(preview);else setTimeout(load,0);
      row.append(first);
      let values = {};
      try {
        values = JSON.parse(job.fields_json || '{}');
      } catch {}
      const editable = ['ready', 'failed'].includes(job.status);
      for (const key of ['code', 'customerName', 'region']) {
        const td = el('td'),
          input = el('input');
        input.name = key;
        input.value = values[key] || '';
        input.disabled = !editable;
        input.maxLength = key === 'customerName' ? 20 : 60;
        input.oninput = () => {
          const checkbox = row.querySelector('[type=checkbox]');
          if (checkbox) checkbox.checked = false;
        };
        td.append(input);
        row.append(td);
      }
      const actions = el('td'),
        check = el('input');
      check.type = 'checkbox';
      check.disabled = !editable;
      const label = el('label', '已核對原圖');
      label.prepend(check);
      actions.append(label);
      if (editable) {
        const create = el('button', '確認建立');
        create.onclick = async () => {
          create.disabled = true;
          try {
            await confirm(row, job);
            await refreshAfter();
          } catch (error) {
            display(error);
            create.disabled = false;
          }
        };
        actions.append(create);
      }
      if (job.status === 'failed' && !job.existing_case_id) {
        const retry = el('button', '重新辨識');
        retry.onclick = async () => {
          retry.disabled = true;
          try {
            await post(`/jobs/${job.id}/retry`, { version: job.version });
            await refreshAfter();
          } catch (error) {
            display(error);
            retry.disabled = false;
          }
        };
        actions.append(retry);
      }
      if (['pending', 'ready', 'failed'].includes(job.status)) {
        const cancel = el('button', '取消');
        cancel.onclick = async () => {
          cancel.disabled = true;
          try {
            await post(`/jobs/${job.id}/cancel`, { version: job.version });
            await refreshAfter();
          } catch (error) {
            display(error);
            cancel.disabled = false;
          }
        };
        actions.append(cancel);
      }
      if (job.evidence_json) {
        const details = el('details');
        details.append(el('summary', '辨識證據'));
        try {
          for (const [key, field] of Object.entries(
            JSON.parse(job.evidence_json),
          )) {
            details.append(
              el(
                'p',
                `${({ code: '代號', customerName: '姓名', region: '地區' })[key] || '欄位'}：${field.evidence || '無可靠文字證據'}；${field.status === 'cross_checked' ? '雙引擎文字相符，仍須核對原圖' : '需要人工確認'}`,
              ),
            );
          }
        } catch {}
        actions.append(details);
      }
      row.append(actions);
      jobs.append(row);
    }
    notice.textContent = `已載入 ${value.jobs.length} 筆。${automatic ? '核對一致的圖片將自動建檔；其他資料待處理。' : '未經人工確認不會建檔。'} 每 5 秒自動更新。`;
    document.getElementById('content').hidden = false;
  } catch (error) {
    display(error);
  } finally {
    busy = false;
    scheduleRefresh();
  }
}
async function refreshAfter() {
  busy = false;
  await refresh();
}
form.onsubmit = async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await post('/routes', {
      name: form.elements.name.value,
      botId: form.elements.botId.value,
      chatId: form.elements.chatId.value,
      topicId: form.elements.topicId.value
        ? Number(form.elements.topicId.value)
        : null,
      collectorId: null,
      routeType: 'intake',
      isActive: true,
    });
    await options();
    notice.textContent = '收件群已儲存。請在該群傳送一張測試圖片。';
  } catch (error) {
    display(error);
  } finally {
    button.disabled = false;
  }
};
document.getElementById('refresh').onclick = () => refresh();
document.getElementById('confirmAll').onclick = () => {
  for (const check of jobs.querySelectorAll(
    'input[type=checkbox]:not(:disabled)',
  ))
    check.checked = true;
};
document.getElementById('createAll').onclick = async () => {
  const rows = [...jobs.querySelectorAll('tr')].filter((row) =>
    row.querySelector('input[type=checkbox]:checked'),
  );
  if (!rows.length) {
    notice.textContent = '請先核對並勾選資料。';
    return;
  }
  busy = true;
  for (const button of document.querySelectorAll('button'))
    button.disabled = true;
  let success = 0;
  for (const row of rows) {
    try {
      await confirm(row, row.job);
      success++;
    } catch (error) {
      display(error);
    }
  }
  busy = false;
  await refresh();
  notice.textContent = `已送出 ${success} 筆建檔；其餘請檢查欄位並重新核對。`;
  for (const button of document.querySelectorAll('button'))
    button.disabled = false;
};
const cleanup = () => {
  disposed = true;
  previewObserver?.disconnect();
  previews.clear();
  clearTimeout(refreshTimer);
  for (const url of images) URL.revokeObjectURL(url);
};
window.addEventListener('beforeunload', cleanup, { once: true });
options().then(refresh).catch(display);
return () => { cleanup(); window.removeEventListener('beforeunload', cleanup); };
}
if (document.getElementById('routeForm')) initializeOcr();
