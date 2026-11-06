import { app, STATUS_TEXT, LOGIN_METHODS, active, usable, status, attention, actionable, setupComplete, scheduleRender as render } from './state.mjs';
import { $, esc, icon, api, toast, copy, perform, dateText, mailboxLabel, logClass, closeMenus } from './ui.mjs';
import { filteredAccounts, paginatedAccounts, resetFilters, updateMembershipOptions, activeFilterChips, clearFilter, selectedAccounts } from './filters.mjs';
import { openAccountDetails, initAccountDetails } from './account-details.mjs';
import { openAccountAction, initAccountActions, updateAccountAction } from './account-actions.mjs';
import { membershipName, expirySummary, quotaSummary } from './plans.mjs';
import { navigate } from './navigation.mjs';
import { queueEmails, queuePlans, queueSetup } from './tasks.mjs';
import { showEditor } from './editor.mjs';

export async function exportAccounts(emails) {
  if (!emails.length) { toast('请选择要导出的账号'); return; }
  const { content, count } = await api('/api/accounts/export', { method: 'POST', body: JSON.stringify({ emails }) });
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `chatgpt-accounts-${count}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  link.hidden = true;
  try {
    (document.querySelector('dialog[open]') || document.body).appendChild(link);
    link.click();
    toast(`已导出 ${count} 个账号，缺失字段使用 x`);
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function accountHTML(account) {
  const email = esc(account.email);
  const state = status(account);
  const logs = account.logs || [];
  const hasToken = Boolean(account.info?.accessToken);
  const hasSession = Boolean(account.info?.raw);
  const fetched = dateText(account.info?.fetchedAt);
  const expiration = dateText(account.tokenExpires || account.info?.expires, true);
  const sessionValid = usable({ ...account, unavailable: false });
  const password = account.password || {};
  const twofa = account.twofa || {};
  const accountError = account.error || password.error || twofa.error;
  const canAuthenticate = password.saved || password.uncertain || Boolean(account.mailUrl);
  const stateLabel = account.operation?.startsWith('setup') && ['running', 'fail'].includes(state) ? (state === 'running' ? '初始化中' : '初始化未完成') : account.operation === 'plan' && state === 'running' ? '获取套餐中' : account.operation?.startsWith('twofa') && ['running', 'fail'].includes(state)
    ? (state === 'running' ? (account.operation === 'twofa-verify' ? '验证 2FA 中' : '绑定 2FA 中') : '2FA 任务失败')
    : account.operation?.startsWith('password') && ['running', 'fail'].includes(state)
    ? (state === 'running' ? (account.operation === 'password-verify' ? '验证密码中' : '设置密码中') : '密码任务失败') : STATUS_TEXT[state];
  const disabled = action => app.busy.has(`${account.email}:${action}`) ? 'disabled' : '';
  return `
    <div class="card-head">
      <label class="account-check"><input type="checkbox" data-act="select" ${app.selected.has(account.email) ? 'checked' : ''}><span class="sr-only">选择 ${email}</span></label>
      <div class="account-meta"><h2 class="email"><button data-act="details" title="查看 ${email} 的账号详情">${email}</button></h2><div class="account-sub" title="${esc(mailboxLabel(account.mailUrl))}${fetched ? ` · 获取于 ${esc(fetched)}` : ''}"><span>${LOGIN_METHODS[account.loginMethod] || '登录资料待补充'}</span><i class="sub-divider" aria-hidden="true"></i><span>${expiration ? `会话${sessionValid ? '有效至' : '到期'} ${esc(expiration)}` : hasToken ? '有效期未知' : '尚无会话'}</span></div></div>
      <div class="account-status"><span class="badge ${state}"><span class="status-dot"></span>${stateLabel}</span></div>
      <details class="action-menu account-menu" ${app.openAccountMenu === account.email ? 'open' : ''}>
        <summary class="btn small" data-act="menu" aria-label="${email} 的操作">更多${icon('chevron')}</summary>
        <div class="action-dropdown" aria-label="${email} 的账号操作">
          <div class="menu-group"><span class="dropdown-label">账号与套餐</span>
            <button data-act="edit">${icon('edit')}编辑账号</button>
            <button data-act="login" ${!actionable(account) || !app.connected ? 'disabled' : disabled('login')}>${icon('refresh')}${hasToken ? '重新登录' : '登录'}</button>
            <button data-act="refresh-plan" ${!actionable(account) || !app.connected ? 'disabled' : disabled('refresh-plan')}>${icon('refresh')}刷新会员与额度</button>
            <button data-act="plan-details" aria-haspopup="dialog">${icon('log')}查看会员与额度</button>
          </div>
          <div class="menu-group"><span class="dropdown-label">导出与复制</span>
      <button data-act="export" title="导出邮箱、密码、2FA 密钥和取件地址为 TXT" ${!app.connected ? 'disabled' : disabled('export')}>${icon('download')}导出账号</button>
      <button class="action-btn token" data-act="copy-token" ${hasToken ? '' : 'disabled'}>${icon('copy')}复制 accessToken</button>
      <button class="action-btn" data-act="copy-session" ${hasSession ? '' : 'disabled'}>${icon('copy')}复制 Session</button>
      <button class="action-btn" data-act="copy-email">${icon('copy')}复制邮箱</button>
      <button class="action-btn" data-act="copy-mailurl" ${account.mailUrl ? '' : 'disabled'}>${icon('copy')}复制取件地址</button>
          </div>
          <div class="menu-group"><span class="dropdown-label">密码与验证器</span><button data-act="setup" ${!actionable(account) || !app.connected || setupComplete(account) ? 'disabled' : disabled('setup')}>${icon('key')}${setupComplete(account) ? '密码与 2FA 已就绪' : '初始化密码 + 开通 2FA'}</button>
      <button class="action-btn" data-act="init-password" title="到官网设置 12 位随机密码，验证新密码登录后保存" ${!actionable(account) || !app.connected || password.uncertain ? 'disabled' : disabled('init-password')}>${icon('key')}${password.saved ? '修改密码' : '初始化密码'}</button>
      <button class="action-btn" data-act="copy-password" ${password.saved ? '' : 'disabled'}>${icon('copy')}复制密码</button>
      ${password.saved || password.uncertain ? `<button class="action-btn" data-act="verify-password" ${!actionable(account) || !app.connected ? 'disabled' : disabled('verify-password')}>${icon('refresh')}验证密码登录</button>` : ''}
      ${password.uncertain ? `<button class="action-btn" data-act="copy-pending-password">${icon('copy')}复制待确认密码</button>` : ''}
      ${!twofa.hasSecret && !twofa.hasImportedSecret ? `<button class="action-btn" data-act="init-twofa" title="绑定 Google Authenticator 兼容验证器，保存手动密钥并验证登录" ${!actionable(account) || !app.connected || !canAuthenticate ? 'disabled' : disabled('init-twofa')}>${icon('key')}启用 2FA</button>` : `
        <button class="action-btn" data-act="replace-twofa" title="到官网关闭旧验证器、绑定新密钥，并验证新密钥登录" ${!actionable(account) || !app.connected || !canAuthenticate ? 'disabled' : disabled('replace-twofa')}>${icon('key')}${twofa.rotating ? '继续修改 2FA' : '修改 2FA'}</button>
        <button class="action-btn" data-act="copy-twofa">${icon('copy')}复制 2FA 密钥</button>
        <button class="action-btn" data-act="copy-totp">${icon('copy')}复制验证码</button>
        <button class="action-btn" data-act="verify-twofa" ${!actionable(account) || !app.connected || !canAuthenticate ? 'disabled' : disabled('verify-twofa')}>${icon('refresh')}验证 2FA 登录</button>
      `}
      ${twofa.hasPendingSecret ? `<button class="action-btn" data-act="copy-pending-twofa">${icon('copy')}复制待确认 2FA 密钥</button>` : ''}
          ${twofa.hasSecret || twofa.hasImportedSecret ? '<a href="https://2fa.dollar.xn--fiqs8s/totp-generator" target="_blank" rel="noopener noreferrer">在线验证码工具 ↗</a>' : ''}
          </div>
          <div class="menu-group"><span class="dropdown-label">运行记录</span>
      <button class="action-btn" data-act="logs" aria-haspopup="dialog">${icon('log')}查看日志</button>
            <button data-act="copy-logs" ${logs.length ? '' : 'disabled'}>${icon('copy')}复制日志</button>
          </div>
          <div class="menu-group"><span class="dropdown-label">账号管理</span>
            <button data-act="${account.unavailable ? 'restore' : 'disable'}" ${active(account) || !app.connected ? 'disabled' : ''}>${account.unavailable ? '恢复使用' : '标记为不可用'}</button>
            <button class="danger-action" data-act="delete" ${active(account) || !app.connected ? 'disabled' : ''}>删除账号</button>
          </div>
        </div>
      </details>
    </div>
    <div class="account-security"><span class="${password.uncertain ? 'uncertain' : ''}">${password.uncertain ? '密码待确认' : password.verifiedAt ? '密码已验证' : password.saved ? '密码已保存' : '未保存密码'}</span><span class="${twofa.pending ? 'uncertain' : ''}">${twofa.rotating ? '2FA 更换待完成' : twofa.verifiedAt ? '2FA 已验证' : twofa.enabled ? '2FA 已启用' : twofa.hasSecret ? '2FA 已保存 · 待验证' : twofa.hasImportedSecret ? '2FA 已导入 · 登录时保存' : '未保存 2FA'}</span>${active(account) && account.stage ? `<span class="stage">${esc(account.stage)}</span>` : ''}</div>
    <div class="card-membership"><button class="card-plan-link" data-act="plan-details" aria-haspopup="dialog"><span>会员类别</span><strong>${esc(membershipName(account.plan))}</strong>${icon('arrow')}</button><span class="card-plan-expiry" title="${esc(expirySummary(account.plan))}">${esc(expirySummary(account.plan, true))}</span><button class="card-quota-link" data-act="plan-details" aria-haspopup="dialog" title="查看窗口额度与重置时间">${esc(quotaSummary(account.plan))}</button></div>
    ${accountError || account.plan?.error ? `<button class="card-error error-link" data-act="${accountError ? 'logs' : 'plan-details'}" title="查看完整错误"><span>${esc((accountError || account.plan.error).split('\n')[0])}</span>${icon('arrow')}</button>` : ''}
    <div class="card-footer"><button class="btn small card-primary" data-act="login" ${!actionable(account) || !app.connected ? 'disabled' : disabled('login')}>${icon('play')}${account.unavailable ? '不可用' : active(account) ? account.status === 'pending' ? '等待执行' : '执行中' : hasToken ? '重新登录' : '登录'}</button><div class="card-shortcuts"><button class="text-btn" data-act="edit" aria-haspopup="dialog">编辑</button><button class="text-btn" data-act="copy-token" ${hasToken ? '' : 'disabled'}>复制 Token</button><button class="text-btn" data-act="logs" aria-haspopup="dialog">日志</button></div></div>`;
}

export function renderAccounts() {
  updateMembershipOptions();
  const visible = filteredAccounts();
  const page = paginatedAccounts(visible);
  const pageEmails = new Set(page.items.map(account => account.email));
  const visibleEmails = new Set(visible.map(account => account.email));
  if (app.openAccountMenu && !pageEmails.has(app.openAccountMenu)) app.openAccountMenu = null;
  const allEmails = new Set(app.accounts.map(account => account.email));
  for (const email of app.selected) if (!allEmails.has(email)) app.selected.delete(email);
  const ready = app.accounts.filter(usable).length;
  const processing = app.accounts.filter(active).length;
  const needsWork = app.accounts.filter(attention).length;
  const failed = app.accounts.filter(account => account.status === 'fail').length;
  const expired = app.accounts.filter(account => status(account) === 'expired').length;
  const passwordIssues = app.accounts.filter(account => account.password?.error || account.password?.uncertain).length;
  const twofaIssues = app.accounts.filter(account => account.twofa?.error || account.twofa?.pending).length;
  const planIssues = app.accounts.filter(account => account.plan?.error).length;
  const partialPlans = app.accounts.filter(account => account.plan?.missingSections?.some(item => item.section === 'usage') && !account.plan?.error).length;
  for (const [name, count] of Object.entries({ Total: app.accounts.length, Ready: ready, Active: processing, Attention: needsWork })) $('#count' + name).textContent = app.loaded ? count : '—';
  for (const [name, count] of Object.entries({ All: app.accounts.length, Ready: ready, Active: processing, Attention: needsWork })) $('#filter' + name).textContent = count;
  $('#filterUnavailable').textContent = app.accounts.filter(account => account.unavailable).length;
  $('#activeNote').textContent = processing ? `运行 ${app.worker.inFlight.length} · 等待 ${app.worker.queue.length}` : '运行与等待的任务';
  $('#attentionNote').textContent = planIssues ? `套餐查询失败 ${planIssues} · 过期 ${expired}` : twofaIssues ? `2FA 待处理 ${twofaIssues} · 过期 ${expired}` : passwordIssues ? `密码待处理 ${passwordIssues} · 过期 ${expired}` : failed || expired ? `失败 ${failed} · 过期 ${expired}` : '未登录、失败与过期';
  const planCounts = new Map();
  for (const account of app.accounts) if (account.plan?.fetchedAt) planCounts.set(account.plan.planName, (planCounts.get(account.plan.planName) || 0) + 1);
  const fetchedPlans = app.accounts.filter(account => account.plan?.fetchedAt).length;
  $('#plansSummary').textContent = `套餐已获取 ${fetchedPlans} / ${app.accounts.length}${[...planCounts].map(([name, count]) => ` · ${name} ${count}`).join('')}${partialPlans ? ` · 部分更新 ${partialPlans}` : ''}${planIssues ? ` · 查询失败 ${planIssues}` : ''}`;
  $('.filters').querySelectorAll('[data-filter]').forEach(button => {
    button.classList.toggle('active', button.dataset.filter === app.filter);
    button.setAttribute('aria-pressed', String(button.dataset.filter === app.filter));
  });
  const list = $('#cardList');
  const existing = new Map([...list.children].map(node => [node.dataset.email, node]));
  const focused = document.activeElement;
  const focusEmail = focused.closest('.card')?.dataset.email;
  const focusAction = focused.dataset.act;
  const focusFooter = Boolean(focused.closest('.card-footer'));
  const focusMenu = Boolean(focused.closest('.account-menu'));
  page.items.forEach((account, index) => {
    let node = existing.get(account.email);
    if (!node) {
      node = document.createElement('article');
      node.dataset.email = account.email;
    }
    node.className = `card${app.selected.has(account.email) ? ' selected' : ''}${account.unavailable ? ' unavailable' : ''}`;
    const html = accountHTML(account);
    if (node._html !== html) {
      node.innerHTML = html;
      node._html = html;
    }
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
  });
  for (const node of [...list.children]) if (!pageEmails.has(node.dataset.email)) node.remove();
  if (focusEmail && focusAction && !focused.isConnected) {
    const card = [...list.children].find(node => node.dataset.email === focusEmail);
    const matching = card?.querySelector(`${focusFooter ? '.card-footer ' : focusMenu ? '.account-menu ' : ''}[data-act="${focusAction}"]${focusMenu ? '' : ':not(.action-dropdown *)'}`);
    (matching || card?.querySelector('.account-menu > summary') || $('#searchInput')).focus({ preventScroll: true });
  }
  $('#loadingState').hidden = app.loaded || !$('#pageError').hidden;
  $('#emptyState').hidden = !app.loaded || visible.length > 0;
  const isEmpty = app.accounts.length === 0;
  $('#emptyTitle').textContent = isEmpty ? '从第一个账号开始' : '没有符合条件的账号';
  $('#emptyDescription').textContent = isEmpty ? '导入邮箱与取件地址，登录成功后即可复制 Token 和完整会话。' : '试试其他关键词，或清除筛选查看全部账号。';
  $('#btnEmptyAction').textContent = isEmpty ? '添加账号' : '清除筛选';
  $('#btnResetFilters').disabled = app.filter === 'all' && !$('#searchInput').value && $('#planFilter').value === 'all';
  $('#listCount').textContent = visible.length ? `${page.start + 1}–${page.start + page.items.length} / ${visible.length} 个账号` : '0 个账号';
  $('#pagePosition').textContent = `第 ${app.page} / ${page.pages} 页`;
  $('#btnPrevPage').disabled = app.page <= 1;
  $('#btnNextPage').disabled = app.page >= page.pages;
  $('#accountPagination').hidden = page.pages <= 1;
  $('#selectAll').disabled = !page.items.length;
  $('#selectAll').checked = page.items.length > 0 && page.items.every(account => app.selected.has(account.email));
  $('#selectAll').indeterminate = page.items.some(account => app.selected.has(account.email)) && !$('#selectAll').checked;
  const chips = activeFilterChips();
  const chipHtml = chips.map(([key, label]) => `<button class="filter-chip" data-clear-filter="${key}" title="移除${esc(label)}"><span>${esc(label)}</span>${icon('close')}</button>`).join('');
  if ($('#activeFilterChips').innerHTML !== chipHtml) $('#activeFilterChips').innerHTML = chipHtml;
  $('#activeFilters').hidden = !chips.length;
  $('#btnClearSearch').hidden = !$('#searchInput').value;
  $('#resultSummary').textContent = `匹配 ${visible.length} / ${app.accounts.length}`;
  $('#bulkScope').textContent = `当前匹配 ${visible.length} 个账号（所有页）`;
  $('#btnSelectFiltered').textContent = `选择匹配的 ${visible.length} 个`;
  $('#btnSelectFiltered').disabled = !visible.length || visible.every(account => app.selected.has(account.email));
  const hiddenSelected = [...app.selected].filter(email => !visibleEmails.has(email)).length;
  $('#selectionBar').hidden = !app.selected.size;
  $('#selectionText').textContent = `已选 ${app.selected.size} 个${hiddenSelected ? ` · ${hiddenSelected} 个不在当前筛选中` : ''}`;
  $('#selectionScope').textContent = '以下操作仅处理已选账号；导出读取当前已保存资料';
  $('#btnLoginSelected').disabled = !app.connected || app.busy.has('btnLoginSelected') || !app.accounts.some(account => app.selected.has(account.email) && actionable(account));
  for (const scope of ['Filtered', 'Selected']) {
    const id = `btnPlans${scope}`;
    $('#' + id).disabled = !app.connected || app.busy.has(id) || !(scope === 'Filtered' ? visible : selectedAccounts()).some(actionable);
    const exportId = `btnExport${scope}`;
    $('#' + exportId).disabled = !app.connected || app.busy.has(exportId) || !(scope === 'Filtered' ? visible : selectedAccounts()).length;
  }
  for (const [mode, suffix] of [['all', 'Setup'], ['password', 'Passwords'], ['twofa', 'Twofa']]) {
    for (const scope of ['Filtered', 'Selected']) {
      const id = `btn${suffix}${scope}`;
      const available = (scope === 'Filtered' ? visible : selectedAccounts()).some(account => actionable(account) && !setupComplete(account, mode));
      $('#' + id).disabled = !app.connected || app.busy.has(id) || !available;
    }
  }
  const pending = visible.filter(account => actionable(account) && !usable(account));
  $('#batchLabel').textContent = pending.length ? `登录待处理 (${pending.length})` : '登录待处理';
  $('#btnBatch').disabled = !app.connected || !pending.length || app.busy.has('btnBatch');
  $('#btnRefresh').disabled = app.busy.has('btnRefresh');
  $('#btnImport').disabled = app.busy.has('btnImport');
  updateAccountAction();
}

export function initAccounts({ refresh }) {
  initAccountDetails();
  initAccountActions();
  const handleAction = event => {
    const button = event.target.closest('button[data-act]');
    if (!button || button.disabled) return;
    const account = app.accounts.find(item => item.email === button.closest('[data-email]')?.dataset.email);
    if (!account) return;
    const action = button.dataset.act;
    const trigger = button.closest('.action-menu')?.querySelector('summary') || button;
    closeMenus();
    if (['delete', 'disable', 'restore'].includes(action)) {
      openAccountAction(account.email, action, trigger);
      return;
    }
    if (['logs', 'plan-details', 'details'].includes(action)) {
      openAccountDetails(account.email, action === 'logs' ? 'logs' : 'plan', trigger);
      return;
    }
    perform(button, async () => {
      if (action === 'edit') await showEditor(account.email, trigger);
      if (action === 'setup') await queueSetup([account.email]);
      if (action === 'login') await queueEmails([account.email]);
      if (action === 'refresh-plan') await queuePlans([account.email]);
      if (action === 'export') await exportAccounts([account.email]);
      if (action === 'init-password') {
        const result = await api(account.password?.saved ? '/api/password/change' : '/api/password/init', { method: 'POST', body: JSON.stringify({ email: account.email }) });
        toast(result.queued ? '官网密码设置已加入队列，将生成 12 位随机密码并验证登录' : '该账号已有任务正在执行');
      }
      if (action === 'verify-password') {
        const result = await api('/api/password/verify', { method: 'POST', body: JSON.stringify({ email: account.email }) });
        toast(result.queued ? '已加入密码登录验证任务' : '该账号已有任务正在执行');
      }
      if (['init-twofa', 'verify-twofa', 'replace-twofa'].includes(action)) {
        const route = { 'init-twofa': 'init', 'verify-twofa': 'verify', 'replace-twofa': 'replace' }[action];
        const result = await api(`/api/twofa/${route}`, { method: 'POST', body: JSON.stringify({ email: account.email }) });
        toast(result.queued ? (action === 'replace-twofa' ? '官网 2FA 更换已加入队列，完成后将验证新密钥登录' : action === 'init-twofa' ? '2FA 绑定任务已加入队列' : '2FA 登录验证已加入队列') : '该账号已有任务正在执行');
      }
      if (['copy-twofa', 'copy-totp', 'copy-pending-twofa'].includes(action)) {
        const data = await api(`/api/twofa?email=${encodeURIComponent(account.email)}${action === 'copy-pending-twofa' ? '&pending=1' : ''}`);
        await copy(action === 'copy-totp' ? data.code : data.secret, action === 'copy-totp' ? `验证码已复制，约 ${data.remaining} 秒内有效` : action === 'copy-pending-twofa' ? '待确认的新 2FA 密钥已复制' : '2FA 密钥已复制');
      }
      if (action === 'copy-password' || action === 'copy-pending-password') {
        const pending = action === 'copy-pending-password';
        const { password } = await api(`/api/password?email=${encodeURIComponent(account.email)}${pending ? '&pending=1' : ''}`);
        await copy(password, pending ? '待确认密码已复制，请先验证是否生效' : '密码已复制');
      }
      if (action === 'copy-token') await copy(account.info.accessToken, 'accessToken 已复制');
      if (action === 'copy-session') await copy(typeof account.info.raw === 'string' ? account.info.raw : JSON.stringify(account.info.raw), '完整 Session 已复制');
      if (action === 'copy-email') await copy(account.email, '邮箱已复制');
      if (action === 'copy-mailurl') await copy(account.mailUrl, '取件地址已复制');
      if (action === 'copy-logs') await copy(account.logs.join('\n'), '运行日志已复制');
    });
  };
  $('#cardList').addEventListener('click', handleAction);
  $('#accountDetails').addEventListener('click', handleAction);
  $('#cardList').addEventListener('change', event => {
    if (event.target.dataset.act !== 'select') return;
    const email = event.target.closest('.card').dataset.email;
    if (event.target.checked) app.selected.add(email); else app.selected.delete(email);
    render();
  });
  $('.filters').addEventListener('click', event => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    app.filter = button.dataset.filter;
    app.page = 1;
    render();
  });
  $('.metrics').addEventListener('click', event => {
    const metric = event.target.closest('[data-metric-filter]');
    if (!metric) return;
    app.filter = metric.dataset.metricFilter;
    app.page = 1; render(); $('#searchInput').focus();
  });
  const resetPage = () => { app.page = 1; render(); };
  $('#searchInput').addEventListener('input', resetPage);
  $('#planFilter').addEventListener('change', resetPage);
  $('#btnResetFilters').addEventListener('click', resetFilters);
  $('#sortSelect').addEventListener('change', resetPage);
  $('#selectAll').addEventListener('change', event => {
    for (const account of paginatedAccounts().items) {
      if (event.target.checked) app.selected.add(account.email); else app.selected.delete(account.email);
    }
    render();
  });
  $('#btnClearSelection').addEventListener('click', () => { app.selected.clear(); render(); });
  $('#btnLoginSelected').addEventListener('click', event => perform(event.currentTarget, () => queueEmails(selectedAccounts().filter(actionable).map(account => account.email))));
  for (const scope of ['Filtered', 'Selected']) {
    $(`#btnPlans${scope}`).addEventListener('click', event => perform(event.currentTarget, () => queuePlans((scope === 'Filtered' ? filteredAccounts() : selectedAccounts())
      .filter(actionable).map(account => account.email))));
    $(`#btnExport${scope}`).addEventListener('click', event => perform(event.currentTarget, () => exportAccounts((scope === 'Filtered' ? filteredAccounts() : selectedAccounts())
      .map(account => account.email))));
  }
  for (const [mode, suffix] of [['all', 'Setup'], ['password', 'Passwords'], ['twofa', 'Twofa']]) {
    for (const scope of ['Filtered', 'Selected']) {
      $(`#btn${suffix}${scope}`).addEventListener('click', event => perform(event.currentTarget, () => queueSetup((scope === 'Filtered' ? filteredAccounts() : selectedAccounts())
        .filter(account => actionable(account) && !setupComplete(account, mode))
        .map(account => account.email), mode)));
    }
  }
  $('#btnBatch').addEventListener('click', event => perform(event.currentTarget, () => queueEmails(filteredAccounts().filter(account => actionable(account) && !usable(account)).map(account => account.email))));
  $('#btnTaskRecords').addEventListener('click', () => navigate('tasks'));
  $('#btnSelectFiltered').addEventListener('click', () => { for (const account of filteredAccounts()) app.selected.add(account.email); render(); });
  $('#activeFilterChips').addEventListener('click', event => {
    const chip = event.target.closest('[data-clear-filter]');
    if (chip) clearFilter(chip.dataset.clearFilter);
  });
  $('#btnClearSearch').addEventListener('click', () => { clearFilter('search'); $('#searchInput').focus(); });
  $('#pageSizeSelect').addEventListener('change', event => {
    const size = Number(event.target.value);
    if (![12, 24, 48].includes(size)) return;
    app.pageSize = size; app.page = 1; closeMenus(); render();
  });
  document.addEventListener('keydown', event => {
    if (app.view !== 'accounts' || document.querySelector('dialog[open]')) return;
    const typing = event.target.closest('input, textarea, select, [contenteditable="true"]');
    if (event.key === '/' && !typing) { event.preventDefault(); $('#searchInput').focus(); }
  });
  for (const [id, direction] of [['btnPrevPage', -1], ['btnNextPage', 1]]) {
    $('#' + id).addEventListener('click', () => {
      app.page += direction;
      closeMenus();
      render();
      $('#accountWorkspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  $('#btnRefresh').addEventListener('click', event => perform(event.currentTarget, async () => { await refresh(); toast('账号与会话已更新'); }));
  $('#btnImport').addEventListener('click', event => perform(event.currentTarget, () => showEditor()));
  $('#btnEmptyAction').addEventListener('click', event => {
    if (!app.accounts.length) { perform(event.currentTarget, showEditor); return; }
    resetFilters(); $('#searchInput').focus();
  });

}
