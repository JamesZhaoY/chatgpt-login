const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { frontend } = require('./helpers/frontend');
const Store = require('../src/store');
const { createServer } = require('../src/server');

function windowFixture() {
  const window = { location: { hash: '#accounts' }, handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } };
  window.history = { pushState: (_, __, hash) => { window.location.hash = hash; } };
  global.window = window;
  return window;
}

test('四个视图只显示当前区域；切换保留筛选、账号草稿和代理草稿，支持地址导航', async () => {
  const { context, document, elements } = await frontend();
  const window = windowFixture();
  const panels = ['accounts', 'manage', 'tasks', 'settings'].map(view => ({ dataset: { view }, hidden: true }));
  const links = panels.map(panel => ({ dataset: { nav: panel.dataset.view }, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; } }));
  document.querySelectorAll = selector => selector === '[data-view]' ? panels : selector.startsWith('.primary-nav') ? links : [];
  Object.assign(context.app, { filter: 'ready', editorDirty: true, proxyDirty: true, editorRows: [{ email: 'draft@example.test', password: 'fixture only' }] });
  context.initNavigation();
  await context.navigate('settings');
  assert.deepEqual(panels.filter(panel => !panel.hidden).map(panel => panel.dataset.view), ['settings']);
  assert.equal(links[3].attrs['aria-current'], 'page');
  assert.equal(elements.get('#overviewActions').hidden, true);
  assert.equal(window.location.hash, '#settings');
  assert.equal(context.app.editorRows[0].password, 'fixture only');
  assert.equal(context.app.filter, 'ready'); assert.equal(context.app.proxyDirty, true);
  await context.navigate('accounts');
  assert.equal(elements.get('#overviewActions').hidden, false);
  window.location.hash = '#tasks';
  await window.handlers.popstate();
  assert.equal(context.app.view, 'tasks');
});

test('账号分页有边界，每页 12 张卡片，筛选和批量操作仍取得完整结果', async () => {
  const { context } = await frontend();
  context.app.accounts = Array.from({ length: 29 }, (_, i) => ({ email: `account-${i}@example.test`, mailUrl: '', status: 'idle' }));
  assert.equal(context.paginatedAccounts().items.length, 12);
  context.app.page = 3;
  const last = context.paginatedAccounts();
  assert.equal(last.items.length, 5); assert.equal(last.start, 24); assert.equal(last.pages, 3);
  assert.equal(context.filteredAccounts().length, 29);
  context.app.page = 100;
  assert.equal(context.paginatedAccounts().items.length, 5);
  context.app.accounts = [];
  assert.deepEqual(context.paginatedAccounts(), { items: [], pages: 1, start: 0, total: 0 });
});

test('账号管理复用未保存草稿，重新进入无草稿页面时更新数据；任务日志转义内容', async t => {
  const { context } = await frontend();
  let requests = 0;
  t.mock.method(global, 'fetch', async () => { requests++; return { ok: true, json: async () => ({ accounts: [{ email: 'fixture@example.test', mailUrl: '' }] }) }; });
  await context.loadEditor();
  context.app.editorRows[0].password = 'not saved yet'; context.app.editorDirty = true;
  context.app.view = 'settings';
  await context.loadEditor();
  assert.equal(requests, 1); assert.equal(context.app.editorRows[0].password, 'not saved yet');
  context.app.editorDirty = false;
  await context.loadEditor();
  assert.equal(requests, 2); assert.equal(context.app.editorRows[0].password, '');
  const html = context.taskRecordHTML({ email: 'fixture@example.test', status: 'fail', stage: '<img src=x>', logs: ['<script>bad</script>'] });
  assert.ok(!html.includes('<script>')); assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x&gt;/);
});

test('实际入口模块可启动，接收实时快照、分页渲染并绑定四个页面的操作', async t => {
  const { context, elements, document } = await frontend();
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const querySelector = document.querySelector;
  document.querySelector = selector => {
    if (/^#[\w-]+$/.test(selector)) assert.ok(ids.has(selector.slice(1)), `Missing HTML control: ${selector}`);
    return querySelector(selector);
  };
  windowFixture();
  global.navigator = {};
  t.mock.method(global, 'setInterval', () => 0);
  global.matchMedia = () => ({ matches: false, addEventListener() {} });
  global.localStorage = { getItem: () => null, setItem() {} };
  let events;
  global.EventSource = class { constructor() { events = this; } close() {} };
  const fixtures = Array.from({ length: 25 }, (_, i) => ({ email: `fixture-${i}@example.test`, status: 'idle', mailUrl: '', logs: [], password: {}, twofa: {} }));
  const proxy = { enabled: false, server: '', username: '', hasPassword: false };
  t.mock.method(global, 'fetch', async route => ({ ok: true, json: async () => route === '/api/accounts' ? fixtures : route === '/api/worker' ? { queue: [], inFlight: [], running: false } : { batch: { headless: true }, proxy } }));
  await import('../public/app.mjs');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('#cardList').children.length, 12);
  assert.equal(elements.get('#pagePosition').textContent, '第 1 / 3 页');
  assert.ok(elements.get('#proxyForm').handlers.submit.length);
  assert.ok(elements.get('#accountsForm').handlers.submit.length);
  assert.ok(elements.get('#btnNextPage').handlers.click.length);
  assert.ok(events);
  events.onopen();
  events.onmessage({ data: JSON.stringify({ type: 'worker', worker: { queue: ['fixture-1@example.test'], inFlight: ['fixture-0@example.test'], running: true } }) });
  context.renderTasks();
  context.updateNavigation();
  assert.equal(elements.get('#navTaskCount').textContent, 2);
  assert.match(elements.get('#currentTasks').innerHTML, /fixture-0@example.test/);
  assert.match(elements.get('#waitingTasks').innerHTML, /fixture-1@example.test/);
  assert.equal(context.app.connected, true);
  assert.equal(document.documentElement.dataset.theme, 'light');
});

test('入口、所有模块和样式均按正确 MIME 提供，未授权路径继续不可读取', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-layout-'));
  const store = new Store({ dir, accountsFile: path.join(dir, 'accounts.txt'), infoFile: path.join(dir, 'info.json') });
  const worker = { getState: () => ({ queue: [], inFlight: [], running: false }) };
  const server = createServer({ store, worker, config: { batch: { headless: true } }, publicDir: path.join(__dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [folder, extension, mime] of [['js', 'mjs', 'text/javascript'], ['css', 'css', 'text/css']]) {
    for (const name of fs.readdirSync(path.join(__dirname, '../public', folder)).filter(name => name.endsWith('.' + extension))) {
      const response = await fetch(`${base}/${folder}/${name}`);
      assert.equal(response.status, 200); assert.ok(response.headers.get('content-type').startsWith(mime));
    }
  }
  assert.equal((await fetch(base + '/js/unknown.mjs')).status, 404);
  assert.equal((await fetch(base + '/js/%2e%2e/%2e%2e/passwords.json')).status, 404);
  assert.equal((await fetch(base + '/app.mjs')).status, 200);
});
