import { app, scheduleRender } from './state.mjs';
import { $, closeMenus, toast } from './ui.mjs';

const VIEWS = {
  accounts: { title: '账号概览', description: '查看会话与套餐，选择需要处理的账号。', number: '01' },
  manage: { title: '账号管理', description: '新增、导入和编辑登录资料，保存后统一生效。', number: '02' },
  tasks: { title: '任务队列', description: '查看执行进度、等待中的任务与本次运行记录。', number: '03' },
  settings: { title: '全局设置', description: '管理网络代理与界面外观。', number: '04' },
};
let beforeNavigate = async () => {};
let transition = 0;

export async function navigate(view, { history = true, focus = true } = {}) {
  if (!VIEWS[view]) return;
  const current = ++transition;
  try { await beforeNavigate(view); }
  catch (error) { if (current === transition) toast(error.message, true); return; }
  if (current !== transition) return;
  app.view = view;
  for (const panel of document.querySelectorAll('[data-view]')) panel.hidden = panel.dataset.view !== view;
  for (const link of document.querySelectorAll('.primary-nav [data-nav]')) {
    if (link.dataset.nav === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  $('#pageTitle').textContent = VIEWS[view].title;
  $('#pageDescription').textContent = VIEWS[view].description;
  $('#viewNumber').textContent = VIEWS[view].number;
  $('#overviewActions').hidden = view !== 'accounts';
  document.title = `${VIEWS[view].title} · ChatGPT Login`;
  if (history && window.location.hash !== `#${view}`) window.history.pushState(null, '', `#${view}`);
  closeMenus();
  if (focus) $('#pageTitle').focus({ preventScroll: true });
  scheduleRender();
}

export function updateNavigation() {
  const pending = app.worker.queue.length + app.worker.inFlight.length;
  $('#navTaskCount').textContent = pending;
  $('#navTaskCount').hidden = !pending;
  $('#navDraft').hidden = !app.editorDirty && !$('#accountsText').value.trim();
}

export function initNavigation(options = {}) {
  beforeNavigate = options.beforeNavigate || beforeNavigate;
  document.addEventListener('click', event => {
    const link = event.target.closest('[data-nav]');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(link.dataset.nav);
  });
  window.addEventListener('popstate', () => navigate(window.location.hash.slice(1) || 'accounts', { history: false }));
  window.addEventListener('hashchange', () => navigate(window.location.hash.slice(1), { history: false }));
  navigate(VIEWS[window.location.hash.slice(1)] ? window.location.hash.slice(1) : 'accounts', { focus: false });
}
