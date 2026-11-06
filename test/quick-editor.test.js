const { test } = require('node:test');
const assert = require('node:assert/strict');
const { frontend } = require('./helpers/frontend');

async function fixture(t) {
  const env = await frontend();
  const { context, document } = env;
  const get = id => document.querySelector('#' + id);
  const fire = async (id, type) => {
    const event = { preventDefault() {}, currentTarget: get(id) };
    for (const handler of get(id).handlers[type] || []) await handler(event);
  };
  const snapshot = { content: 'fixture-v1', accounts: [
    { email: 'one@example.test', mailUrl: 'https://mail.example.test/one' },
    { email: 'two@example.test', mailUrl: 'https://mail.example.test/two', totpSecret: 'BH4OWU3OMXPJ7P63' },
  ] };
  const posts = [];
  let reads = 0, refreshes = 0, failSave = false, restoredFocus = false, nextReadDelay;
  document.activeElement = { isConnected: true, closest: () => null, focus() { restoredFocus = true; } };
  get('quickAccountForm').reset = () => {
    for (const id of ['quickAccountEmail', 'quickAccountMailUrl', 'quickAccountPassword', 'quickAccountTwofa']) get(id).value = '';
  };
  get('quickAccountDialog').showModal = () => { get('quickAccountDialog').open = true; };
  get('quickAccountDialog').close = () => {
    get('quickAccountDialog').open = false;
    for (const handler of get('quickAccountDialog').handlers.close || []) handler();
  };
  t.mock.method(global, 'fetch', async (route, options = {}) => {
    assert.equal(route, '/api/accounts-file');
    if (options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return { ok: !failSave, json: async () => failSave ? { error: '测试：保存失败' } : { ok: true, count: 2 } };
    }
    reads++;
    const delay = nextReadDelay;
    nextReadDelay = null;
    if (delay) await delay;
    return { ok: true, json: async () => structuredClone(snapshot) };
  });
  Object.assign(context.app, { connected: true, accounts: snapshot.accounts.map(row => ({ ...row, password: { saved: true }, twofa: { hasSecret: true } })) });
  context.initEditor({ refresh: async () => { refreshes++; } });
  t.after(() => { get('quickAccountDialog').close(); });
  return { ...env, get, fire, snapshot, posts, stats: () => ({ reads, refreshes, restoredFocus }), failSave: () => { failSave = true; },
    delayNextRead() { let release; nextReadDelay = new Promise(resolve => { release = resolve; }); return release; } };
}

test('单账号快速编辑 fresh读取，不切换页面、不回填秘密；仅更新目标，携带并发保护版本', async t => {
  const f = await fixture(t);
  await f.context.showEditor('one@example.test');
  assert.equal(f.context.app.view, 'accounts');
  assert.equal(f.get('quickAccountDialog').open, true);
  assert.equal(f.get('quickAccountEmail').value, 'one@example.test');
  assert.equal(f.get('quickAccountPassword').value, '');
  assert.equal(f.get('quickAccountTwofa').value, '');
  f.get('quickAccountMailUrl').value = 'https://mail.example.test/new';
  f.get('quickAccountPassword').value = 'fixture-password';
  f.context.updateEditorState();
  assert.equal(f.get('quickAccountPassword').value, 'fixture-password');
  await f.fire('quickAccountForm', 'submit');
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].expectedContent, 'fixture-v1');
  assert.deepEqual(f.posts[0].accounts[1], f.snapshot.accounts[1]);
  assert.equal(f.posts[0].accounts[0].password, 'fixture-password');
  assert.equal(f.posts[0].accounts[0].mailUrl, 'https://mail.example.test/new');
  assert.equal(f.get('quickAccountDialog').open, false);
  assert.equal(f.get('quickAccountPassword').value, '');
  assert.deepEqual(f.stats(), { reads: 2, refreshes: 1, restoredFocus: true });
});

test('账号数据有并发变化时拒绝覆盖并保留输入；取消不保存', async t => {
  const f = await fixture(t);
  await f.context.showEditor('one@example.test');
  f.get('quickAccountPassword').value = 'keep-unsubmitted-input';
  f.snapshot.content = 'fixture-v2';
  await f.fire('quickAccountForm', 'submit');
  assert.equal(f.posts.length, 0);
  assert.match(f.get('quickAccountError').textContent, /其他操作更新/);
  assert.equal(f.get('quickAccountDialog').open, true);
  assert.equal(f.get('quickAccountPassword').value, 'keep-unsubmitted-input');
  await f.fire('btnCancelQuickAccount', 'click');
  assert.equal(f.posts.length, 0);
  assert.equal(f.get('quickAccountPassword').value, '');
});

test('队列等待时禁止保存；接口失败保留快速编辑资料', async t => {
  const f = await fixture(t);
  await f.context.showEditor('one@example.test');
  f.context.app.worker.queue.push('two@example.test');
  f.context.updateEditorState();
  assert.equal(f.get('btnSaveQuickAccount').disabled, true);
  await f.fire('quickAccountForm', 'submit');
  assert.equal(f.posts.length, 0);
  f.context.app.worker.queue = [];
  f.get('quickAccountMailUrl').value = 'https://mail.example.test/unsaved';
  f.failSave();
  await f.fire('quickAccountForm', 'submit');
  assert.equal(f.get('quickAccountMailUrl').value, 'https://mail.example.test/unsaved');
  assert.equal(f.get('quickAccountDialog').open, true);
  assert.match(f.get('quickAccountError').textContent, /保存失败/);
  assert.equal(f.get('btnSaveQuickAccount').disabled, false);
});

test('已有批量草稿时回到管理页定位，不读取或覆盖草稿', async t => {
  const f = await fixture(t);
  global.window = { location: { hash: '#accounts' }, history: { pushState() {} } };
  f.context.app.editorLoaded = true;
  f.context.app.editorDirty = true;
  f.context.app.editorRows = [{ email: 'one@example.test', mailUrl: '', password: 'unsaved-bulk-draft' }];
  await f.context.showEditor('one@example.test');
  assert.equal(f.context.app.view, 'manage');
  assert.equal(f.stats().reads, 0);
  assert.equal(f.context.app.editorRows[0].password, 'unsaved-bulk-draft');
  assert.equal(f.get('quickAccountDialog').open, undefined);
});

test('慢请求返回后重新检查页面和批量草稿，不弹出过时的编辑窗口', async t => {
  const f = await fixture(t);
  let release = f.delayNextRead();
  let opening = f.context.showEditor('one@example.test');
  f.context.app.view = 'manage';
  release();
  await opening;
  assert.equal(f.get('quickAccountDialog').open, undefined);
  f.context.app.view = 'accounts';
  release = f.delayNextRead();
  opening = f.context.showEditor('one@example.test');
  f.context.app.editorDirty = true;
  f.context.app.editorRows = [{ email: 'draft@example.test', password: 'bulk-draft' }];
  release();
  await opening;
  assert.equal(f.get('quickAccountDialog').open, undefined);
  assert.equal(f.context.app.editorRows[0].password, 'bulk-draft');
});

test('后发的编辑请求优先，慢请求不能覆盖已打开的账号', async t => {
  const f = await fixture(t);
  const release = f.delayNextRead();
  const first = f.context.showEditor('one@example.test');
  await f.context.showEditor('two@example.test');
  f.get('quickAccountMailUrl').value = 'https://mail.example.test/draft';
  release();
  await first;
  assert.equal(f.get('quickAccountEmail').value, 'two@example.test');
  assert.equal(f.get('quickAccountMailUrl').value, 'https://mail.example.test/draft');
});

test('保存前及保存读取过程中出现批量草稿时均拦截，不丢失两边输入', async t => {
  const f = await fixture(t);
  await f.context.showEditor('one@example.test');
  f.get('quickAccountPassword').value = 'quick-draft';
  f.context.app.editorDirty = true;
  await f.fire('quickAccountForm', 'submit');
  assert.equal(f.stats().reads, 1);
  assert.equal(f.posts.length, 0);
  assert.match(f.get('quickAccountError').textContent, /未保存的草稿/);
  f.context.app.editorDirty = false;
  const release = f.delayNextRead();
  const saving = f.fire('quickAccountForm', 'submit');
  f.get('accountsText').value = 'bulk@example.test----https://mail.example.test/';
  release();
  await saving;
  assert.equal(f.posts.length, 0);
  assert.equal(f.get('quickAccountPassword').value, 'quick-draft');
  assert.match(f.get('accountsText').value, /bulk@example.test/);
  assert.match(f.get('quickAccountError').textContent, /未保存的草稿/);
});

test('原触发按钮重绘后，关闭快速编辑仍回到同一账号的编辑按钮', async t => {
  const f = await fixture(t);
  await f.context.showEditor('one@example.test');
  f.document.activeElement.isConnected = false;
  let focused = false;
  f.get('cardList').children = [{ dataset: { email: 'one@example.test' }, querySelector: selector => selector === '.card-footer [data-act="edit"]' ? { focus() { focused = true; } } : null }];
  await f.fire('btnCancelQuickAccount', 'click');
  assert.equal(focused, true);
  assert.equal(f.stats().restoredFocus, false);
});
