const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeSecret, generateTotp, freshTotp } = require('../src/totp');
const Store = require('../src/store');
const Worker = require('../src/worker');
const { createServer } = require('../src/server');
const { enableTwofa } = require('../src/twofa');

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const email = 'alice@example.test';
const config = { port: 0, mail: {}, batch: { headless: true, perAccountTimeoutMs: 2000, delayBetweenAccountsMs: 0 } };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-twofa-test-'));
  const options = { dir, accountsFile: path.join(dir, 'accounts.txt'), infoFile: path.join(dir, 'info.json') };
  fs.writeFileSync(options.accountsFile, email);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { options, store: new Store(options) };
}

test('TOTP 与 RFC 6238 的全部 SHA-1 测试向量一致，保留前导零', () => {
  for (const [time, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(generateTotp(secret, { now: time * 1000, digits: 8 }).code, expected);
    assert.equal(generateTotp(secret, { now: time * 1000 }).code, expected.slice(-6));
  }
  assert.equal(generateTotp(secret, { now: 59000 }).remaining, 1);
  assert.equal(generateTotp(secret, { now: 60000 }).remaining, 30);
});

test('校验 Base32 格式，规范化空格和大小写，拒绝错误参数', () => {
  assert.equal(normalizeSecret('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), secret);
  for (const value of ['', '1234567890123456', 'invalid%key', 'A'.repeat(17), null]) assert.throws(() => normalizeSecret(value));
  assert.throws(() => generateTotp(secret, { now: -1 }));
  assert.throws(() => generateTotp(secret, { digits: 7 }));
  assert.throws(() => generateTotp(secret, { period: 60 }));
});

test('临近过期时等待下一窗口，避免提交即将失效的验证码', async () => {
  const realNow = Date.now;
  let now = 59000;
  let waited = 0;
  Date.now = () => now;
  try {
    const code = await freshTotp(secret, { waitForTimeout: async ms => { waited = ms; now += ms; } }, new AbortController().signal);
    assert.equal(waited, 1200);
    assert.equal(code, generateTotp(secret, { now }).code);
  } finally { Date.now = realNow; }
});

test('密钥独立持久化且不出现在列表和事件中，不生成二维码文件', t => {
  const { store, options } = fixture(t);
  const events = [];
  store.subscribe(event => events.push(event));
  store.recordTwofa(email, { secret, preparedAt: new Date().toISOString() });
  assert.equal(store.twofaSummary(email).pending, true);
  assert.equal(new Store(options).getTwofaSecret(email), secret);
  assert.equal(fs.statSync(store.twofaFile).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(events).includes(secret));
  assert.ok(!JSON.stringify(store.listAccounts()).includes(secret));
  assert.deepEqual(fs.readdirSync(options.dir).sort(), ['accounts.txt', 'twofa.json']);
  assert.throws(() => store.recordTwofa(email, { secret: 'BH4OWU3OMXPJ7P63' }), /不能覆盖/);
  store.recordTwofa(email, { enabledAt: new Date().toISOString(), verifiedAt: new Date().toISOString() });
  assert.equal(new Store(options).twofaSummary(email).enabled, true);
});

test('密钥写入失败回滚内存，验证失败仍保留候选密钥', t => {
  const { store } = fixture(t);
  const file = store.twofaFile;
  store.twofaFile = path.join(store.dir, 'missing', 'twofa.json');
  assert.throws(() => store.recordTwofa(email, { secret }));
  assert.equal(store.getTwofaSecret(email), null);
  store.twofaFile = file;
  store.recordTwofa(email, { secret });
  store.recordTwofa(email, { error: '验证器验证码未通过' });
  assert.equal(store.getTwofaSecret(email), secret);
  assert.equal(store.twofaSummary(email).enabled, false);
});

test('已有 2FA 密钥时禁止重复绑定，不触碰外部页面', async t => {
  const { store } = fixture(t);
  store.recordTwofa(email, { secret });
  await assert.rejects(enableTwofa({ store, email, page: null }), /不要重复绑定/);
});

test('2FA API 验证账号与密码、限制同源、按需读取密钥和验证码', async t => {
  const { store } = fixture(t);
  const worker = new Worker({ store, config });
  let initialized = 0;
  let verified = 0;
  worker._initializeTwofa = async () => { initialized++; store.recordTwofa(email, { secret }); };
  worker._verifyTwofa = async () => { verified++; store.recordTwofa(email, { enabledAt: new Date().toISOString(), verifiedAt: new Date().toISOString() }); };
  const server = createServer({ store, worker, config, publicDir: path.join(__dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await worker.stop(); server.closeEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, account = email) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: account }) });
  assert.equal((await post('/api/twofa/init')).status, 400);
  store.recordPassword(email, { password: 'New12!xyzABC' });
  assert.equal((await post('/api/twofa/init', 'missing@example.test')).status, 400);
  assert.equal((await post('/api/twofa/verify')).status, 400);
  assert.equal((await post('/api/twofa/init')).status, 202);
  await worker.drainPromise;
  assert.equal(initialized, 1);
  assert.equal((await post('/api/twofa/init')).status, 409);
  assert.equal((await post('/api/twofa/verify')).status, 202);
  await worker.drainPromise;
  assert.equal(verified, 1);
  const response = await fetch(base + '/api/twofa?email=' + email);
  const data = await response.json();
  assert.equal(data.secret, secret);
  assert.match(data.code, /^\d{6}$/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + '/api/twofa?email=' + email, { headers: { Origin: 'https://other.example.test' } })).status, 403);
  assert.equal((await fetch(base + '/twofa.json')).status, 404);
});
