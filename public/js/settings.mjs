import { app } from './state.mjs';
import { $, api, perform, toast, dateText } from './ui.mjs';
let systemTheme;
export function acceptProxyConfig(value, reset = false) {
  if (!value) return;
  app.proxyConfig = value;
  if (reset || !app.proxyDirty) {
    $('#proxyEnabled').checked = value.enabled;
    $('#proxyServer').value = value.server;
    $('#proxyUsername').value = value.username;
    $('#proxyPassword').value = '';
    $('#proxyClearPassword').checked = false;
    app.proxyDirty = false;
  }
  updateProxyState();
}

export function proxyPayload() {
  return { enabled: $('#proxyEnabled').checked, server: $('#proxyServer').value, username: $('#proxyUsername').value,
    password: $('#proxyPassword').value, clearPassword: $('#proxyClearPassword').checked };
}

export function updateProxyState() {
  const waiting = app.busy.has('btnProxySave') || app.busy.has('btnProxyTest');
  $('#proxyEnabled').disabled = waiting || !app.proxyConfig;
  $('#proxyFields').disabled = waiting || !app.proxyConfig || !$('#proxyEnabled').checked;
  $('#btnProxySave').disabled = !app.connected || waiting || !app.proxyDirty;
  $('#btnProxyReset').disabled = waiting || !app.proxyDirty;
  $('#btnProxyTest').disabled = !app.connected || waiting || !app.proxyConfig || !$('#proxyEnabled').checked || !$('#proxyServer').value.trim();
  $('#btnProxySave').textContent = app.busy.has('btnProxySave') ? '保存中…' : '保存代理';
  $('#btnProxyTest').textContent = app.busy.has('btnProxyTest') ? '检测中…' : '检测出口 IP';
  $('#proxyPassword').placeholder = app.proxyConfig?.hasPassword ? '已保存；同一代理留空保留' : '无认证时留空';
  $('#proxyStatus').textContent = !app.proxyConfig ? '正在读取' : app.proxyConfig.enabled ? `已启用 · ${app.proxyConfig.server}` : '未启用';
  $('#proxyStatus').classList.toggle('enabled', Boolean(app.proxyConfig?.enabled));
  $('#proxyHint').textContent = app.worker.inFlight.length ? '当前账号保持原连接，新配置从下一个账号任务生效。' : app.proxyDirty ? '有未保存的更改。检测使用当前表单配置，检测成功后仍需保存。' : '检测出口 IP 使用当前表单配置，不会登录任何账号。';
}

export function editProxy() {
  app.proxyDirty = true;
  $('#proxyError').hidden = true;
  $('#proxyResult').hidden = true;
  updateProxyState();
}

export function applyTheme(value) {
  document.documentElement.dataset.theme = value === 'dark' || (value === 'auto' && systemTheme.matches) ? 'dark' : 'light';
}


export function initSettings() {
  api('/api/config').then(config => { $('#threadPoolSize').value = config.batch.threadPoolSize || 1; }).catch(error => toast(error.message, true));
  $('#threadPoolForm').addEventListener('submit', event => {
    event.preventDefault();
    perform($('#btnThreadPoolSave'), async () => {
      const threadPoolSize = Number($('#threadPoolSize').value);
      if (!Number.isInteger(threadPoolSize) || threadPoolSize < 1 || threadPoolSize > 10) throw new Error('线程池数量必须是 1–10 的整数');
      await api('/api/thread-pool', { method: 'POST', body: JSON.stringify({ threadPoolSize }) });
      toast(`线程池数量已保存：同时处理 ${threadPoolSize} 个账号任务`);
    });
  });
    systemTheme = matchMedia('(prefers-color-scheme: dark)');
  $('#proxyForm').addEventListener('input', editProxy);
  $('#btnProxyReset').addEventListener('click', () => {
    acceptProxyConfig(app.proxyConfig, true);
    $('#proxyError').hidden = true;
    $('#proxyResult').hidden = true;
  });
  $('#proxyForm').addEventListener('submit', event => {
    event.preventDefault();
    if ($('#btnProxySave').disabled) return;
    perform($('#btnProxySave'), async () => {
      updateProxyState();
      try {
        const result = await api('/api/proxy', { method: 'POST', body: JSON.stringify(proxyPayload()) });
        acceptProxyConfig(result.proxy, true);
        $('#proxyError').hidden = true;
        $('#proxyResult').hidden = true;
        toast(result.nextTask ? '代理配置已保存，从下一个账号任务生效' : result.proxy.enabled ? '全局代理已保存并启用' : '全局代理已关闭');
      } catch (error) {
        $('#proxyError').textContent = error.message;
        $('#proxyError').hidden = false;
      }
    });
  });
  $('#btnProxyTest').addEventListener('click', event => perform(event.currentTarget, async () => {
    updateProxyState();
    $('#proxyError').hidden = true;
    $('#proxyResult').hidden = true;
    try {
      const result = await api('/api/proxy/test', { method: 'POST', body: JSON.stringify(proxyPayload()) });
      $('#proxyResult').textContent = `出口 IP：${result.ip} · 请求耗时 ${result.latencyMs} ms · 检测于 ${dateText(result.checkedAt)}`;
      $('#proxyResult').hidden = false;
    } catch (error) {
      $('#proxyError').textContent = error.message;
      $('#proxyError').hidden = false;
    }
  }));

  $('#themeSelect').addEventListener('change', event => {
    applyTheme(event.target.value);
    try { localStorage.setItem('chatgpt-login-appearance', event.target.value); } catch {}
  });
  systemTheme.addEventListener('change', () => applyTheme($('#themeSelect').value));
  let appearance = 'auto';
  try { appearance = localStorage.getItem('chatgpt-login-appearance') || 'auto'; } catch {}
  if (!['auto', 'light', 'dark'].includes(appearance)) appearance = 'auto';
  $('#themeSelect').value = appearance;
  applyTheme(appearance);


}
