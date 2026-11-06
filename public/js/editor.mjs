import { app, LOGIN_METHODS, scheduleRender } from './state.mjs';
import { $, esc, api, toast, perform } from './ui.mjs';
import { navigate } from './navigation.mjs';
const EDITOR_PAGE_SIZE = 25;
const EDITOR_FIELDS = ['email', 'mailUrl', 'password', 'totpSecret'];
let nextRowKey = 0;

const rowValues = row => Object.fromEntries(EDITOR_FIELDS.map(key => [key, row[key] || '']));
function newEditorRow(row = {}) { return { ...rowValues(row), _key: ++nextRowKey }; }

export function acceptEditorSnapshot(snapshot) {
  app.editorRows = snapshot.accounts.map(newEditorRow);
  app.editorBaseline = new Map(app.editorRows.map(row => [row._key, { ...row }]));
  app.editorExpectedContent = snapshot.content ?? null;
  app.editorDirty = false;
  app.editorLoaded = true;
  app.removedEditorRow = null;
}

export function editorRowStatus(row) {
  const original = app.editorBaseline.get(row._key);
  return !original ? 'new' : EDITOR_FIELDS.some(key => (row[key] || '') !== (original[key] || '')) ? 'changed' : 'saved';
}

export function editorChangeCounts() {
  const counts = { changed: 0, added: 0, removed: 0 };
  const currentKeys = new Set(app.editorRows.map(row => row._key));
  for (const row of app.editorRows) {
    const status = editorRowStatus(row);
    if (status === 'new') counts.added++;
    if (status === 'changed') counts.changed++;
  }
  for (const key of app.editorBaseline.keys()) if (!currentKeys.has(key)) counts.removed++;
  return counts;
}

function syncEditorDirty() {
  const { changed, added, removed } = editorChangeCounts();
  app.editorDirty = Boolean(changed || added || removed);
}

export function editorPageRows() {
  const terms = app.editorSearch.trim().toLowerCase().split(/[\s,，;；]+/).filter(Boolean);
  const matches = app.editorRows.map((row, index) => ({ row, index })).filter(({ row }) => {
    const state = editorRowStatus(row);
    return (app.editorFilter === 'all' || (app.editorFilter === 'dirty' ? state !== 'saved' : state === 'new')) &&
      (!terms.length || terms.some(term => `${row.email} ${row.mailUrl}`.toLowerCase().includes(term)));
  });
  const pages = Math.max(1, Math.ceil(matches.length / EDITOR_PAGE_SIZE));
  app.editorPage = Math.max(1, Math.min(app.editorPage, pages));
  const start = (app.editorPage - 1) * EDITOR_PAGE_SIZE;
  return { items: matches.slice(start, start + EDITOR_PAGE_SIZE), total: matches.length, pages, start };
}

export function resetEditorFilters() {
  app.editorSearch = '';
  app.editorFilter = 'all';
  app.editorPage = 1;
  $('#editorSearch').value = '';
  $('#editorFilter').value = 'all';
}

export function focusEditorRow(index, field) {
  if (!app.editorRows[index]) return;
  resetEditorFilters();
  app.editorPage = Math.floor(index / EDITOR_PAGE_SIZE) + 1;
  renderEditor();
  const target = $(`#accountEditorRows [data-row="${index}"] [data-edit-row]`);
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (field) {
    openEditorRow(index, target, field);
    return $(QUICK_FIELDS[field]);
  }
  return target;
}

export function addEditorAccount() {
  openDraftEditor(newEditorRow(), $('#btnAddAccount'), true);
}

export function removeEditorAccount(index) {
  if (!app.editorRows[index]) return;
  app.removedEditorRow = { index, row: app.editorRows.splice(index, 1)[0] };
  syncEditorDirty();
  renderEditor();
  $('#btnUndoRemove').focus();
}

export function undoEditorRemove() {
  if (!app.removedEditorRow) return;
  const { index, row } = app.removedEditorRow;
  app.editorRows.splice(index, 0, row);
  app.removedEditorRow = null;
  syncEditorDirty();
  focusEditorRow(index);
}

export function discardEditorChanges() {
  app.editorRows = [...app.editorBaseline.values()].map(row => ({ ...row }));
  app.editorDirty = false;
  app.removedEditorRow = null;
  $('#accountsText').value = '';
  $('#bulkImportPanel').hidden = true;
  $('#btnBulkImport').setAttribute('aria-expanded', 'false');
  resetEditorFilters();
  $('#importError').hidden = true;
  renderEditor();
}

export function hideEditor() {
  // 返回概览不丢草稿；丢弃修改由明确的「撤销全部更改」完成。
  navigate('accounts');
}

let loadingEditor;
export async function loadEditor() {
  if (app.editorLoaded && (hasEditorDraft() || app.view === 'manage')) return;
  if (loadingEditor) return loadingEditor;
  loadingEditor = (async () => {
    const data = await api('/api/accounts-file');
    acceptEditorSnapshot(data);
    $('#importError').hidden = true;
    renderEditor();
  })();
  try { await loadingEditor; } finally { loadingEditor = null; }
}

let quickEditor = null;
let quickEditorRequest = 0;
const QUICK_FIELDS = { email: '#quickAccountEmail', mailUrl: '#quickAccountMailUrl', password: '#quickAccountPassword', totpSecret: '#quickAccountTwofa' };
const hasEditorDraft = () => app.editorDirty || Boolean($('#accountsText').value.trim());

export function editorCredentialPresence(row) {
  const existing = app.accounts.find(account => account.email === row.email.trim().toLowerCase());
  return { mailUrl: Boolean(row.mailUrl?.trim()), password: Boolean(row.password || existing?.password?.saved || existing?.password?.uncertain),
    totpSecret: Boolean(row.totpSecret?.trim() || existing?.twofa?.hasSecret || existing?.twofa?.hasImportedSecret || existing?.twofa?.hasPendingSecret) };
}

function openDraftEditor(row, trigger, isNew = false, field = 'email') {
  quickEditorRequest++;
  quickEditor = { mode: 'draft', rowKey: row._key, email: row.email, isNew, opener: trigger, saving: false };
  const presence = editorCredentialPresence(row);
  $('#quickAccountForm').reset();
  $('#quickAccountEmail').readOnly = false;
  $('#quickAccountEmail').required = true;
  $('#quickAccountTitle').textContent = isNew ? '新增账号' : '编辑账号';
  $('#quickAccountDescription').textContent = '应用到列表后，点击「保存全部更改」统一保存。';
  $('#quickAccountEmailHint').textContent = '填写用于登录的完整邮箱，保留 + 标签。';
  for (const [key, selector] of Object.entries(QUICK_FIELDS)) {
    $(selector).value = row[key] || '';
    $(selector).removeAttribute('aria-invalid');
  }
  $('#quickAccountPassword').placeholder = presence.password ? '已保存，留空保留' : '填写当前密码';
  $('#quickAccountTwofa').placeholder = presence.totpSecret ? '已保存，留空保留' : '填写 Base32 密钥';
  $('#quickAccountError').hidden = true;
  updateQuickEditorState();
  if (!$('#quickAccountDialog').open) $('#quickAccountDialog').showModal();
  $(QUICK_FIELDS[field] || QUICK_FIELDS.email).focus();
}

export function openEditorRow(index, trigger, field) {
  const row = app.editorRows[index];
  if (!row) return;
  if (row._key == null) row._key = ++nextRowKey;
  openDraftEditor(row, trigger || document.activeElement, false, field);
}

async function showFullEditor(email) {
  await navigate('manage');
  if (app.view !== 'manage') return;
  const index = app.editorRows.findIndex(row => row.email === email);
  if (index >= 0) focusEditorRow(index);
  else $('#btnAddAccount').focus();
}

export async function showEditor(email, trigger) {
  const request = ++quickEditorRequest;
  if (!email) return showFullEditor();
  if (hasEditorDraft()) {
    toast('账号管理中有未保存的草稿，已定位到该账号，请一并保存。');
    return showFullEditor(email);
  }
  const view = app.view;
  const opener = trigger || document.activeElement;
  const snapshot = await api('/api/accounts-file');
  if (request !== quickEditorRequest || app.view !== view || hasEditorDraft()) return;
  const row = snapshot.accounts.find(item => item.email === email);
  if (!row) throw new Error('该账号已被移除，请刷新账号列表。');
  const existing = app.accounts.find(item => item.email === email);
  quickEditor = { email, snapshot, opener, action: opener?.dataset?.act || 'edit',
    fromMenu: Boolean(opener?.closest('.action-menu')), saving: false };
  $('#quickAccountForm').reset();
  $('#quickAccountEmail').readOnly = true;
  $('#quickAccountEmail').required = false;
  $('#quickAccountTitle').textContent = '编辑账号';
  $('#quickAccountDescription').textContent = '仅修改此账号的本机登录资料。';
  $('#quickAccountEmailHint').textContent = '如需修改邮箱，请在账号管理页编辑。';
  $('#quickAccountEmail').value = email;
  $('#quickAccountMailUrl').value = row.mailUrl || '';
  $('#quickAccountPassword').placeholder = existing?.password?.saved ? '已保存，留空保留' : '填写当前密码';
  $('#quickAccountTwofa').placeholder = existing?.twofa?.hasSecret || row.totpSecret ? '已保存，留空保留' : '填写 Base32 密钥';
  $('#quickAccountError').hidden = true;
  updateQuickEditorState();
  $('#quickAccountDialog').showModal();
  $('#quickAccountMailUrl').focus();
}

function quickEditorValues() {
  return { email: quickEditor.mode === 'draft' ? $('#quickAccountEmail').value.trim().toLowerCase() : quickEditor.email, mailUrl: $('#quickAccountMailUrl').value,
    password: $('#quickAccountPassword').value, totpSecret: $('#quickAccountTwofa').value };
}

function updateQuickEditorState() {
  if (!quickEditor) return;
  const { saving } = quickEditor;
  const queued = app.worker.running || app.worker.queue.length || app.worker.inFlight.length;
  const draft = quickEditor.mode === 'draft';
  $('#btnSaveQuickAccount').disabled = saving || (draft ? app.busy.has('btnSaveImport') || app.busy.has('btnParseImport') : !app.connected || Boolean(queued));
  $('#btnSaveQuickAccount').textContent = saving ? '保存中…' : draft ? '应用到列表' : '保存账号';
  $('#quickAccountFields').disabled = saving;
  $('#btnCloseQuickAccount').disabled = saving;
  $('#btnCancelQuickAccount').disabled = saving;
  $('#quickAccountStatus').textContent = draft ? '应用后仍需点击列表下方的「保存全部更改」。' : queued ? '任务队列正在运行，完成后可保存。' : !app.connected ? '正在连接服务，连接后可保存。' : '仅更新此账号的本机登录资料。';
  $('#quickAccountLoginMethod').textContent = editorLoginMethod(quickEditorValues());
}

function closeQuickEditor() {
  if (!quickEditor || quickEditor.saving) return;
  $('#quickAccountDialog').close();
}

export function updateEditorState() {
  updateQuickEditorState();
  const saving = app.busy.has('btnSaveImport');
  const parsing = app.busy.has('btnParseImport');
  const queued = app.worker.running || app.worker.queue.length || app.worker.inFlight.length;
  const counts = editorChangeCounts();
  const changed = counts.changed + counts.added + counts.removed;
  const pendingImport = Boolean($('#accountsText').value.trim());
  $('#btnSaveImport').disabled = !app.connected || !app.editorLoaded || Boolean(queued) || saving || parsing || !app.editorDirty || pendingImport;
  $('#btnSaveImport').textContent = saving ? '保存中…' : '保存全部更改';
  $('#btnParseImport').disabled = !app.connected || saving || parsing || !$('#accountsText').value.trim();
  $('#btnAddAccount').disabled = saving || parsing;
  $('#btnCancelImport').disabled = saving || parsing;
  $('#btnBulkImport').disabled = saving || parsing;
  $('#btnCancelBulk').disabled = parsing;
  $('#btnUndoRemove').disabled = saving || parsing;
  $('#btnDiscardEditor').disabled = saving || parsing || (!app.editorDirty && !pendingImport);
  $('#btnDiscardEditor').hidden = !app.editorDirty && !pendingImport;
  $('#editorSearch').disabled = saving || parsing;
  $('#editorFilter').disabled = saving || parsing;
  $('#btnClearEditorSearch').disabled = saving || parsing;
  $('#btnClearEditorSearch').hidden = !app.editorSearch;
  $('#btnResetEditorFilters').disabled = saving || parsing;
  $('#accountsText').disabled = saving || parsing;
  $('#accountsForm').inert = saving || parsing;
  $('#draftCount').textContent = `共 ${app.editorRows.length} 个账号`;
  $('#draftState').textContent = pendingImport ? '导入文本待处理' : app.editorDirty ? changed ? `${changed} 个账号待保存` : '有未保存的更改' : '全部更改已保存';
  $('#draftState').classList.toggle('dirty', app.editorDirty || pendingImport);
  $('#btnCancelImport').textContent = '返回概览';
  $('#editHint').textContent = queued ? '队列正在运行，任务结束后可保存。' : !app.connected ? '正在连接服务，草稿已保留。' : pendingImport ? '请先把导入文本导入到列表，或取消导入。' : app.editorDirty
    ? `修改 ${counts.changed} · 新增 ${counts.added} · 移除 ${counts.removed}。保存会应用所有页的更改。`
    : '密码与密钥留空保留；切换页面和翻页不会丢失草稿。';
  const page = editorPageRows();
  $('#editorResultCount').textContent = `${page.total} 个匹配${page.total ? ` · 本页 ${page.start + 1}–${page.start + page.items.length}` : ''}`;
  $('#editorPagePosition').textContent = `第 ${app.editorPage} / ${page.pages} 页`;
  $('#editorPagination').hidden = page.pages <= 1;
  $('#btnEditorPrev').disabled = saving || parsing || app.editorPage <= 1;
  $('#btnEditorNext').disabled = saving || parsing || app.editorPage >= page.pages;
  // 状态来自账号元数据；实时刷新只更新「有 / 无」，不把凭据写进列表。
  for (const element of $('#accountEditorRows').querySelectorAll('[data-row]')) {
    const row = app.editorRows[Number(element.dataset.row)];
    if (!row) continue;
    const presence = editorCredentialPresence(row);
    for (const cell of element.querySelectorAll('[data-presence]')) {
      const present = presence[cell.dataset.presence];
      cell.textContent = present ? '有' : '无';
      cell.className = `presence-status ${present ? 'present' : 'missing'}`;
    }
  }
}

export function editorLoginMethod(row) {
  const existing = app.accounts.find(account => account.email === row.email.trim().toLowerCase());
  const hasTwofa = Boolean(row.totpSecret?.trim() || existing?.twofa?.hasSecret || existing?.twofa?.hasImportedSecret);
  const method = row.password || existing?.password?.saved || existing?.password?.uncertain ? (hasTwofa ? 'password-totp' : 'password')
    : row.mailUrl.trim() ? (hasTwofa ? 'email-totp' : 'email') : existing?.loginMethod === 'session' ? 'session' : 'missing';
  return LOGIN_METHODS[method];
}

export function renderEditor() {
  for (const row of app.editorRows) if (row._key == null) row._key = ++nextRowKey;
  const page = editorPageRows();
  $('#accountEditorRows').innerHTML = page.items.map(({ row, index }) => {
    const presence = editorCredentialPresence(row);
    const state = editorRowStatus(row);
    const flag = key => `<td class="manager-param"><span data-presence="${key}" class="presence-status ${presence[key] ? 'present' : 'missing'}">${presence[key] ? '有' : '无'}</span></td>`;
    return `<tr class="account-manager-row" data-row="${index}">
      <td class="manager-email-cell"><div class="manager-email-wrap"><button type="button" class="manager-email" data-edit-row="${index}" title="编辑 ${esc(row.email)}">${esc(row.email || '未填写邮箱')}</button>${state !== 'saved' ? `<span class="editor-row-state ${state}">${state === 'new' ? '新增' : '已修改'}</span>` : ''}</div></td>
      ${flag('mailUrl')}${flag('password')}${flag('totpSecret')}
      <td class="manager-actions"><button class="text-btn" type="button" data-edit-row="${index}">编辑</button><button class="text-btn remove-row" type="button" data-remove-row="${index}" aria-label="移除 ${esc(row.email || '此账号')}">移除</button></td>
    </tr>`;
  }).join('');
  $('#managerTableWrap').hidden = page.items.length === 0;
  $('#editorEmpty').hidden = page.items.length > 0;
  $('#editorEmptyTitle').textContent = app.editorRows.length ? '没有符合条件的账号' : '添加你的第一个账号';
  $('#editorEmptyText').textContent = app.editorRows.length ? '调整搜索条件，或切换回全部账号。' : '点击「新增账号」填写资料，或批量导入已有账号。';
  $('#btnResetEditorFilters').hidden = !app.editorRows.length;
  $('#editorUndo').hidden = !app.removedEditorRow;
  $('#editorUndoText').textContent = app.removedEditorRow ? `已移除 ${app.removedEditorRow.row.email || '未填写邮箱的账号'}，保存后生效。` : '';
  updateEditorState();
  scheduleRender();
}

export function mergeEditorRows(current, imported) {
  const rows = current.filter(row => row.email.trim() || row.mailUrl.trim() || row.password || row.totpSecret.trim()).map(row => ({ ...row }));
  for (const row of imported) {
    const index = rows.findIndex(item => item.email.trim().toLowerCase() === row.email.toLowerCase());
    if (index < 0) rows.push({ ...row, password: row.password || '', totpSecret: row.totpSecret || '' });
    else rows[index] = { ...rows[index], ...row };
  }
  return rows;
}

export function editorError(error, importing = false) {
  $('#accountsForm').inert = false;
  $('#accountsText').disabled = false;
  $('#importError').textContent = error.message;
  $('#importError').hidden = false;
  if (importing && !$('#bulkImportPanel').hidden) {
    $('#accountsText').setAttribute('aria-invalid', 'true');
    $('#accountsText').focus();
  } else {
    const index = Number(error.message.match(/第 (\d+) 行/)?.[1]) - 1;
    const field = /2FA|Base32/.test(error.message) ? 'totpSecret' : /密码/.test(error.message) ? 'password' : /取件|URL/.test(error.message) ? 'mailUrl' : 'email';
    const input = focusEditorRow(index, field);
    if (input) {
      input.setAttribute('aria-invalid', 'true'); input.focus();
      $('#quickAccountError').textContent = error.message;
      $('#quickAccountError').hidden = false;
    }
    else { $('#importError').focus(); $('#importError').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }
}

export function updateEditorRow(index, field, value) {
  const row = app.editorRows[index];
  if (!row || !EDITOR_FIELDS.includes(field)) return;
  row[field] = value;
  syncEditorDirty();
  updateEditorState();
  scheduleRender();
}


export function initEditor({ refresh }) {
  $('#btnCloseQuickAccount').addEventListener('click', closeQuickEditor);
  $('#btnCancelQuickAccount').addEventListener('click', closeQuickEditor);
  $('#quickAccountDialog').addEventListener('cancel', event => {
    if (quickEditor?.saving) event.preventDefault();
  });
  $('#quickAccountDialog').addEventListener('close', () => {
    const { opener, email, action, fromMenu, mode, rowKey } = quickEditor || {};
    quickEditor = null;
    quickEditorRequest++;
    $('#quickAccountForm').reset();
    if (mode === 'draft') {
      const index = app.editorRows.findIndex(row => row._key === rowKey);
      const target = opener?.isConnected ? opener : index < 0 ? $('#btnAddAccount') : $(`#accountEditorRows [data-row="${index}"] [data-edit-row]`);
      (target || $('#editorSearch')).focus({ preventScroll: true });
      return;
    }
    let target = opener?.closest('.action-menu')?.querySelector('summary') || opener;
    if (!target?.isConnected) {
      const card = [...$('#cardList').children].find(node => node.dataset.email === email);
      target = (fromMenu ? card?.querySelector('.account-menu > summary') : card?.querySelector(`.card-footer [data-act="${action}"]`))
        || card?.querySelector('.card-footer [data-act="edit"]') || $('#searchInput');
    }
    target?.focus({ preventScroll: true });
  });
  $('#quickAccountForm').addEventListener('input', () => {
    $('#quickAccountError').hidden = true;
    updateQuickEditorState();
  });
  $('#quickAccountForm').addEventListener('submit', async event => {
    event.preventDefault();
    updateQuickEditorState();
    if (!quickEditor || $('#btnSaveQuickAccount').disabled) return;
    if (quickEditor.mode === 'draft') {
      try {
        const values = quickEditorValues();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) throw new Error('请填写有效的邮箱');
        if (app.editorRows.some(row => row._key !== quickEditor.rowKey && row.email.trim().toLowerCase() === values.email)) throw new Error('此邮箱已在列表中，请编辑已有账号');
        let index = app.editorRows.findIndex(row => row._key === quickEditor.rowKey);
        if (quickEditor.isNew) { app.editorRows.unshift({ ...values, _key: quickEditor.rowKey }); index = 0; }
        else {
          if (index < 0) throw new Error('账号已从列表移除，请关闭后重新选择');
          Object.assign(app.editorRows[index], values);
        }
        syncEditorDirty();
        $('#importError').hidden = true;
        closeQuickEditor();
        focusEditorRow(index);
        toast('已应用到列表，点击「保存全部更改」完成保存');
      } catch (error) {
        $('#quickAccountError').textContent = error.message;
        $('#quickAccountError').hidden = false;
      }
      return;
    }
    quickEditor.saving = true;
    updateQuickEditorState();
    try {
      if (hasEditorDraft()) throw new Error('账号管理中有未保存的草稿，请先关闭此编辑窗口并保存或放弃批量草稿，再重新编辑。');
      const latest = await api('/api/accounts-file');
      if (hasEditorDraft()) throw new Error('账号管理中有未保存的草稿，请先关闭此编辑窗口并保存或放弃批量草稿，再重新编辑。');
      if (latest.content !== quickEditor.snapshot.content) throw new Error('账号资料已被其他操作更新。请先复制当前修改，再关闭并重新打开此账号，避免覆盖最新资料。');
      const values = quickEditorValues();
      const accounts = latest.accounts.map(row => row.email === values.email
        ? { ...row, ...values, totpSecret: values.totpSecret || row.totpSecret || '' } : row);
      await api('/api/accounts-file', { method: 'POST', body: JSON.stringify({ accounts, expectedContent: latest.content }) });
      app.editorLoaded = false;
      quickEditor.saving = false;
      closeQuickEditor();
      toast('账号资料已保存');
      await refresh().catch(() => toast('账号已保存，列表同步失败，请刷新页面。', true));
    } catch (error) {
      $('#quickAccountError').textContent = error.message;
      $('#quickAccountError').hidden = false;
      $('#quickAccountError').focus();
    } finally {
      if (quickEditor) quickEditor.saving = false;
      updateQuickEditorState();
    }
  });
  $('#accountsForm').addEventListener('input', scheduleRender);
  $('#btnCancelImport').addEventListener('click', hideEditor);
  $('#btnDiscardEditor').addEventListener('click', discardEditorChanges);
  $('#editorSearch').addEventListener('input', event => { app.editorSearch = event.target.value; app.editorPage = 1; renderEditor(); });
  $('#editorFilter').addEventListener('change', event => { app.editorFilter = event.target.value; app.editorPage = 1; renderEditor(); });
  $('#btnClearEditorSearch').addEventListener('click', () => { app.editorSearch = ''; $('#editorSearch').value = ''; app.editorPage = 1; renderEditor(); $('#editorSearch').focus(); });
  $('#btnResetEditorFilters').addEventListener('click', () => { resetEditorFilters(); renderEditor(); $('#editorSearch').focus(); });
  for (const [id, direction] of [['btnEditorPrev', -1], ['btnEditorNext', 1]]) {
    $('#' + id).addEventListener('click', () => {
      app.editorPage += direction;
      renderEditor();
      $('#editorControls').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  $('#accountsText').addEventListener('input', () => { $('#accountsText').removeAttribute('aria-invalid'); $('#importError').hidden = true; updateEditorState(); scheduleRender(); });
  $('#btnBulkImport').addEventListener('click', () => {
    $('#bulkImportPanel').hidden = !$('#bulkImportPanel').hidden;
    $('#btnBulkImport').setAttribute('aria-expanded', String(!$('#bulkImportPanel').hidden));
    if (!$('#bulkImportPanel').hidden) $('#accountsText').focus();
    updateEditorState();
  });
  $('#btnCancelBulk').addEventListener('click', () => { $('#bulkImportPanel').hidden = true; $('#btnBulkImport').setAttribute('aria-expanded', 'false'); $('#accountsText').value = ''; $('#importError').hidden = true; updateEditorState(); });
  $('#btnParseImport').addEventListener('click', event => perform(event.currentTarget, async () => {
    updateEditorState();
    try {
      const { accounts: imported } = await api('/api/accounts/parse', { method: 'POST', body: JSON.stringify({ content: $('#accountsText').value }) });
      if (!imported.length) throw new Error('没有识别到账号，请填写邮箱与取件地址');
      app.editorRows = mergeEditorRows(app.editorRows, imported).map(row => row._key == null ? newEditorRow(row) : row);
      syncEditorDirty();
      app.removedEditorRow = null;
      $('#accountsText').value = '';
      $('#bulkImportPanel').hidden = true;
      $('#btnBulkImport').setAttribute('aria-expanded', 'false');
      $('#importError').hidden = true;
      resetEditorFilters();
      const index = app.editorRows.findIndex(row => row.email.toLowerCase() === imported[0].email.toLowerCase());
      focusEditorRow(index);
      toast(`已导入 ${imported.length} 个账号到列表，检查后保存更改`);
    } catch (error) { editorError(error, true); }
  }));
  $('#btnAddAccount').addEventListener('click', addEditorAccount);
  $('#accountEditorRows').addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-row]');
    if (edit) { openEditorRow(Number(edit.dataset.editRow), edit); return; }
    const button = event.target.closest('[data-remove-row]');
    if (!button) return;
    const index = Number(button.dataset.removeRow);
    removeEditorAccount(index);
  });
  $('#btnUndoRemove').addEventListener('click', undoEditorRemove);
  $('#accountsForm').addEventListener('submit', event => {
    event.preventDefault();
    if ($('#btnSaveImport').disabled) return;
    perform($('#btnSaveImport'), async () => {
      updateEditorState();
      let savedToDisk = false;
      try {
        const { count } = await api('/api/accounts-file', { method: 'POST', body: JSON.stringify({ accounts: app.editorRows.map(rowValues),
          ...(typeof app.editorExpectedContent === 'string' ? { expectedContent: app.editorExpectedContent } : {}) }) });
        savedToDisk = true;
        // 保存后的新快照移除输入过的秘密，重新建立逐行比较基线。
        const saved = await api('/api/accounts-file');
        acceptEditorSnapshot(saved);
        if (app.editorFilter !== 'all') { app.editorFilter = 'all'; $('#editorFilter').value = 'all'; }
        $('#importError').hidden = true;
        renderEditor();
        await refresh().catch(() => toast('更改已保存，列表同步失败，请刷新。', true));
        toast(`已保存全部 ${count} 个账号`);
      } catch (error) {
        if (savedToDisk) {
          acceptEditorSnapshot({ accounts: app.editorRows.map(({ email, mailUrl }) => ({ email, mailUrl })) });
          app.editorLoaded = false;
          renderEditor();
          editorError(new Error('更改已保存，但重新读取资料失败。请返回概览后重新打开账号管理。'));
        } else editorError(error);
      }
    });
  });

}
