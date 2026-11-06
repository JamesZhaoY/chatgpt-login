const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('../src/store');
const { createServer } = require('../src/server');
const { frontend } = require('./helpers/frontend');

const email = 'alice+1@example.test';
const secret = 'BH4OWU3OMXPJ7P63';
const password = ' Fixture<&12!xx ';
const mailUrl = 'https://mail.example.test/m?f=html&e=alice:fixture';
const row = `${email}----${password}----${secret}----${mailUrl}\n`;

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-account-export-'));
  const options = { dir, accountsFile: path.join(dir, 'accounts.txt'), infoFile: path.join(dir, 'info.json') };
  const store = new Store(options);
  store.writeAccountRows([{ email, password, totpSecret: secret, mailUrl }, { email: 'empty@example.test' }]);
  const worker = { getState: () => ({ queue: [], inFlight: [], running: false }) };
  const server = createServer({ store, worker, config: { batch: { headless: true } }, publicDir: path.join(__dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeEvents(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(base + '/api/accounts/export', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { store, options, base, post };
}

test('单个与批量导出四字段，缺失填 x，别名和密码原文保留，去重但不改变顺序', async t => {
  const { store, options, post } = await fixture(t);
  const files = [store.accountsFile, store.passwordsFile, store.twofaFile];
  const before = files.map(file => fs.readFileSync(file, 'utf8'));
  const events = [];
  store.subscribe(event => events.push(event));
  const single = await post({ emails: [' ALICE+1@example.test '] });
  assert.equal(single.status, 200);
  assert.equal(single.headers.get('cache-control'), 'no-store');
  assert.equal(single.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await single.json(), { content: row, count: 1 });
  const batch = await post({ emails: ['empty@example.test', email, 'ALICE+1@example.test'] });
  assert.deepEqual(await batch.json(), { content: 'empty@example.test----x----x----x\n' + row, count: 2 });
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), before);
  assert.deepEqual(events, []);
  assert.equal(new Store(options).exportAccounts([email]).content, row);
  assert.ok(!JSON.stringify(store.listAccounts()).includes(password));
  assert.ok(!JSON.stringify(store.listAccounts()).includes(secret));
});

test('三段导入密钥未登录也可导出；保留当前凭据，待确认新值不覆盖导出结果', async t => {
  const { store, post } = await fixture(t);
  const imported = 'imported@example.test';
  store.writeAccountsFile(`${email}----${mailUrl}\n${imported}----https://mail.example.test/imported----${secret}\nempty@example.test`);
  store.preparePassword(email, 'Pending12!xx');
  store.recordPassword(email, { submittedAt: 'submitted' });
  store.beginTwofaRotation(email);
  store.prepareTwofaRotation(email, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  store.recordTwofa(email, { pendingSubmittedAt: 'submitted' });
  store.preparePassword('empty@example.test', 'PendingOnly12!');
  store.recordPassword('empty@example.test', { submittedAt: 'submitted' });
  const response = await post({ emails: [email, imported, 'empty@example.test'] });
  assert.deepEqual(await response.json(), { count: 3, content: row + `${imported}----x----${secret}----https://mail.example.test/imported\nempty@example.test----x----x----x\n` });
  assert.equal(store.getTwofaSecret(imported), null);
  assert.equal(store.getPassword(email, true), 'Pending12!xx');
  assert.equal(store.twofaSummary(email).rotating, true);
});

test('导出校验账号范围、方法和来源，错误中不回显凭据或输出半份文件', async t => {
  const { store, base, post } = await fixture(t);
  for (const body of [{}, { emails: [] }, { emails: 'all' }, { emails: [1] }, { emails: [email, 'unknown@example.test'] }]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    const data = await response.json();
    assert.equal(data.content, undefined);
    assert.ok(!JSON.stringify(data).includes(password));
  }
  assert.equal((await fetch(base + '/api/accounts/export')).status, 405);
  assert.equal((await post({ emails: [email] }, { Origin: 'https://example.test' })).status, 403);
  assert.equal((await post({ emails: [email] }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  store.recordPassword(email, { password: 'Unrepresentable----fixture' });
  const response = await post({ emails: ['empty@example.test', email] });
  assert.equal(response.status, 409);
  const data = await response.json();
  assert.match(data.error, /第 2 个账号的密码/);
  assert.ok(!JSON.stringify(data).includes('Unrepresentable'));
  assert.equal(data.content, undefined);
});

test('单个、筛选跨页和所选导出下载 TXT，含执行中账号，点击去重并释放下载对象', async t => {
  const { context, elements, document } = await frontend();
  const makeAccount = email => ({ email, status: 'idle', mailUrl: '', logs: [], password: {}, twofa: {} });
  context.app.accounts = Array.from({ length: 25 }, (_, i) => makeAccount(`user-${i}@example.test`));
  context.app.accounts[0].status = 'running';
  context.app.accounts.push(makeAccount('outside@example.test'));
  context.app.connected = context.app.loaded = true;
  context.app.selected = new Set(['user-0@example.test', 'outside@example.test']);
  context.initAccounts({ refresh: async () => {} });
  elements.get('#searchInput').value = 'user-';
  context.app.page = 2;
  context.renderAccounts();
  const created = [];
  const downloads = [];
  const revoked = [];
  const timers = [];
  const requests = [];
  let release;
  t.mock.method(global, 'setTimeout', (fn, ms) => { timers.push({ fn, ms }); return 0; });
  t.mock.method(URL, 'createObjectURL', blob => { created.push(blob); return `blob:fixture-${created.length}`; });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const makeElement = document.createElement;
  document.createElement = tag => tag !== 'a' ? makeElement(tag) : {
    click() { downloads.push(this); }, remove() { this.removed = true; },
  };
  document.body = { appendChild(node) { node.parentElement = this; } };
  const querySelector = document.querySelector;
  document.querySelector = selector => selector === 'dialog[open]' ? null : querySelector(selector);
  t.mock.method(global, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ count: body.emails.length, content: body.emails.map(email => `${email}----x----x----x\n`).join('') }) };
  });
  const filtered = elements.get('#btnExportFiltered');
  filtered.id = 'btnExportFiltered';
  assert.equal(filtered.disabled, false);
  const pending = filtered.handlers.click[0]({ currentTarget: filtered });
  assert.equal(requests[0].url, '/api/accounts/export');
  assert.deepEqual(requests[0].body.emails, context.app.accounts.slice(0, 25).map(a => a.email));
  await filtered.handlers.click[0]({ currentTarget: filtered });
  assert.equal(requests.length, 1);
  release(); await pending;
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].download, /^chatgpt-accounts-25-.*\.txt$/);
  assert.equal(created[0].type, 'text/plain;charset=utf-8');
  assert.equal(await created[0].text(), requests[0].body.emails.map(email => `${email}----x----x----x\n`).join(''));
  assert.ok(downloads[0].removed);
  const selected = elements.get('#btnExportSelected');
  selected.id = 'btnExportSelected';
  const next = selected.handlers.click[0]({ currentTarget: selected });
  assert.deepEqual(requests[1].body.emails, ['user-0@example.test', 'outside@example.test']);
  release(); await next;
  const button = { disabled: false, dataset: { act: 'export' }, closest: selector => selector === '[data-email]' ? { dataset: { email: 'user-2@example.test' } } : null };
  elements.get('#cardList').handlers.click[0]({ target: { closest: () => button } });
  assert.deepEqual(requests[2].body.emails, ['user-2@example.test']);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(downloads.length, 3);
  assert.equal(button.disabled, false);
  assert.match(elements.get('#toastText').textContent, /已导出 1 个账号/);
  for (const timer of timers.filter(timer => timer.ms === 1000)) timer.fn();
  assert.deepEqual(revoked, ['blob:fixture-1', 'blob:fixture-2', 'blob:fixture-3']);
  context.app.connected = false;
  context.renderAccounts();
  assert.equal(filtered.disabled, true); assert.equal(selected.disabled, true);
  context.app.connected = true; context.app.selected.clear(); elements.get('#searchInput').value = 'no-match';
  context.renderAccounts();
  assert.equal(filtered.disabled, true); assert.equal(selected.disabled, true);
  await context.exportAccounts([]);
  assert.equal(requests.length, 3);
});

test('导出失败不下载错误内容，按钮恢复并显示服务返回原因', async t => {
  const { context, elements } = await frontend();
  t.mock.method(global, 'setTimeout', () => 0);
  t.mock.method(global, 'fetch', async () => ({ ok: false, json: async () => ({ error: '账号资料已更新，请刷新' }) }));
  const create = t.mock.method(URL, 'createObjectURL', () => { throw new Error('must not download'); });
  context.app.accounts = [{ email, status: 'idle' }];
  context.app.connected = true;
  context.initAccounts({ refresh: async () => {} });
  const button = elements.get('#btnExportFiltered'); button.id = 'btnExportFiltered';
  await button.handlers.click[0]({ currentTarget: button });
  assert.equal(create.mock.callCount(), 0);
  assert.equal(button.disabled, false);
  assert.equal(elements.get('#toastText').textContent, '账号资料已更新，请刷新');
});
