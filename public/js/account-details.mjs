import { app, actionable, STATUS_TEXT, status } from './state.mjs';
import { $, esc, logClass } from './ui.mjs';
import { planHTML } from './plans.mjs';

let returnTarget = null;

export function openAccountDetails(email, tab = 'plan', trigger) {
  if (!app.accounts.some(account => account.email === email)) return;
  const dialog = $('#accountDetails');
  const changed = app.detailsEmail !== email || app.detailsTab !== tab;
  app.detailsEmail = email;
  app.detailsTab = tab === 'logs' ? 'logs' : 'plan';
  returnTarget = { element: trigger, email, action: trigger?.dataset.act };
  renderAccountDetails();
  if (!dialog.open) dialog.showModal();
  if (changed) $('#accountDetailsBody').scrollTop = 0;
}

export function renderAccountDetails() {
  if (!app.detailsEmail) return;
  const account = app.accounts.find(item => item.email === app.detailsEmail);
  if (!account) { $('#accountDetails').close(); return; }
  const dialog = $('#accountDetails');
  dialog.dataset.email = account.email;
  $('#accountDetailsTitle').textContent = account.email;
  $('#accountDetailsStatus').textContent = `${STATUS_TEXT[status(account)]} ${account.stage ? `· ${account.stage}` : ''}`;
  $('#detailLogin').disabled = !actionable(account) || !app.connected || app.busy.has(`${account.email}:login`);
  $('#detailRefreshPlan').disabled = !actionable(account) || !app.connected || app.busy.has(`${account.email}:refresh-plan`);
  $('#detailCopyLogs').disabled = !account.logs?.length;
  $('#detailCopyLogs').hidden = app.detailsTab !== 'logs';
  $('#detailRefreshPlan').hidden = app.detailsTab !== 'plan';
  for (const tab of dialog.querySelectorAll('[data-detail-tab]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.detailTab === app.detailsTab));
    tab.tabIndex = tab.dataset.detailTab === app.detailsTab ? 0 : -1;
  }
  const body = $('#accountDetailsBody');
  body.setAttribute('aria-labelledby', app.detailsTab === 'logs' ? 'detailLogsTab' : 'detailPlanTab');
  const error = account.error || account.password?.error || account.twofa?.error;
  const logs = account.logs || [];
  const html = app.detailsTab === 'plan' ? planHTML(account, true) : `${error ? `<p class="detail-error">${esc(error)}</p>` : ''}
    <p class="detail-log-count">${logs.length} 行运行日志 · 自动更新</p>
    ${logs.length ? `<div class="log-output" tabindex="0" aria-label="账号运行日志">${logs.map(line => `<div class="log-line ${logClass(line)}">${esc(line)}</div>`).join('')}</div>` : '<p class="log-empty">还没有运行日志。启动账号任务后可在这里查看进度。</p>'}`;
  if (body._html === html) return;
  const oldOutput = body.querySelector('.log-output');
  const top = oldOutput?.scrollTop || 0;
  const atBottom = !oldOutput || oldOutput.scrollHeight - top - oldOutput.clientHeight < 30;
  const logFocused = oldOutput && document.activeElement === oldOutput;
  const scroll = body.scrollTop;
  body.innerHTML = html;
  body._html = html;
  body.scrollTop = scroll;
  const output = body.querySelector('.log-output');
  if (output) {
    output.scrollTop = atBottom ? output.scrollHeight : top;
    if (logFocused) output.focus({ preventScroll: true });
  }
}

export function initAccountDetails() {
  const dialog = $('#accountDetails');
  $('#btnCloseAccountDetails').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    app.detailsEmail = null;
    const target = returnTarget;
    returnTarget = null;
    $('#accountDetailsBody').innerHTML = '';
    $('#accountDetailsBody')._html = null;
    const card = [...$('#cardList').children].find(node => node.dataset.email === target?.email);
    const original = target?.element?.isConnected ? target.element : card?.querySelector(`[data-act="${target?.action || 'details'}"]:not(.action-dropdown *)`);
    (original || card?.querySelector('.account-menu > summary') || $('#searchInput')).focus({ preventScroll: true });
  });
  dialog.addEventListener('click', event => {
    const tab = event.target.closest('[data-detail-tab]');
    if (tab) { app.detailsTab = tab.dataset.detailTab; renderAccountDetails(); $('#accountDetailsBody').scrollTop = 0; }
  });
  dialog.addEventListener('keydown', event => {
    if (!event.target.closest('[data-detail-tab]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    app.detailsTab = event.key === 'Home' ? 'plan' : event.key === 'End' ? 'logs' : app.detailsTab === 'plan' ? 'logs' : 'plan';
    renderAccountDetails();
    $(app.detailsTab === 'logs' ? '#detailLogsTab' : '#detailPlanTab').focus();
  });
}
