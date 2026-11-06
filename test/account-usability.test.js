const { test } = require('node:test');
const assert = require('node:assert/strict');
const { frontend } = require('./helpers/frontend');

function account(email, patch = {}) {
  return { email, status: 'idle', mailUrl: '', logs: [], password: {}, twofa: {}, ...patch };
}

test('多邮箱搜索按任一邮箱匹配，保留 + 标签，套餐及会话条件继续取交集', async () => {
  const { context, controls } = await frontend();
  context.app.accounts = [account('alice+1@icloud.com'), account('alice+2@icloud.com'), account('bob@example.test', { plan: { planType: 'plus', planName: 'Plus', fetchedAt: '2026-10-21' } })];
  controls['#searchInput'].value = 'ALICE+1@icloud.com， bob@example.test\n';
  assert.deepEqual(context.filteredAccounts().map(item => item.email), ['alice+1@icloud.com', 'bob@example.test']);
  controls['#planFilter'].value = 'plus';
  assert.deepEqual(context.filteredAccounts().map(item => item.email), ['bob@example.test']);
  const chips = context.activeFilterChips();
  assert.equal(chips.length, 2);
  assert.ok(chips.some(([key]) => key === 'planFilter'));
  context.clearFilter('planFilter');
  assert.equal(context.filteredAccounts().length, 2);
  context.clearFilter('search');
  assert.equal(context.filteredAccounts().length, 3);
});

test('全选筛选结果跨页生效，状态变化和搜索不会悄悄取消已选；批量登录只使用已选且未执行的账号', async t => {
  const { context, elements } = await frontend();
  const requests = [];
  t.mock.method(global, 'fetch', async (route, options) => {
    requests.push({ route, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ queued: 2 }) };
  });
  context.app.accounts = Array.from({ length: 25 }, (_, i) => account(`user-${i}@example.test`));
  context.app.loaded = context.app.connected = true;
  context.initAccounts({ refresh: async () => {} });
  context.renderAccounts();
  elements.get('#btnSelectFiltered').handlers.click[0]();
  assert.equal(context.app.selected.size, 25);
  context.app.accounts[0].status = 'running';
  elements.get('#searchInput').value = 'user-3@';
  context.renderAccounts();
  assert.equal(context.app.selected.size, 25);
  assert.match(elements.get('#selectionText').textContent, /24 个不在当前筛选中/);
  assert.equal(elements.get('#cardList').children.length, 1);
  assert.equal(context.selectedAccounts().filter(item => item.status !== 'running').length, 24);
  const button = elements.get('#btnLoginSelected');
  button.id = 'btnLoginSelected';
  await button.handlers.click[0]({ currentTarget: button });
  assert.equal(requests[0].route, '/api/login-batch');
  assert.equal(requests[0].body.emails.length, 24);
  assert.ok(!requests[0].body.emails.includes('user-0@example.test'));
  elements.get('#btnClearSelection').handlers.click[0]();
  assert.equal(context.app.selected.size, 0);
});

test('页容量切换复位页码，选择当前页不会隐式选择其他页，详情不注入卡片导致网格重排', async () => {
  const { context, elements } = await frontend();
  context.app.accounts = Array.from({ length: 60 }, (_, i) => account(`user-${i}@example.test`));
  context.initAccounts({ refresh: async () => {} });
  context.app.page = 4;
  elements.get('#pageSizeSelect').handlers.change[0]({ target: { value: '24' } });
  assert.equal(context.app.page, 1);
  assert.equal(context.paginatedAccounts().items.length, 24);
  elements.get('#selectAll').handlers.change[0]({ target: { checked: true } });
  assert.equal(context.app.selected.size, 24);
  context.app.page = 2;
  assert.equal(context.paginatedAccounts().items.length, 24);
  elements.get('#pageSizeSelect').handlers.change[0]({ target: { value: '9999' } });
  assert.equal(context.app.pageSize, 24);
  const html = context.accountHTML(account('drawer@example.test', { logs: ['SECRET_FIXTURE_LOG'], plan: { fetchedAt: '2026-10-21', planName: 'Plus' } }));
  assert.match(html, /data-act="login"/);
  assert.match(html, /data-act="edit"/);
  assert.match(html, /data-act="copy-token"/);
  assert.doesNotMatch(html, /SECRET_FIXTURE_LOG|class="plan-details"|class="log-panel"/);
});

test('侧边详情显示正确账号与标签，保留当前页、筛选和勾选；关闭后清理内容恢复焦点', async () => {
  const { context, document, elements } = await frontend();
  const { openAccountDetails, renderAccountDetails } = await import('../public/js/account-details.mjs');
  context.app.accounts = [account('alice@example.test', { logs: ['<test>new log'], plan: { planName: 'Plus', fetchedAt: '2026-10-21', status: 'active' } })];
  context.app.page = 3; context.app.filter = 'ready'; context.app.selected.add('alice@example.test');
  const dialog = document.querySelector('#accountDetails');
  let opened = 0; let focused = 0;
  dialog.showModal = () => { dialog.open = true; opened++; };
  dialog.close = () => { dialog.open = false; for (const fn of dialog.handlers.close || []) fn(); };
  const trigger = { isConnected: true, dataset: { act: 'logs' }, focus: () => { focused++; } };
  context.initAccounts({ refresh: async () => {} });
  openAccountDetails('alice@example.test', 'logs', trigger);
  assert.equal(opened, 1);
  assert.equal(elements.get('#accountDetailsTitle').textContent, 'alice@example.test');
  assert.match(elements.get('#accountDetailsBody').innerHTML, /&lt;test&gt;new log/);
  assert.equal(context.app.page, 3); assert.equal(context.app.filter, 'ready'); assert.equal(context.app.selected.size, 1);
  context.app.accounts[0].logs.push('latest fixture log');
  renderAccountDetails();
  assert.match(elements.get('#accountDetailsBody').innerHTML, /latest fixture log/);
  dialog.handlers.click.find(() => true)({ target: { closest: selector => selector === '[data-detail-tab]' ? { dataset: { detailTab: 'plan' } } : null } });
  assert.match(elements.get('#accountDetailsBody').innerHTML, /Plus/);
  dialog.close();
  assert.equal(context.app.detailsEmail, null); assert.equal(elements.get('#accountDetailsBody').innerHTML, ''); assert.equal(focused, 1);
});

test('原生详情窗口内的反馈与剪贴板降级位于可交互的窗口内，关闭后反馈移回页面', async t => {
  const { context, document, elements } = await frontend();
  const events = {};
  document.addEventListener = (name, fn) => { events[name] = fn; };
  const children = [];
  const dialog = document.querySelector('dialog[open]');
  dialog.appendChild = node => { children.push(node); node.parentElement = dialog; };
  dialog.matches = selector => selector === 'dialog';
  const bodyChildren = [];
  document.body = { appendChild(node) { bodyChildren.push(node); node.parentElement = this; } };
  t.mock.method(global, 'setTimeout', () => 0);
  global.navigator = { clipboard: { writeText: async () => { throw new Error('fixture denied'); } } };
  let selected = false; let removed = false;
  document.createElement = () => ({ select() { selected = true; }, remove() { removed = true; } });
  document.execCommand = command => command === 'copy';
  document.activeElement.focus = () => {};
  context.initToast();
  await context.copy('fixture-only', 'copied');
  assert.equal(selected, true); assert.equal(removed, true);
  assert.ok(children.some(node => node.value === 'fixture-only'));
  assert.equal(elements.get('#toast').parentElement, dialog);
  events.close({ target: dialog });
  assert.equal(elements.get('#toast').parentElement, document.body);
});

test('账号菜单手动刷新只提交当前账号，不触发其他已选账号', async t => {
  const { context, elements } = await frontend();
  t.mock.method(global, 'setTimeout', () => 0);
  const requests = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ queued: 1 }) };
  });
  context.app.accounts = [account('first@example.test'), account('second@example.test')];
  context.app.selected.add('second@example.test');
  context.initAccounts({ refresh: async () => {} });
  const button = { disabled: false, dataset: { act: 'refresh-plan' },
    closest: selector => selector === '[data-email]' ? { dataset: { email: 'first@example.test' } } : null };
  elements.get('#cardList').handlers.click[0]({ target: { closest: () => button } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, [{ url: '/api/plans/refresh', body: { emails: ['first@example.test'] } }]);
  assert.equal(button.disabled, false);
});

test('批量会员查询覆盖筛选的所有页；已选查询保留筛选外勾选，跳过进行中并防止重复入队', async t => {
  const { context, elements } = await frontend();
  t.mock.method(global, 'setTimeout', () => 0);
  const requests = [];
  let release;
  t.mock.method(global, 'fetch', async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ queued: requests.at(-1).body.emails.length }) };
  });
  context.app.accounts = Array.from({ length: 26 }, (_, i) => account(`user-${i}@example.test`));
  context.app.accounts[0].status = 'running';
  context.app.accounts[1].status = 'pending';
  context.app.accounts.push(account('outside@example.test'));
  context.app.connected = true;
  context.app.loaded = true;
  context.initAccounts({ refresh: async () => {} });
  elements.get('#searchInput').value = 'user-';
  context.app.page = 2;
  context.renderAccounts();
  const filtered = elements.get('#btnPlansFiltered');
  filtered.id = 'btnPlansFiltered';
  assert.equal(filtered.disabled, false);
  const pending = filtered.handlers.click[0]({ currentTarget: filtered });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/plans/refresh');
  assert.deepEqual(requests[0].body.emails, context.app.accounts.slice(2, 26).map(a => a.email));
  await filtered.handlers.click[0]({ currentTarget: filtered });
  assert.equal(requests.length, 1);
  release(); await pending;
  context.app.selected = new Set(['user-0@example.test', 'user-2@example.test', 'outside@example.test']);
  context.renderAccounts();
  const selected = elements.get('#btnPlansSelected');
  selected.id = 'btnPlansSelected';
  assert.equal(selected.disabled, false);
  const second = selected.handlers.click[0]({ currentTarget: selected });
  assert.deepEqual(requests[1].body.emails, ['user-2@example.test', 'outside@example.test']);
  release(); await second;
  assert.match(elements.get('#toastText').textContent, /已加入 2 个会员权益查询任务/);
  context.app.connected = false;
  context.renderAccounts();
  assert.equal(filtered.disabled, true); assert.equal(selected.disabled, true);
  context.app.connected = true; context.app.selected.clear();
  elements.get('#searchInput').value = 'no-match';
  context.renderAccounts();
  assert.equal(filtered.disabled, true); assert.equal(selected.disabled, true);
  await context.queuePlans([]);
  assert.equal(requests.length, 2);
});
