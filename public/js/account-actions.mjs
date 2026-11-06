import { app, active, scheduleRender } from './state.mjs';
import { $, api, toast } from './ui.mjs';

const ACTIONS = {
  delete: { title: '删除这个账号？', button: '确认删除', description: '账号将从本机列表移除。已保存的密码、2FA 密钥、会话和会员记录保留，重新导入同一邮箱可恢复。', done: '账号已从本机列表删除' },
  disable: { title: '标记为不可用？', button: '确认标记不可用', description: '保留账号及登录资料，停止该账号的登录、改密、2FA 和会员查询任务。以后可在账号菜单中恢复使用。', done: '账号已标记为不可用' },
  restore: { title: '恢复这个账号？', button: '确认恢复使用', description: '恢复后可以再次执行登录、改密、2FA 和会员查询。此操作只恢复本机可用标记。', done: '账号已恢复使用' },
};
let pendingAction = null;

export function openAccountAction(email, action, opener) {
  const account = app.accounts.find(item => item.email === email);
  if (!ACTIONS[action] || !account || pendingAction || active(account) || !app.connected) return;
  pendingAction = { email, action, opener, saving: false };
  $('#accountActionTitle').textContent = ACTIONS[action].title;
  $('#accountActionEmail').textContent = email;
  $('#accountActionDescription').textContent = ACTIONS[action].description;
  $('#accountActionError').hidden = true;
  $('#btnConfirmAccountAction').className = `btn ${action === 'restore' ? 'primary' : 'danger'}`;
  updateAccountAction();
  $('#accountActionDialog').showModal();
  $('#btnCancelAccountAction').focus();
}

export function updateAccountAction() {
  if (!pendingAction) return;
  const { email, action, saving } = pendingAction;
  const account = app.accounts.find(item => item.email === email);
  const changed = account && action !== 'delete' && Boolean(account.unavailable) !== (action === 'restore');
  const blocked = !account ? '该账号已被移除，请关闭后刷新列表。'
    : active(account) ? '该账号正在执行或等待任务，请完成后再操作。'
    : changed ? '账号标记已变化，请关闭后重新选择操作。'
    : !app.connected ? '服务连接已断开，请连接恢复后重试。' : '';
  $('#accountActionNotice').textContent = blocked;
  $('#accountActionNotice').hidden = !blocked;
  $('#btnConfirmAccountAction').disabled = saving || Boolean(blocked);
  $('#btnConfirmAccountAction').textContent = saving ? '正在处理…' : ACTIONS[action].button;
  $('#btnCancelAccountAction').disabled = saving;
}

export function initAccountActions() {
  const dialog = $('#accountActionDialog');
  $('#btnCancelAccountAction').addEventListener('click', () => { if (!pendingAction?.saving) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (pendingAction?.saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    const previous = pendingAction;
    pendingAction = null;
    $('#accountActionEmail').textContent = '';
    const card = [...$('#cardList').children].find(node => node.dataset.email === previous?.email);
    const target = previous?.opener?.isConnected ? previous.opener : card?.querySelector('.account-menu > summary');
    (target || $('#searchInput')).focus({ preventScroll: true });
  });
  $('#accountActionForm').addEventListener('submit', async event => {
    event.preventDefault();
    updateAccountAction();
    if (!pendingAction || $('#btnConfirmAccountAction').disabled) return;
    const current = pendingAction;
    current.saving = true;
    $('#accountActionError').hidden = true;
    updateAccountAction();
    try {
      const result = await api('/api/accounts/action', { method: 'POST', body: JSON.stringify({ email: current.email, action: current.action, confirmed: true }) });
      app.accounts = result.accounts;
      if (current.action === 'delete') {
        for (const set of [app.selected, app.openLogs, app.openPlans, app.openTasks]) set.delete(current.email);
        if (!app.editorDirty) app.editorLoaded = false;
      }
      app.updated = new Date();
      dialog.close();
      toast(ACTIONS[current.action].done);
      scheduleRender();
    } catch (error) {
      current.saving = false;
      $('#accountActionError').textContent = error.message;
      $('#accountActionError').hidden = false;
      updateAccountAction();
    }
  });
}
