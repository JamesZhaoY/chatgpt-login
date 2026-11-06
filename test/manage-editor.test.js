const { test } = require('node:test');
const assert = require('node:assert/strict');
const { frontend } = require('./helpers/frontend');

const rows = (count = 55) => Array.from({ length: count }, (_, index) => ({ email: `person-${index}+1@example.test`, mailUrl: `https://mail.example.test/${index}` }));
const snapshot = (accounts = rows()) => ({ accounts, content: accounts.map(row => `${row.email}----${row.mailUrl}`).join('\n') });

test('管理页每页 25 行，仅渲染邮箱和配置状态，搜索保留原始行号', async () => {
  const { context, elements } = await frontend();
  context.acceptEditorSnapshot(snapshot());
  context.renderEditor();
  let html = elements.get('#accountEditorRows').innerHTML;
  assert.equal((html.match(/data-row="/g) || []).length, 25);
  assert.doesNotMatch(html, /<input|type="password"/);
  context.app.editorPage = 3;
  context.renderEditor();
  html = elements.get('#accountEditorRows').innerHTML;
  assert.match(html, /data-row="50"/); assert.equal((html.match(/data-row="/g) || []).length, 5);
  assert.equal(elements.get('#editorPagePosition').textContent, '第 3 / 3 页');
  context.app.editorSearch = 'PERSON-14+1@example.test'; context.app.editorPage = 1;
  assert.deepEqual(context.editorPageRows().items.map(item => item.index), [14]);
  context.app.editorSearch = 'person-14+2@example.test';
  context.renderEditor();
  assert.equal(context.editorPageRows().total, 0);
  assert.equal(elements.get('#editorEmptyTitle').textContent, '没有符合条件的账号');
});

test('跨页编辑保留密码与密钥；待保存筛选准确，恢复原值即取消改动标记', async () => {
  const { context, elements } = await frontend();
  context.acceptEditorSnapshot(snapshot());
  context.app.connected = true;
  context.updateEditorRow(8, 'password', 'Fixture-only-secret');
  context.updateEditorRow(8, 'totpSecret', 'BH4OWU3OMXPJ7P63');
  assert.equal(context.app.editorDirty, true);
  assert.deepEqual(context.editorChangeCounts(), { changed: 1, added: 0, removed: 0 });
  context.app.editorPage = 1; context.renderEditor();
  assert.ok(!elements.get('#accountEditorRows').innerHTML.includes('Fixture-only-secret'));
  context.app.editorPage = 2; context.renderEditor();
  assert.ok(!elements.get('#accountEditorRows').innerHTML.includes('Fixture-only-secret'));
  assert.equal(context.app.editorRows[8].password, 'Fixture-only-secret');
  context.app.editorFilter = 'dirty';
  assert.deepEqual(context.editorPageRows().items.map(item => item.index), [8]);
  context.updateEditorRow(8, 'password', ''); context.updateEditorRow(8, 'totpSecret', '');
  assert.equal(context.app.editorDirty, false);
  assert.equal(context.editorPageRows().total, 0);
  assert.equal(elements.get('#btnSaveImport').disabled, true);
});

test('新增应用后定位第一页；删除、撤销、撤销全部保留原行身份和其他编辑', async () => {
  const { context, elements } = await frontend();
  const original = snapshot();
  context.acceptEditorSnapshot(original);
  context.updateEditorRow(8, 'mailUrl', 'https://mail.example.test/changed');
  context.app.editorPage = 3; context.app.editorSearch = 'no-match'; context.app.editorFilter = 'dirty';
  context.initEditor({ refresh: async () => {} });
  context.addEditorAccount();
  elements.get('#quickAccountEmail').value = 'new@example.test';
  await elements.get('#quickAccountForm').handlers.submit[0]({ preventDefault() {} });
  assert.equal(context.app.editorPage, 1); assert.equal(context.app.editorSearch, '');
  assert.equal(context.app.editorRows[0].email, 'new@example.test');
  assert.deepEqual(context.editorChangeCounts(), { changed: 1, added: 1, removed: 0 });
  context.removeEditorAccount(0);
  assert.deepEqual(context.editorChangeCounts(), { changed: 1, added: 0, removed: 0 });
  context.removeEditorAccount(7);
  assert.deepEqual(context.editorChangeCounts(), { changed: 1, added: 0, removed: 1 });
  context.undoEditorRemove();
  assert.equal(context.app.editorRows[8].mailUrl, 'https://mail.example.test/changed');
  assert.deepEqual(context.editorChangeCounts(), { changed: 1, added: 0, removed: 0 });
  elements.get('#accountsText').value = 'pending import fixture';
  context.discardEditorChanges();
  assert.deepEqual(context.app.editorRows.map(({ email, mailUrl }) => ({ email, mailUrl })), original.accounts);
  assert.equal(context.app.editorDirty, false); assert.equal(elements.get('#accountsText').value, '');
});

test('错误在隐藏页面时自动清筛选定位原始行；搜索不会匹配秘密字段', async () => {
  const { context, elements } = await frontend();
  context.acceptEditorSnapshot(snapshot());
  context.updateEditorRow(52, 'password', 'FixturePrivateValue');
  context.app.editorSearch = 'FixturePrivateValue';
  assert.equal(context.editorPageRows().total, 0);
  context.editorError(new Error('第 53 行：2FA 密钥不是有效的 Base32 格式'));
  assert.equal(context.app.editorPage, 3);
  assert.equal(context.app.editorSearch, '');
  assert.equal(elements.get('#quickAccountTwofa').attributes['aria-invalid'], 'true');
  assert.match(elements.get('#accountEditorRows').innerHTML, /data-row="52"/);
  assert.equal(elements.get('#quickAccountDialog').open, true);
});

test('分页及筛选后保存仍提交完整列表和版本信息，成功后清空秘密输入与改动状态', async t => {
  const { context, elements } = await frontend();
  const original = snapshot();
  context.acceptEditorSnapshot(original);
  context.initEditor({ refresh: async () => {} });
  context.app.connected = true;
  context.updateEditorRow(1, 'mailUrl', 'https://mail.example.test/new');
  context.updateEditorRow(12, 'password', 'Fixture-only-secret');
  context.app.editorSearch = 'person-1+1@'; context.renderEditor();
  assert.equal(context.editorPageRows().total, 1);
  let payload;
  t.mock.method(global, 'fetch', async (route, options = {}) => {
    assert.equal(route, '/api/accounts-file');
    if (options.method === 'POST') {
      payload = JSON.parse(options.body);
      return { ok: true, json: async () => ({ count: payload.accounts.length }) };
    }
    return { ok: true, json: async () => snapshot(payload.accounts.map(({ email, mailUrl }) => ({ email, mailUrl }))) };
  });
  const button = elements.get('#btnSaveImport'); button.id = 'btnSaveImport';
  elements.get('#accountsForm').handlers.submit[0]({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(payload.accounts.length, 55);
  assert.equal(payload.accounts[12].password, 'Fixture-only-secret');
  assert.equal(payload.accounts[1].mailUrl, 'https://mail.example.test/new');
  assert.equal(payload.expectedContent, original.content);
  assert.ok(payload.accounts.every(row => !Object.hasOwn(row, '_key')));
  assert.equal(context.app.editorRows[12].password, '');
  assert.equal(context.app.editorDirty, false);
});

test('保存冲突时保留所有页的草稿；未处理的导入文本与排队任务都会阻止保存', async t => {
  const { context, elements } = await frontend();
  context.acceptEditorSnapshot(snapshot());
  context.initEditor({ refresh: async () => {} });
  context.app.connected = true;
  context.updateEditorRow(13, 'password', 'Fixture-draft');
  context.app.worker.queue.push('queued@example.test'); context.updateEditorState();
  assert.equal(elements.get('#btnSaveImport').disabled, true);
  context.app.worker.queue = [];
  elements.get('#accountsText').value = 'not parsed'; context.updateEditorState();
  assert.equal(elements.get('#btnSaveImport').disabled, true);
  assert.equal(elements.get('#draftState').textContent, '导入文本待处理');
  elements.get('#accountsText').value = ''; context.updateEditorState();
  t.mock.method(global, 'fetch', async () => ({ ok: false, json: async () => ({ error: '账号资料已在其他页面更新' }) }));
  elements.get('#btnSaveImport').id = 'btnSaveImport';
  elements.get('#accountsForm').handlers.submit[0]({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.app.editorRows[13].password, 'Fixture-draft');
  assert.equal(context.app.editorDirty, true);
  assert.match(elements.get('#importError').textContent, /其他页面更新/);
});

test('写入成功而重新读取失败时明确报告已保存，清除秘密输入并阻止用旧快照再次提交', async t => {
  const { context, elements } = await frontend();
  context.acceptEditorSnapshot(snapshot());
  context.initEditor({ refresh: async () => {} });
  context.app.connected = true;
  context.updateEditorRow(12, 'password', 'Fixture-private-input');
  t.mock.method(global, 'fetch', async (route, options = {}) => {
    if (options.method === 'POST') return { ok: true, json: async () => ({ count: 55 }) };
    throw new Error('fixture disconnected');
  });
  elements.get('#btnSaveImport').id = 'btnSaveImport';
  elements.get('#accountsForm').handlers.submit[0]({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  context.updateEditorState();
  assert.match(elements.get('#importError').textContent, /更改已保存/);
  assert.equal(context.app.editorRows[12].password, '');
  assert.equal(context.app.editorLoaded, false);
  assert.equal(elements.get('#btnSaveImport').disabled, true);
});

test('列表状态合并本机已有凭据和未保存资料，但不输出取件地址、密码或密钥', async () => {
  const { context, elements } = await frontend();
  context.app.accounts = [
    { email: 'saved@example.test', password: { saved: true }, twofa: { hasSecret: true } },
    { email: 'empty@example.test', password: { saved: false }, twofa: { hasSecret: false } },
  ];
  context.acceptEditorSnapshot(snapshot([{ email: 'saved@example.test', mailUrl: 'https://mail.example.test/private-mail-token' }, { email: 'empty@example.test', mailUrl: '' }]));
  context.updateEditorRow(1, 'password', 'private-draft-password');
  context.updateEditorRow(1, 'totpSecret', 'BH4OWU3OMXPJ7P63');
  context.renderEditor();
  assert.deepEqual(context.editorCredentialPresence(context.app.editorRows[0]), { mailUrl: true, password: true, totpSecret: true });
  assert.deepEqual(context.editorCredentialPresence(context.app.editorRows[1]), { mailUrl: false, password: true, totpSecret: true });
  const html = elements.get('#accountEditorRows').innerHTML;
  for (const secret of ['private-mail-token', 'private-draft-password', 'BH4OWU3OMXPJ7P63']) assert.ok(!html.includes(secret));
  assert.match(html, /<tr /); assert.doesNotMatch(html, /<input|<article/);
});

test('列表编辑在抽屉里应用到草稿，取消不会修改原行；新增取消不会留下空账号', async () => {
  const { context, elements } = await frontend();
  context.acceptEditorSnapshot(snapshot());
  context.initEditor({ refresh: async () => {} });
  const before = structuredClone(context.app.editorRows);
  context.openEditorRow(1);
  assert.equal(elements.get('#quickAccountDialog').open, true);
  assert.equal(elements.get('#quickAccountEmail').readOnly, false);
  elements.get('#quickAccountPassword').value = 'do-not-apply';
  elements.get('#btnCancelQuickAccount').handlers.click[0]();
  assert.deepEqual(context.app.editorRows, before);
  assert.equal(context.app.editorDirty, false);
  context.addEditorAccount();
  elements.get('#btnCancelQuickAccount').handlers.click[0]();
  assert.equal(context.app.editorRows.length, before.length);
  context.openEditorRow(1);
  elements.get('#quickAccountEmail').value = context.app.editorRows[0].email;
  await elements.get('#quickAccountForm').handlers.submit[0]({ preventDefault() {} });
  assert.match(elements.get('#quickAccountError').textContent, /已在列表中/);
  assert.deepEqual(context.app.editorRows, before);
  elements.get('#quickAccountEmail').value = 'renamed+1@example.test';
  elements.get('#quickAccountPassword').value = 'draft-only';
  await elements.get('#quickAccountForm').handlers.submit[0]({ preventDefault() {} });
  assert.equal(context.app.editorRows[1].email, 'renamed+1@example.test');
  assert.equal(context.app.editorRows[1].password, 'draft-only');
  assert.equal(context.app.editorDirty, true);
  assert.equal(elements.get('#quickAccountDialog').open, false);
});
