const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Store = require('../src/store');
const LoginWorker = require('../src/worker');
const { createServer } = require('../src/server');
const { fetchCode, snapshotMailIds } = require('../src/mailer');

const config = { port: 0, mail: { url: '' }, batch: { headless: true, delayBetweenAccountsMs: 0, perAccountTimeoutMs: 80 } };

test('线程池限制同时执行数，失败不阻断后续任务且不截断总数量', async t => {
  const { store } = fixture(t, Array.from({ length: 7 }, (_, i) => `pool-${i}@example.test`).join('\n'));
  const worker = new LoginWorker({ store, config: { ...config, batch: { ...config.batch, threadPoolSize: 3 } } });
  let active = 0, peak = 0;
  const processed = [];
  worker._runOne = async email => {
    active++; peak = Math.max(peak, active); processed.push(email);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (email === 'pool-1@example.test') throw new Error('fixture failure');
  };
  const emails = [...store.accounts.keys()];
  assert.equal(worker.enqueue(emails).length, 7);
  assert.equal(worker.enqueue(emails).length, 0);
  await worker.drainPromise;
  assert.equal(peak, 3);
  assert.equal(new Set(processed).size, 7);
  assert.equal(worker.inFlight.size, 0);
  assert.equal(worker.running, false);
});

test('关闭服务中止线程池全部在执行任务，不只中止最后一个', async t => {
  const { store } = fixture(t, 'a@example.test\nb@example.test\nc@example.test');
  const worker = new LoginWorker({ store, config: { ...config, batch: { ...config.batch, threadPoolSize: 2, perAccountTimeoutMs: 10000 } } });
  const signals = [];
  worker._loginOne = async (email, task) => {
    signals.push(task.signal);
    await new Promise((resolve, reject) => task.signal.addEventListener('abort', () => reject(task.signal.reason), { once: true }));
  };
  worker.enqueue([...store.accounts.keys()]);
  assert.equal(signals.length, 2);
  await worker.stop();
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(worker.controllers.size, 0);
  assert.equal(worker.queue.length, 0);
});

test('线程池设置校验、空闲限制和持久化保留其他配置', async t => {
  const { store, dir } = fixture(t);
  const original = config.batch.threadPoolSize;
  t.after(() => { config.batch.threadPoolSize = original; });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 3210, batch: { headless: false }, mail: { maxWaitMs: 9000 } }));
  const worker = new LoginWorker({ store, config });
  const base = await service(t, store, worker);
  const save = value => fetch(base + '/api/thread-pool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadPoolSize: value }) });
  for (const value of [0, -1, 11, 1.5, '3', null]) assert.equal((await save(value)).status, 400);
  worker.running = true;
  assert.equal((await save(3)).status, 409);
  worker.running = false;
  assert.equal((await save(3)).status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.batch.threadPoolSize, 3);
  assert.equal(saved.batch.headless, false);
  assert.equal(saved.mail.maxWaitMs, 9000);
  assert.equal((await (await fetch(base + '/api/config')).json()).batch.threadPoolSize, 3);
});

function fixture(t, content = 'alice@example.test----https://mail.example.test/a\nbob@example.test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-login-test-'));
  const accountsFile = path.join(dir, 'accounts.txt');
  const infoFile = path.join(dir, 'info.json');
  fs.writeFileSync(accountsFile, content);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store({ dir, accountsFile, infoFile });
  return { dir, accountsFile, infoFile, store };
}

async function service(t, store, worker) {
  const server = createServer({ store, worker, config, publicDir: path.join(__dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await worker.stop();
    server.closeEvents();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function post(base, route, body, headers = {}) {
  return fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

test('账号保存校验、去重、删除和清空地址同步，保留已保存会话', t => {
  const { store, accountsFile } = fixture(t);
  store.saveInfo('alice@example.test', { accessToken: 'test-token' });
  assert.equal(store.writeAccountsFile('# comment\nAlice@example.test----https://mail.example.test/first\nalice@example.test\n'), 1);
  assert.equal(store.accounts.size, 1);
  assert.equal(store.accounts.get('alice@example.test').mailUrl, '');
  const saved = fs.readFileSync(accountsFile, 'utf8');
  assert.throws(() => store.writeAccountsFile('not-an-email'), /第 1 行/);
  assert.throws(() => store.writeAccountsFile('alice@example.test----javascript:alert(1)'), /http/);
  assert.throws(() => store.writeAccountsFile(null), /文本/);
  assert.equal(fs.readFileSync(accountsFile, 'utf8'), saved);
  store.writeAccountsFile('bob@example.test');
  assert.deepEqual([...store.accounts.keys()], ['bob@example.test']);
  assert.equal(store.infoStore.get('alice@example.test').accessToken, 'test-token');
});

test('重启恢复有效和过期会话，持久化文件权限正确', t => {
  const f = fixture(t);
  f.store.saveInfo('alice@example.test', { accessToken: 'valid', expires: '2099-01-01T00:00:00Z' });
  f.store.saveInfo('bob@example.test', { accessToken: 'expired', expires: '2000-01-01T00:00:00Z' });
  f.store.saveProfile('alice@example.test', { cookies: [], origins: [] });
  let event;
  f.store.subscribe(value => { event = value; });
  f.store.setStatus('alice@example.test', 'running', { stage: '校验旧会话' });
  assert.equal(Object.hasOwn(event, 'info'), false);
  f.store.setStatus('alice@example.test', 'ok', { info: f.store.infoStore.get('alice@example.test') });
  assert.equal(event.info.accessToken, 'valid');
  const recovered = new Store(f);
  assert.deepEqual(recovered.listAccounts().map(a => a.status), ['ok', 'expired']);
  assert.equal(fs.statSync(f.infoFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.store.profilePath('alice@example.test')).mode & 0o777, 0o600);
});

test('Token 的 JWT 到期时间优先于较晚的 Session 有效期', t => {
  const f = fixture(t);
  const token = exp => `fixture.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
  f.store.saveInfo('alice@example.test', { accessToken: token(946684800), expires: '2099-01-01T00:00:00Z' });
  f.store.saveInfo('bob@example.test', { accessToken: token(4102444800), expires: '2099-01-01T00:00:00Z' });
  const recovered = new Store(f);
  const [alice, bob] = recovered.listAccounts();
  assert.equal(alice.status, 'expired');
  assert.equal(alice.tokenExpires, '2000-01-01T00:00:00.000Z');
  assert.equal(bob.tokenExpires, '2099-01-01T00:00:00Z');
  assert.equal(recovered.infoExpires({ accessToken: 'opaque-token', expires: '2099-01-01T00:00:00Z' }), '2099-01-01T00:00:00Z');
  assert.equal(recovered.infoExpires({ accessToken: 'opaque-token' }), '');
});

test('损坏的会话库不会被覆盖；写入失败回滚内存状态', t => {
  const f = fixture(t);
  f.store.saveInfo('alice@example.test', { accessToken: 'original' });
  const saved = fs.readFileSync(f.infoFile, 'utf8');
  f.store.infoFile = path.join(f.dir, 'missing', 'info.json');
  assert.throws(() => f.store.saveInfo('alice@example.test', { accessToken: 'replacement' }));
  assert.equal(f.store.infoStore.get('alice@example.test').accessToken, 'original');
  assert.equal(fs.readFileSync(f.infoFile, 'utf8'), saved);
  fs.writeFileSync(f.infoFile, '{broken');
  assert.throws(() => new Store(f));
  assert.equal(fs.readFileSync(f.infoFile, 'utf8'), '{broken');
});

test('队列不重复计数，清空等待任务保留当前任务', async t => {
  const { store } = fixture(t);
  const worker = new LoginWorker({ store, config });
  let release;
  worker._loginOne = async (email, task) => {
    store.setStatus(email, 'running', { error: null });
    await new Promise(resolve => { release = resolve; });
    task.signal.throwIfAborted();
  };
  assert.equal(worker.enqueue(['alice@example.test', 'bob@example.test']).length, 2);
  assert.equal(worker.enqueue(['alice@example.test', 'bob@example.test']).length, 0);
  assert.equal(worker.clearQueue(), 1);
  assert.deepEqual(worker.getState().inFlight, ['alice@example.test']);
  assert.equal(store.accounts.get('bob@example.test').status, 'idle');
  release();
  await worker.drainPromise;
  assert.equal(worker.running, false);
});

test('单账号超时关闭上下文，并继续后续账号', async t => {
  const { store } = fixture(t);
  const worker = new LoginWorker({ store, config });
  let closed = 0;
  worker._loginOne = async (email, task) => {
    store.setStatus(email, 'running');
    if (email.startsWith('alice')) {
      task.contexts.add({ close: async () => { closed++; } });
      await new Promise(() => {});
    } else store.setStatus(email, 'idle');
  };
  worker.enqueue(['alice@example.test', 'bob@example.test']);
  await worker.drainPromise;
  assert.equal(closed, 1);
  assert.equal(store.accounts.get('alice@example.test').status, 'fail');
  assert.match(store.accounts.get('alice@example.test').error, /超时/);
  assert.equal(store.accounts.get('bob@example.test').status, 'idle');
  assert.equal(worker.running, false);
  assert.deepEqual(worker.getState().inFlight, []);
});

test('服务关闭中止当前任务，清空队列并拒绝新任务', async t => {
  const { store } = fixture(t);
  const worker = new LoginWorker({ store, config });
  worker._loginOne = async () => new Promise(() => {});
  worker.enqueue(['alice@example.test', 'bob@example.test']);
  await worker.stop();
  assert.equal(worker.running, false);
  assert.equal(worker.queue.length, 0);
  assert.throws(() => worker.enqueue(['bob@example.test']), /关闭/);
});

test('HTTP 非法请求不会中断服务，限制来源、方法和请求体', async t => {
  const { store } = fixture(t);
  const worker = new LoginWorker({ store, config });
  const base = await service(t, store, worker);
  assert.equal((await post(base, '/api/login', '{invalid')).status, 400);
  assert.equal((await post(base, '/api/login', 'null')).status, 400);
  assert.equal((await post(base, '/api/login-batch', { emails: [123] })).status, 400);
  assert.equal((await post(base, '/api/login', { email: 'unknown@example.test' })).status, 400);
  assert.equal((await post(base, '/api/login', { email: 'alice@example.test' }, { Origin: 'https://untrusted.example.test' })).status, 403);
  assert.equal((await post(base, '/api/login', { email: 'alice@example.test' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post(base, '/api/accounts', {})).status, 405);
  assert.equal((await post(base, '/api/accounts-file', 'x'.repeat(1024 * 1024 + 1))).status, 413);
  const healthy = await fetch(base + '/api/accounts');
  assert.equal(healthy.status, 200);
  assert.equal(healthy.headers.get('cache-control'), 'no-store');
  assert.equal(healthy.headers.get('access-control-allow-origin'), null);
  assert.equal((await healthy.json()).length, 2);
  assert.equal((await fetch(base + '/info.json')).status, 404);
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/accounts', { headers: { Host: 'untrusted.example.test' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal(worker.running, false);
});

test('HTTP 批量入队返回实际数量，运行期间不允许覆盖账号列表', async t => {
  const { store, accountsFile } = fixture(t);
  const worker = new LoginWorker({ store, config: { ...config, batch: { ...config.batch, perAccountTimeoutMs: 3000 } } });
  worker._loginOne = async () => new Promise(() => {});
  const base = await service(t, store, worker);
  let response = await post(base, '/api/login-batch', { emails: ['ALICE@example.test', 'bob@example.test', 'bob@example.test'] });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).queued, 2);
  response = await post(base, '/api/login-batch', { emails: ['alice@example.test', 'bob@example.test'] });
  assert.equal((await response.json()).queued, 0);
  const before = fs.readFileSync(accountsFile, 'utf8');
  assert.equal((await post(base, '/api/accounts-file', { content: 'new@example.test' })).status, 409);
  assert.equal(fs.readFileSync(accountsFile, 'utf8'), before);
  assert.equal((await (await post(base, '/api/queue/clear', {})).json()).cleared, 1);
});

test('SSE 每次连接提供完整快照，保存列表后推送最新账号', async t => {
  const { store } = fixture(t);
  const worker = new LoginWorker({ store, config });
  const base = await service(t, store, worker);
  for (const expectedCount of [2, 1]) {
    const abort = new AbortController();
    const response = await fetch(base + '/api/events', { signal: abort.signal });
    const reader = response.body.getReader();
    const data = new TextDecoder().decode((await reader.read()).value);
    const snapshot = JSON.parse(data.split('data: ')[1].split('\n\n')[0]);
    assert.equal(snapshot.type, 'snapshot');
    assert.equal(snapshot.headless, true);
    assert.equal(snapshot.accounts.length, expectedCount);
    if (expectedCount === 2) {
      store.writeAccountsFile('alice@example.test');
      const change = new TextDecoder().decode((await reader.read()).value);
      assert.equal(JSON.parse(change.split('data: ')[1].split('\n\n')[0]).type, 'accounts');
    }
    abort.abort();
    await reader.cancel().catch(() => {});
  }
});

test('页面、脚本、样式和图标均可读取，未知路径不暴露本地文件', async t => {
  const { store } = fixture(t);
  const worker = new LoginWorker({ store, config });
  const base = await service(t, store, worker);
  for (const [route, mime] of [['/', 'text/html'], ['/app.mjs', 'text/javascript'], ['/styles.css', 'text/css'], ['/favicon.svg', 'image/svg+xml']]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(mime));
    assert.ok((await response.text()).length > 0);
    assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
  }
  assert.equal((await fetch(base + '/src/store.js')).status, 404);
  assert.equal((await fetch(base + '/profiles/unknown.json')).status, 404);
});

function mailbox(rounds) {
  let round = -1;
  let closed = false;
  const page = {
    goto: async () => { round++; if (rounds[Math.min(round, rounds.length - 1)] instanceof Error) throw rounds[round]; },
    waitForSelector: async () => {},
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 1))),
    isClosed: () => closed,
    close: async () => { closed = true; },
    $$eval: async (selector, fn) => fn(rounds[Math.min(round, rounds.length - 1)].map(mail => ({
      getAttribute: () => mail.id || '',
      querySelector: selector => selector === 'time' ? { getAttribute: () => mail.time || new Date().toISOString(), textContent: mail.time || '' } :
        { textContent: selector.includes('strong') ? 'Your temporary ChatGPT login code' : 'noreply@openai.com' },
    }))),
    locator: () => ({ nth: idx => ({
      locator: () => ({ first: () => ({ count: async () => 1, getAttribute: async () => 'true', click: async () => {} }) }),
      textContent: async () => rounds[Math.min(round, rounds.length - 1)][idx].text,
    }) }),
  };
  return { context: { newPage: async () => page }, closed: () => closed };
}

const mailOpts = { url: 'https://mail.example.test/a', toEmail: 'alice@example.test', freshAfterMs: Date.now(), pageLoadWaitMs: 0, pollIntervalMs: 1, maxWaitMs: 200, snapshotBaseline: false };

test('提交前的空基线仍能接收首次轮询前已经送达的新验证码', async () => {
  const baseline = mailbox([[]]);
  const seenIds = await snapshotMailIds(baseline.context, mailOpts);
  assert.equal(seenIds.size, 0);
  assert.equal(baseline.closed(), true);
  const delivered = mailbox([[{ id: 'new', text: 'To: alice@example.test Code: 062198' }]]);
  assert.equal(await fetchCode(delivered.context, { ...mailOpts, seenIds }), '062198');
  assert.equal(delivered.closed(), true);
});

test('跳过旧码和错误收件人，正文加载后仍能读取同一新邮件', async () => {
  const old = { id: 'old', text: 'alice@example.test Code: 111111' };
  const wrong = { id: 'wrong', text: 'joalice@example.test Code: 222222' };
  const loading = { id: 'fresh', text: 'Loading...' };
  const loaded = { id: 'fresh', text: 'To: ALICE@example.test Code: 333333' };
  const inbox = mailbox([[loading, wrong, old], [loaded, wrong, old]]);
  const seenIds = new Set(['old']);
  assert.equal(await fetchCode(inbox.context, { ...mailOpts, seenIds }), '333333');
  assert.deepEqual([...seenIds].sort(), ['fresh', 'old']);
});

test('取件网络错误可重试，无法读取时释放页面并明确超时', async () => {
  const retry = mailbox([new Error('temporary network failure'), [{ id: 'new', text: 'alice@example.test 444444' }]]);
  assert.equal(await fetchCode(retry.context, mailOpts), '444444');
  const empty = mailbox([[]]);
  await assert.rejects(fetchCode(empty.context, { ...mailOpts, maxWaitMs: 10 }), /超时/);
  assert.equal(empty.closed(), true);
});
