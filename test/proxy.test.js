const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { request } = require('playwright');
const Store = require('../src/store');
const { createServer } = require('../src/server');
const { DEFAULT_PROXY, normalizeProxy, proxySummary, proxyOptions, testProxy } = require('../src/proxy');

const proxy = { enabled: true, server: 'http://proxy.example.test:8080', username: 'fixture-user', password: 'Fixture proxy pass!@' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-proxy-'));
  const options = { dir, accountsFile: path.join(dir, 'accounts.txt'), infoFile: path.join(dir, 'info.json') };
  const store = new Store(options);
  store.writeAccountsFile('alice@example.test\nbob@example.test');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { store, options };
}

test('代理地址规范化，支持 IP:端口、HTTP / HTTPS / SOCKS5 以及 IPv6，内嵌认证信息独立保存', () => {
  assert.deepEqual(normalizeProxy({ enabled: false }), DEFAULT_PROXY);
  for (const [server, expected] of [['127.0.0.1:7890', 'http://127.0.0.1:7890'], ['HTTPS://PROXY.example.test:443/', 'https://proxy.example.test:443'], ['socks5://127.0.0.1:1080', 'socks5://127.0.0.1:1080'], ['http://[::1]:8080', 'http://[::1]:8080']]) {
    const value = normalizeProxy({ enabled: true, server });
    assert.equal(value.server, expected); assert.deepEqual(proxyOptions(value), { server: expected });
  }
  const value = normalizeProxy({ enabled: true, server: 'http://fixture-user:pass%40word%3A1@proxy.example.test:8080' });
  assert.equal(value.username, 'fixture-user'); assert.equal(value.password, 'pass@word:1');
  assert.equal(value.server, proxy.server);
  assert.equal(proxySummary(value).hasPassword, true);
  assert.equal(proxySummary(value).password, undefined);
  assert.equal(proxyOptions({ ...proxy, enabled: false }), undefined);
});

test('只为同一代理和账号保留空密码，支持清除密码；验证错误不带输入的凭据', () => {
  assert.equal(normalizeProxy({ ...proxy, password: '' }, proxy).password, proxy.password);
  assert.equal(normalizeProxy({ ...proxy, server: 'http://other.example.test:8080', password: '' }, proxy).password, '');
  assert.equal(normalizeProxy({ ...proxy, username: 'other-user', password: '' }, proxy).password, '');
  assert.equal(normalizeProxy({ ...proxy, password: '', clearPassword: true }, proxy).password, '');
  for (const input of [null, [], {}, { ...proxy, enabled: 'true' }, { ...proxy, server: '' }, { ...proxy, server: 'file:///tmp/proxy' }, { ...proxy, server: 'http://host:0' }, { ...proxy, server: 'http://host:65536' }, { ...proxy, server: 'http://host/path' }, { ...proxy, server: 'http://host?token=fixture' }, { ...proxy, server: 'http://host\n' }, { ...proxy, server: 'socks5://host:1080' }, { ...proxy, password: 'line\nbreak' }, { ...proxy, clearPassword: true }]) {
    assert.throws(() => normalizeProxy(input), error => { assert.ok(!error.message.includes(proxy.password)); return true; });
  }
});

test('代理配置独立持久化、权限 0600，列表与事件不包含密码；写入失败保留旧配置', t => {
  const { store, options } = fixture(t);
  const events = [];
  store.subscribe(event => events.push(event));
  assert.equal(store.proxy.enabled, false);
  store.saveProxy(proxy);
  assert.deepEqual(new Store(options).proxy, proxy);
  assert.equal(fs.statSync(store.proxyFile).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(store.listAccounts()).includes(proxy.password));
  assert.ok(!JSON.stringify(events).includes(proxy.password));
  assert.equal(events[0].proxy.hasPassword, true);
  const file = store.proxyFile;
  store.proxyFile = path.join(store.dir, 'missing', 'proxy.json');
  assert.throws(() => store.saveProxy({ ...proxy, enabled: false }));
  assert.deepEqual(store.proxy, proxy);
  store.proxyFile = file;
  store.saveProxy({ ...proxy, enabled: false, password: '' });
  assert.equal(new Store(options).proxy.enabled, false);
  assert.equal(new Store(options).proxy.password, proxy.password);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => new Store(options), /proxy.json 格式/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('所有账号任务的浏览器上下文使用全局代理，一项任务中途修改配置仍使用原代理', async t => {
  const { store } = fixture(t);
  const config = { proxy: { ...proxy }, mail: {}, batch: { perAccountTimeoutMs: 2000 } };
  const filename = require.resolve('../src/worker');
  const load = createRequire(filename);
  const exported = { exports: {} };
  const contexts = [];
  const browserModule = require('../src/browser');
  const browser = { newContext: async options => { contexts.push(options); return { close: async () => {} }; } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: exported, AbortController, setTimeout, clearTimeout,
    require: name => name === './browser' ? { getBrowser: async () => browser, newContext: browserModule.newContext } : load(name) });
  const worker = new exported.exports({ store, config });
  let first = true;
  worker._loginOne = async (email, task) => {
    await worker._createContext(browser, { storageState: 'fixture-profile' }, task);
    if (first) { config.proxy = { ...proxy, server: 'https://other.example.test:8443' }; first = false; }
    await worker._createContext(browser, { proxy: { server: 'http://should-not-override:80' } }, task);
  };
  await worker._runOne('alice@example.test');
  assert.deepEqual(contexts[0].proxy, proxyOptions(proxy));
  assert.deepEqual(contexts[1].proxy, contexts[0].proxy);
  assert.equal(contexts[0].storageState, 'fixture-profile');
  assert.equal(contexts[0].locale, 'en-US');
  for (const method of ['_initializePassword', '_verifyPassword', '_initializeTwofa', '_replaceTwofa', '_verifyTwofa', '_fetchPlan', '_setupAccount']) worker[method] = async (email, task) => worker._createContext(browser, {}, task);
  for (const operation of ['login', 'password', 'password-verify', 'twofa', 'twofa-replace', 'twofa-verify', 'plan', 'setup']) await worker._runOne('bob@example.test', operation);
  assert.ok(contexts.slice(2).every(options => options.proxy.server === 'https://other.example.test:8443'));
  config.proxy = { ...proxy, enabled: false };
  await worker._runOne('alice@example.test');
  assert.equal(contexts.at(-1).proxy, undefined);
});

test('出口 IP 检测使用草稿代理和独立请求上下文，不携带账号会话，成功和失败均释放连接', async t => {
  let scenario = 'ok';
  let disposed = 0;
  let calls = 0;
  t.mock.method(request, 'newContext', async options => {
    calls++;
    assert.deepEqual(options, { proxy: proxyOptions(proxy), timeout: 8000 });
    return {
      get: async (url, options) => {
        assert.equal(url, 'https://api64.ipify.org?format=json');
        assert.equal(options.maxRedirects, 0);
        if (scenario === 'network') throw new Error('connection ' + proxy.password);
        if (scenario === 'timeout') throw new Error('Timeout ' + proxy.password);
        return { ok: () => scenario !== 'auth', status: () => 407, json: async () => ({ ip: scenario === 'invalid' ? 'not-an-ip' : '203.0.113.7' }) };
      },
      dispose: async () => { disposed++; },
    };
  });
  assert.equal((await testProxy(proxy)).ip, '203.0.113.7');
  for (const [value, pattern] of [['auth', /认证失败/], ['network', /无法通过此代理/], ['timeout', /超时/], ['invalid', /有效 IP/]]) {
    scenario = value;
    await assert.rejects(testProxy(proxy), error => { assert.match(error.message, pattern); assert.ok(!error.message.includes(proxy.password)); return true; });
  }
  await assert.rejects(testProxy({ ...proxy, enabled: false }), /先勾选/);
  assert.equal(calls, 5); assert.equal(disposed, 5);
});

test('真实 HTTP 请求经过本机模拟代理，认证信息发送给代理，不需要外部网络', async t => {
  const received = [];
  const server = http.createServer((req, res) => { received.push(req.headers); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"proxy":true}'); });
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('connect', (req, socket) => {
    received.push(req.headers);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => { socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{"proxy":true}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const value = normalizeProxy({ ...proxy, server: `http://127.0.0.1:${server.address().port}` });
  const context = await request.newContext({ proxy: proxyOptions(value), timeout: 3000 });
  t.after(() => context.dispose());
  const response = await context.get('http://fixture.invalid/mail');
  assert.equal((await response.json()).proxy, true);
  assert.ok(received.some(headers => headers['proxy-authorization'] === 'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64')));
});

test('代理 API 校验与持久化、重启加载、同源限制、密码隐藏和正在运行时更新', async t => {
  const { store, options } = fixture(t);
  const config = { batch: { headless: true } };
  const worker = { inFlight: new Set(), getState: () => ({ running: false, queue: [], inFlight: [] }) };
  const server = createServer({ store, worker, config, publicDir: path.join(__dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, data, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  assert.equal((await (await fetch(base + '/api/proxy')).json()).enabled, false);
  assert.equal((await post('/api/proxy', { enabled: true })).status, 400);
  assert.equal((await post('/api/proxy', proxy, { Origin: 'https://other.example.test' })).status, 403);
  worker.inFlight.add('alice@example.test');
  const saved = await (await post('/api/proxy', proxy)).json();
  assert.equal(saved.nextTask, true);
  assert.equal(saved.proxy.hasPassword, true);
  assert.deepEqual(config.proxy, proxy);
  for (const route of ['/api/proxy', '/api/config', '/api/accounts']) {
    const response = await fetch(base + route);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(!(await response.text()).includes(proxy.password));
  }
  const events = await fetch(base + '/api/events');
  const reader = events.body.getReader();
  const event = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.ok(event.includes('hasPassword')); assert.ok(!event.includes(proxy.password));
  assert.equal((await fetch(base + '/proxy.json')).status, 404);
  assert.deepEqual(new Store(options).proxy, proxy);
  assert.equal((await post('/api/proxy', { ...proxy, password: '', enabled: false })).status, 200);
  assert.equal(config.proxy.enabled, false); assert.equal(config.proxy.password, proxy.password);
  assert.equal((await post('/api/proxy/test', { enabled: false })).status, 400);
  const file = store.proxyFile;
  store.proxyFile = path.join(store.dir, 'missing', 'proxy.json');
  assert.equal((await post('/api/proxy', proxy)).status, 500);
  assert.equal(config.proxy.enabled, false);
  store.proxyFile = file;
});

test('出口检测 API 使用未保存草稿，不修改配置或账号队列，并拦截重复检测', async t => {
  const { store } = fixture(t);
  const config = { batch: { headless: true } };
  const worker = { inFlight: new Set(), getState: () => ({ running: false, queue: [], inFlight: [] }) };
  let release;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  t.mock.method(request, 'newContext', async options => {
    assert.deepEqual(options.proxy, proxyOptions(proxy));
    markStarted();
    return { get: () => new Promise(resolve => { release = () => resolve({ ok: () => true, json: async () => ({ ip: '203.0.113.9' }) }); }), dispose: async () => {} };
  });
  const server = createServer({ store, worker, config, publicDir: path.join(__dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release?.(); server.closeEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = () => fetch(base + '/api/proxy/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(proxy) });
  const pending = post();
  await started;
  assert.equal((await post()).status, 409);
  release();
  assert.equal((await (await pending).json()).ip, '203.0.113.9');
  assert.equal(store.proxy.enabled, false); assert.equal(config.proxy.enabled, false);
  assert.equal(fs.existsSync(store.proxyFile), false);
});

test('代理表单启停、草稿保持与密码留空，实时刷新不覆盖用户正在输入的设置', async () => {
  const { context, elements } = await require('./helpers/frontend').frontend();
  context.app.connected = true;
  context.acceptProxyConfig(proxySummary(proxy));
  assert.equal(elements.get('#proxyEnabled').checked, true);
  assert.equal(elements.get('#proxyPassword').value, '');
  assert.equal(elements.get('#proxyFields').disabled, false);
  assert.equal(elements.get('#btnProxySave').disabled, true);
  elements.get('#proxyServer').value = 'socks5://127.0.0.1:1080';
  elements.get('#proxyUsername').value = '';
  context.editProxy();
  assert.equal(elements.get('#btnProxySave').disabled, false);
  context.acceptProxyConfig(proxySummary({ ...proxy, enabled: false }));
  assert.equal(elements.get('#proxyServer').value, 'socks5://127.0.0.1:1080');
  assert.equal(context.proxyPayload().server, 'socks5://127.0.0.1:1080');
  context.acceptProxyConfig(proxySummary({ ...proxy, enabled: false }), true);
  assert.equal(elements.get('#proxyFields').disabled, true);
  assert.equal(elements.get('#proxyPassword').value, '');
  assert.equal(elements.get('#btnProxyTest').disabled, true);
});
