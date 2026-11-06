import { app, STATUS_TEXT, status, scheduleRender } from './state.mjs';
import { $, api, toast, perform, esc, logClass } from './ui.mjs';
const OPERATION_NAMES = { login: '登录账号', password: '设置密码', 'password-verify': '验证密码', twofa: '开通 2FA', 'twofa-replace': '修改 2FA', 'twofa-verify': '验证 2FA', plan: '读取套餐', setup: '初始化密码与 2FA', 'setup-password': '初始化密码', 'setup-twofa': '开通 2FA' };

export function taskRecordHTML(account) {
  const state = status(account);
  const logs = account.logs || [];
  return `<details class="task-record" data-task="${esc(account.email)}" ${app.openTasks.has(account.email) ? 'open' : ''}>
    <summary><span class="task-identity"><strong>${esc(account.email)}</strong><span>${esc(account.stage || OPERATION_NAMES[account.operation] || '账号任务')}</span></span><span class="badge ${state}">${esc(STATUS_TEXT[state])}</span><span class="task-log-label">日志 · ${logs.length}</span></summary>
    <div class="log-output" tabindex="0" aria-label="${esc(account.email)} 的任务日志">${logs.length ? logs.map(line => `<div class="log-line ${logClass(line)}">${esc(line)}</div>`).join('') : '等待任务产生运行记录'}</div>
  </details>`;
}

export function renderTasks() {
  const { queue, inFlight, running } = app.worker;
  $('#queueDot').className = `status-dot${running ? ' running' : ''}`;
  $('#queueText').textContent = inFlight.length ? '正在执行账号任务' : running ? '准备下一项任务' : '队列空闲';
  $('#queueCount').hidden = !queue.length;
  $('#queueCount').textContent = `${queue.length} 项等待`;
  $('#btnClearQueue').hidden = !queue.length;
  $('#btnClearQueue').disabled = app.busy.has('btnClearQueue') || !app.connected;
  $('#runningTaskCount').textContent = inFlight.length;
  $('#waitingTaskCount').textContent = queue.length;
  const current = inFlight.map(email => app.accounts.find(account => account.email === email)).filter(Boolean);
  const records = app.accounts.filter(account => account.logs?.length && !inFlight.includes(account.email) && !queue.includes(account.email));
  $('#taskRecordCount').textContent = records.length;
  const update = (id, html) => {
    const container = $(id);
    if (container._html === html) return;
    const scroll = new Map([...container.querySelectorAll('[data-task]')].map(node => {
      const output = node.querySelector('.log-output');
      return [node.dataset.task, { top: output.scrollTop, bottom: output.scrollHeight - output.scrollTop - output.clientHeight < 30 }];
    }));
    container.innerHTML = html;
    container._html = html;
    for (const node of container.querySelectorAll('[data-task]')) {
      const output = node.querySelector('.log-output');
      const previous = scroll.get(node.dataset.task);
      output.scrollTop = !previous || previous.bottom ? output.scrollHeight : previous.top;
    }
  };
  update('#currentTasks', current.length ? current.map(taskRecordHTML).join('') : '<div class="task-empty"><strong>当前没有进行中的任务</strong><p>在账号概览中选择单个账号或批量操作，任务会在这里显示。</p><a href="#accounts" data-nav="accounts">前往账号概览 →</a></div>');
  update('#waitingTasks', queue.length ? `<ol class="waiting-list">${queue.map((email, index) => `<li><span class="queue-index">${String(index + 1).padStart(2, '0')}</span><span>${esc(email)}</span><span class="task-operation">${esc(OPERATION_NAMES[app.accounts.find(account => account.email === email)?.operation] || '账号任务')}</span></li>`).join('')}</ol>` : '<p class="task-empty-note">没有等待中的任务</p>');
  update('#taskRecords', records.length ? records.map(taskRecordHTML).join('') : '<p class="task-empty-note">本次运行记录会保留在这里，点击账号可展开日志。</p>');
  $('#taskActivity').hidden = !running && !queue.length;
  $('#taskActivityText').textContent = inFlight.length ? `正在处理 ${inFlight.length} 个账号 · ${queue.length} 项等待` : `${queue.length} 项任务等待执行`;
}
export async function queueEmails(emails) {
  const result = await api('/api/login-batch', { method: 'POST', body: JSON.stringify({ emails }) });
  toast(result.queued ? `已加入 ${result.queued} 个登录任务` : '所选账号已在队列中');
}

export async function queuePlans(emails) {
  if (!emails.length) { toast('没有可查询的账号'); return; }
  const result = await api('/api/plans/refresh', { method: 'POST', body: JSON.stringify({ emails }) });
  const skipped = emails.length - result.queued;
  toast(result.queued ? `已加入 ${result.queued} 个会员权益查询任务${skipped ? `，${skipped} 个账号已有任务` : ''}` : '所选账号已在队列中');
}

export async function queueSetup(emails, mode = 'all') {
  const result = await api('/api/accounts/setup', { method: 'POST', body: JSON.stringify({ emails, mode }) });
  const label = mode === 'password' ? '密码初始化' : mode === 'twofa' ? '2FA 开通' : '密码与 2FA 初始化';
  toast(result.queued ? `已加入 ${result.queued} 个${label}任务${result.skipped ? `，跳过 ${result.skipped} 个已完成或执行中的账号` : ''}` : '所选账号已完成或已有任务正在执行');
}


export function initTasks() {
    $('#tasksView').addEventListener('toggle', event => {
      const record = event.target.closest('[data-task]');
      if (!record) return;
      if (record.open) app.openTasks.add(record.dataset.task); else app.openTasks.delete(record.dataset.task);
      scheduleRender();
    }, true);
  $('#btnClearQueue').addEventListener('click', event => perform(event.currentTarget, async () => {
    const { cleared } = await api('/api/queue/clear', { method: 'POST', body: '{}' });
    toast(`已移除 ${cleared} 个等待任务，当前账号继续执行`);
  }));

}
