import { app, scheduleRender } from './state.mjs';
let toastTimer;
export const $ = selector => document.querySelector(selector);
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export const icon = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
export async function api(route, options = {}) {
  let response;
  try {
    response = await fetch(route, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(15000) });
  } catch { throw new Error('无法连接本地服务，请确认服务已启动后重试。'); }
  const data = await response.json().catch(() => ({ error: '服务返回了无法读取的内容' }));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

export function toast(message, error = false) {
  clearTimeout(toastTimer);
  const container = document.querySelector('dialog[open]') || document.body;
  // 原生 dialog 位于浏览器顶层，提示也需放在当前 dialog 内才看得到。
  if (container?.appendChild && $('#toast').parentElement !== container) container.appendChild($('#toast'));
  $('#toast').hidden = false;
  $('#toast').classList.toggle('error', error);
  $('#toastMark').textContent = error ? '!' : '✓';
  $('#toastText').textContent = message;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 7000 : 3200);
}

export async function copy(text, message) {
  try { await navigator.clipboard.writeText(String(text)); }
  catch {
    const focused = document.activeElement;
    const textarea = document.createElement('textarea');
    textarea.className = 'clipboard-fallback';
    textarea.value = String(text);
    (document.querySelector('dialog[open]') || document.body).appendChild(textarea);
    let copied = false;
    try { textarea.select(); copied = document.execCommand('copy'); }
    finally { textarea.remove(); focused?.focus({ preventScroll: true }); }
    if (!copied) throw new Error('浏览器无法写入剪贴板，请检查剪贴板权限。');
  }
  toast(message);
}

export async function perform(button, action) {
  const email = button.closest('[data-email]')?.dataset.email;
  const key = email && button.dataset.act ? `${email}:${button.dataset.act}` : button.id;
  if (app.busy.has(key)) return;
  app.busy.add(key);
  button.disabled = true;
  try { await action(); }
  catch (error) { toast(error.message, true); }
  finally { app.busy.delete(key); button.disabled = false; scheduleRender(); }
}

export function dateText(value, fullDate = false) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '';
  if (fullDate) return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function mailboxLabel(url) {
  if (!url) return '未配置取件地址';
  try { return `收件箱 · ${new URL(url).host}`; } catch { return '取件地址格式不正确'; }
}

export function logClass(line) {
  if (/✗|失败|超时/.test(line)) return 'err';
  return /✓/.test(line) ? 'ok' : '';
}

export function closeMenus(returnFocus = false) {
  for (const menu of document.querySelectorAll('.action-menu[open]')) {
    menu.open = false;
    if (returnFocus) menu.querySelector('summary').focus({ preventScroll: true });
  }
  app.openAccountMenu = null;
}


export function initMenus() {
document.addEventListener('click', event => {
  const summary = event.target.closest('.action-menu > summary');
  if (summary) {
    event.preventDefault();
    const menu = summary.parentElement;
    const opening = !menu.open;
    closeMenus();
    menu.open = opening;
    if (opening && menu.closest('.card')) app.openAccountMenu = menu.closest('.card').dataset.email;
    scheduleRender();
  } else if (event.target.closest('.action-dropdown button:not(:disabled), .action-dropdown a')) {
    closeMenus(); scheduleRender();
  } else if (!event.target.closest('.action-menu')) {
    closeMenus(); scheduleRender();
  }
});
document.addEventListener('keydown', event => {
  const menu = event.target.closest('.action-menu');
  if (event.key === 'Escape') { closeMenus(true); scheduleRender(); return; }
  if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (!menu.open) { closeMenus(); menu.open = true; app.openAccountMenu = menu.closest('.card')?.dataset.email || null; }
  const items = [...menu.querySelectorAll('.action-dropdown button:not(:disabled), .action-dropdown a')];
  const current = items.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
  items[next]?.focus();
});
document.addEventListener('focusin', event => {
  if (!event.target.closest('.action-menu') && document.querySelector('.action-menu[open]')) { closeMenus(); scheduleRender(); }
});

}

export function initToast() {
  $('#btnCloseToast').addEventListener('click', () => { clearTimeout(toastTimer); $('#toast').hidden = true; });
  document.addEventListener('close', event => {
    if (event.target.matches?.('dialog') && $('#toast').parentElement === event.target) document.body.appendChild($('#toast'));
  }, true);
}
