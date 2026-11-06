import { app, setRenderer, scheduleRender } from './js/state.mjs';
import { $, api, toast, perform, initMenus, initToast } from './js/ui.mjs';
import { renderAccounts, initAccounts } from './js/accounts.mjs';
import { updateEditorState, loadEditor, initEditor } from './js/editor.mjs';
import { acceptProxyConfig, updateProxyState, initSettings } from './js/settings.mjs';
import { renderTasks, initTasks } from './js/tasks.mjs';
import { initNavigation, updateNavigation } from './js/navigation.mjs';
import { renderAccountDetails } from './js/account-details.mjs';

function render() {
  renderAccounts();
  renderAccountDetails();
  updateEditorState();
  updateProxyState();
  renderTasks();
  updateNavigation();
  if (app.updated) $('#updatedAt').textContent = `同步于 ${app.updated.toLocaleTimeString('zh-CN', { hour12: false })}`;
}

function replaceAccounts(next) {
  app.accounts = next;
  const emails = new Set(next.map(account => account.email));
  for (const email of app.selected) if (!emails.has(email)) app.selected.delete(email);
  for (const email of app.openLogs) if (!emails.has(email)) app.openLogs.delete(email);
  for (const email of app.openPlans) if (!emails.has(email)) app.openPlans.delete(email);
  app.updated = new Date();
}

function setConnection(live) {
  app.connected = live;
  $('#connBadge').className = `connection ${live ? 'live' : 'dead'}`;
  $('#connText').textContent = live ? '实时连接' : '重新连接';
  scheduleRender();
}

function startSSE() {
  if (app.source) return;
  app.source = new EventSource('/api/events');
  app.source.onopen = () => { setConnection(true); $('#pageError').hidden = true; };
  // 交给 EventSource 自动重连，服务端在每次连接时补发完整快照。
  app.source.onerror = () => setConnection(false);
  app.source.onmessage = event => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'snapshot' || data.type === 'accounts') {
      replaceAccounts(data.accounts);
      if (data.worker) app.worker = data.worker;
      if (typeof data.headless === 'boolean') $('#modeText').textContent = data.headless ? '后台登录' : '浏览器调试模式';
      if (data.proxy) acceptProxyConfig(data.proxy);
      app.loaded = true;
      scheduleRender();
      return;
    }
    if (data.type === 'worker') { app.worker = data.worker; scheduleRender(); return; }
    if (data.type === 'proxy') { acceptProxyConfig(data.proxy); $('#proxyResult').hidden = true; return; }
    const account = app.accounts.find(item => item.email === data.email);
    if (!account) return;
    app.updated = new Date();
    if (data.log) {
      account.logs ||= [];
      account.logs.push(data.log);
      if (account.logs.length > 300) account.logs.splice(0, account.logs.length - 300);
      if (app.detailsEmail === data.email) renderAccountDetails();
      if (app.view === 'tasks') scheduleRender();
      return;
    }
    if (data.password?.saved && !data.password.uncertain && data.password.updatedAt !== account.password?.updatedAt) toast('密码已设置并记录，可点击「复制密码」');
    if (data.twofa?.verifiedAt && data.twofa.verifiedAt !== account.twofa?.verifiedAt) toast('2FA 登录验证成功，密钥已保存');
    for (const key of ['status', 'stage', 'error', 'info', 'tokenExpires', 'logs', 'password', 'twofa', 'loginMethod', 'plan', 'operation']) if (Object.hasOwn(data, key)) account[key] = data[key];
    scheduleRender();
  };
}

async function refresh() {
  const [next, state, config] = await Promise.all([api('/api/accounts'), api('/api/worker'), api('/api/config')]);
  replaceAccounts(next);
  app.worker = state;
  app.loaded = true;
  $('#modeText').textContent = config.batch.headless ? '后台登录' : '浏览器调试模式';
  acceptProxyConfig(config.proxy);
  $('#pageError').hidden = true;
  render();
}



setRenderer(render);
initMenus();
initToast();
initAccounts({ refresh });
initEditor({ refresh });
initSettings();
initTasks();
initNavigation({ beforeNavigate: view => view === 'manage' ? loadEditor() : undefined });
$('#btnRetryLoad').addEventListener('click', event => perform(event.currentTarget, refresh));
refresh().catch(error => {
  $('#pageErrorText').textContent = error.message;
  $('#pageError').hidden = false;
  render();
}).finally(startSSE);
setInterval(() => { if (app.loaded) scheduleRender(); }, 60000);
window.addEventListener('pagehide', () => app.source?.close());
window.addEventListener('pageshow', event => { if (event.persisted) { app.source = null; startSSE(); } });
