const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('../src/store');
const Worker = require('../src/worker');
const { createServer } = require('../src/server');
const { frontend } = require('./helpers/frontend');

const email = 'alice+1@example.test';
const other = 'bob@example.test';
const secret = 'BH4OWU3OMXPJ7P63';
const config = { mail: {}, batch: { headless: true, delayBetweenAccountsMs: 0, perAccountTimeoutMs: 1000 } };
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-account-actions-'));
  const options = { dir, accountsFile: path.join(dir, 'accounts.txt'), infoFile: path.join(dir, 'info.json') };
  const store = new Store(options);
  store.writeAccountsFile(`${email}----https://mail.example.test/inbox----${secret}\n${other}`);
  store.recordPassword(email, { password: 'FixtureOnly12!' });
  store.saveInfo(email, { accessToken: 'fixture-token', expires: '2099-01-01' });
  store.getAccount(email).info = store.infoStore.get(email);
  store.setStatus(email, 'ok');
  store.saveProfile(email, { cookies: [], origins: [] });
  store.savePlan(email, { planName: 'Plus', fetchedAt: '2026-10-23' });
  const worker = new Worker({ store, config });
  const server = createServer({ store, worker, config, publicDir: path.join(__dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await worker.stop(); server.closeEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}, route = '/api/accounts/action') => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { store, options, worker, base, post };
}

test('不可用标记持久化、广播且可恢复；所有任务跳过不可用账号，导出仍保留', async t => {
  const { store, options, worker, post } = await fixture(t);
  const events = []; store.subscribe(event => events.push(event));
  const response = await post({ email: ' ALICE+1@example.test ', action: 'disable', confirmed: true });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).accounts.find(a => a.email === email).unavailable, true);
  assert.equal(store.getAccount(email).status, 'ok');
  assert.equal(store.getAccount(email).info.accessToken, 'fixture-token');
  assert.equal(fs.statSync(store.accountFlagsFile).mode & 0o777, 0o600);
  assert.equal(new Store(options).getAccount(email).unavailable, true);
  for (const op of ['login', 'password', 'password-verify', 'twofa', 'twofa-verify', 'twofa-replace', 'plan', 'setup', 'setup-password', 'setup-twofa']) assert.deepEqual(worker.enqueue([email], op), []);
  assert.match(store.exportAccounts([email]).content, /FixtureOnly12!/);
  const saved = store.parseAccountsFile();
  store.writeAccountsFile(store.serializeAccounts(saved));
  assert.equal(store.getAccount(email).unavailable, true);
  assert.ok(events.some(event => event.type === 'accounts' && event.accounts[0].unavailable));
  assert.ok(!JSON.stringify(events).includes(secret));
  assert.equal((await post({ email, action: 'restore', confirmed: true })).status, 200);
  assert.equal(new Store(options).getAccount(email).unavailable, false);
  worker._runOne = async () => {};
  assert.deepEqual(worker.enqueue([email]), [email]);
  await worker.drainPromise;
});

test('删除只移除目标列表项，保留凭据、导入密钥、会话、会员；旧草稿无法重新覆盖', async t => {
  const { store, options, post } = await fixture(t);
  const before = fs.readFileSync(store.accountsFile, 'utf8');
  const snapshots = [store.passwordsFile, store.infoFile, store.plansFile, store.profilePath(email)].map(file => [file, fs.readFileSync(file, 'utf8')]);
  const response = await post({ email, action: 'delete', confirmed: true });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).accounts.map(a => a.email), [other]);
  assert.equal(store.accounts.has(email), false);
  assert.equal(store.getTwofaSecret(email), secret);
  assert.equal(new Store(options).accounts.has(email), false);
  for (const [file, content] of snapshots) assert.equal(fs.readFileSync(file, 'utf8'), content);
  const stale = await post({ content: before, expectedContent: before }, {}, '/api/accounts-file');
  assert.equal(stale.status, 409);
  store.writeAccountsFile(`${email}\n${other}`);
  const restored = new Store(options);
  assert.equal(restored.getTwofaSecret(email), secret);
  assert.equal(restored.getPassword(email), 'FixtureOnly12!');
  assert.equal(restored.getAccount(email).info.accessToken, 'fixture-token');
  assert.equal(restored.plans.get(email).planName, 'Plus');
});

test('写入失败时不可用标记和删除均不改变列表或内存数据', async t => {
  const { store, options } = await fixture(t);
  store.accountFlagsFile = path.join(store.dir, 'missing', 'flags.json');
  assert.throws(() => store.setAccountUnavailable(email, true));
  assert.equal(store.getAccount(email).unavailable, false);
  assert.equal(store.accountFlags.size, 0);
  const before = fs.readFileSync(options.accountsFile, 'utf8');
  store.twofaFile = path.join(store.dir, 'missing', 'twofa.json');
  assert.throws(() => store.removeAccount(email));
  assert.equal(fs.readFileSync(options.accountsFile, 'utf8'), before);
  assert.ok(store.accounts.has(email));
  assert.equal(store.getTwofaSecret(email), null);
  assert.equal(store.importedTwofa.get(email), secret);
});

test('操作需要二次确认，校验方法来源和账号，任务开始后拒绝改动', async t => {
  const { store, worker, base, post } = await fixture(t);
  for (const body of [{ email, action: 'delete' }, { email, action: 'disable', confirmed: 'true' }, { email, action: 'unknown', confirmed: true }]) assert.equal((await post(body)).status, 400);
  assert.equal((await post({ email: 'absent@example.test', action: 'delete', confirmed: true })).status, 404);
  assert.equal((await fetch(base + '/api/accounts/action')).status, 405);
  assert.equal((await post({ email, action: 'delete', confirmed: true }, { Origin: 'https://other.test' })).status, 403);
  worker.inFlight.add(email);
  assert.equal((await post({ email, action: 'delete', confirmed: true })).status, 409);
  worker.inFlight.clear(); worker.queue.push(email);
  assert.equal((await post({ email, action: 'disable', confirmed: true })).status, 409);
  worker.queue = []; store.setStatus(email, 'running');
  assert.equal((await post({ email, action: 'delete', confirmed: true })).status, 409);
  assert.ok(store.accounts.has(email)); assert.equal(store.getAccount(email).unavailable, false);
});

const account = (email, patch = {}) => ({ email, status: 'ok', info: { accessToken: 'fixture', expires: '2099-01-01' }, password: {}, twofa: {}, logs: [], ...patch });

test('概览菜单打开二次确认但不提交；取消无改动；确认只提交所示账号，连点不会重复', async t => {
  const { context, elements, document } = await frontend();
  t.mock.method(global, 'setTimeout', () => 0);
  const requests = []; let release;
  t.mock.method(global, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, body });
    await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ accounts: body.action === 'delete' ? [account(other)] : [account(email, { unavailable: body.action === 'disable' }), account(other)] }) };
  });
  context.app.accounts = [account(email), account(other)];
  context.app.connected = true;
  context.app.editorDirty = true; context.app.editorRows = [{ email: other, password: 'draft' }];
  context.initAccounts({ refresh: async () => {} });
  let focused = 0;
  const opener = { isConnected: true, focus: () => focused++ };
  const button = { disabled: false, dataset: { act: 'disable' }, closest: selector => selector === '[data-email]' ? { dataset: { email } } : selector === '.action-menu' ? { querySelector: () => opener } : null };
  const click = () => elements.get('#cardList').handlers.click[0]({ target: { closest: () => button } });
  click();
  const dialog = elements.get('#accountActionDialog');
  assert.equal(dialog.open, true);
  assert.equal(elements.get('#accountActionEmail').textContent, email);
  assert.match(elements.get('#accountActionDescription').textContent, /保留账号/);
  assert.equal(requests.length, 0);
  elements.get('#btnCancelAccountAction').handlers.click[0]();
  assert.equal(dialog.open, false); assert.equal(focused, 1); assert.equal(requests.length, 0);
  click();
  const submit = () => elements.get('#accountActionForm').handlers.submit[0]({ preventDefault() {} });
  const pending = submit();
  assert.deepEqual(requests, [{ url: '/api/accounts/action', body: { email, action: 'disable', confirmed: true } }]);
  await submit(); assert.equal(requests.length, 1);
  let prevented = false;
  dialog.handlers.cancel[0]({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  release(); await pending;
  assert.equal(dialog.open, false); assert.equal(context.app.accounts[0].unavailable, true);
  button.dataset.act = 'restore'; click();
  assert.match(elements.get('#accountActionTitle').textContent, /恢复/);
  const restored = submit(); release(); await restored;
  assert.equal(context.app.accounts[0].unavailable, false);
  context.app.selected.add(email);
  button.dataset.act = 'delete'; click();
  assert.match(elements.get('#accountActionDescription').textContent, /从本机列表移除/);
  const deleted = submit(); release(); await deleted;
  assert.deepEqual(context.app.accounts.map(a => a.email), [other]);
  assert.equal(context.app.selected.has(email), false);
  assert.equal(context.app.editorDirty, true); assert.equal(context.app.editorRows[0].password, 'draft');
  assert.equal(document.querySelector('#accountActionError').hidden, true);
});

test('确认期间账号转为运行中会阻止提交；后端失败保留弹窗并允许重试或取消', async t => {
  const { context, elements } = await frontend();
  const { openAccountAction, updateAccountAction } = await import('../public/js/account-actions.mjs');
  let requests = 0;
  t.mock.method(global, 'fetch', async () => { requests++; return { ok: false, json: async () => ({ error: '该账号正在执行任务' }) }; });
  context.app.accounts = [account(email)]; context.app.connected = true;
  context.initAccounts({ refresh: async () => {} });
  openAccountAction(email, 'delete');
  context.app.accounts[0].status = 'running'; updateAccountAction();
  assert.equal(elements.get('#btnConfirmAccountAction').disabled, true);
  const submit = () => elements.get('#accountActionForm').handlers.submit[0]({ preventDefault() {} });
  await submit(); assert.equal(requests, 0);
  context.app.accounts[0].status = 'ok'; updateAccountAction();
  await submit(); assert.equal(requests, 1);
  assert.equal(elements.get('#accountActionDialog').open, true);
  assert.match(elements.get('#accountActionError').textContent, /正在执行任务/);
  assert.equal(elements.get('#btnConfirmAccountAction').disabled, false);
  elements.get('#btnCancelAccountAction').handlers.click[0]();
});

test('不可用账号独立筛选、可恢复可导出；详情和所有批量任务跳过', async t => {
  const { context, elements } = await frontend();
  t.mock.method(global, 'setTimeout', () => 0);
  const requests = [];
  t.mock.method(global, 'fetch', async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ queued: 1 }) }; });
  context.app.accounts = [account(email, { unavailable: true }), account(other)]; context.app.connected = true;
  context.initAccounts({ refresh: async () => {} });
  assert.equal(context.status(context.app.accounts[0]), 'disabled');
  assert.equal(context.usable(context.app.accounts[0]), false);
  assert.equal(context.attention(context.app.accounts[0]), false);
  context.app.filter = 'unavailable';
  assert.deepEqual(context.filteredAccounts().map(a => a.email), [email]);
  const html = context.accountHTML(context.app.accounts[0]);
  assert.match(html, /data-act="restore"/);
  assert.match(html, /data-act="delete"/);
  assert.match(html, /data-act="login" disabled/);
  context.renderAccounts();
  assert.equal(elements.get('#btnPlansFiltered').disabled, true);
  assert.equal(elements.get('#btnExportFiltered').disabled, false);
  context.app.filter = 'all'; context.app.selected = new Set([email, other]); context.renderAccounts();
  for (const id of ['btnLoginSelected', 'btnPlansFiltered', 'btnSetupSelected']) {
    const button = elements.get('#' + id); button.id = id;
    await button.handlers.click[0]({ currentTarget: button });
  }
  assert.ok(requests.every(request => JSON.stringify(request.body.emails) === JSON.stringify([other])));
  const { openAccountDetails } = await import('../public/js/account-details.mjs');
  openAccountDetails(email);
  assert.equal(elements.get('#detailLogin').disabled, true);
  assert.equal(elements.get('#detailRefreshPlan').disabled, true);
  elements.get('#accountDetails').close();
});
