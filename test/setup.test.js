const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('../src/store');
const Worker = require('../src/worker');
const { createServer } = require('../src/server');

const email = 'alice@example.test';
const secret = 'BH4OWU3OMXPJ7P63';
const config = { mail: {}, batch: { headless: true, perAccountTimeoutMs: 1000, delayBetweenAccountsMs: 0 } };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-setup-test-'));
  fs.writeFileSync(path.join(dir, 'accounts.txt'), `${email}\nbob@example.test`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store({ dir, accountsFile: path.join(dir, 'accounts.txt'), infoFile: path.join(dir, 'info.json') });
  const worker = new Worker({ store, config });
  const calls = [];
  const readyPassword = value => store.recordPassword(value, { password: 'Fixture12!xx', verifiedAt: new Date().toISOString(), error: null });
  const readyTwofa = value => store.recordTwofa(value, { secret, enabledAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), error: null });
  worker._initializePassword = async value => { calls.push('password:' + value); readyPassword(value); };
  worker._verifyPassword = async value => {
    calls.push('verify-password:' + value);
    if (store.getPassword(value, true)) store.confirmPassword(value);
    store.recordPassword(value, { verifiedAt: new Date().toISOString(), error: null });
  };
  worker._initializeTwofa = async value => { assert.ok(store.getPassword(value)); calls.push('twofa:' + value); readyTwofa(value); };
  worker._verifyTwofa = async value => { calls.push('verify-twofa:' + value); readyTwofa(value); };
  return { store, worker, calls, readyPassword, readyTwofa };
}

test('一键初始化先密码后 2FA，单账号与批量共用队列，已完成账号跳过', async t => {
  const { worker, calls } = fixture(t);
  assert.deepEqual(worker.enqueue([email, 'bob@example.test'], 'setup'), [email, 'bob@example.test']);
  assert.deepEqual(worker.enqueue([email], 'setup'), []);
  await worker.drainPromise;
  assert.deepEqual(calls, [`password:${email}`, `twofa:${email}`, 'password:bob@example.test', 'twofa:bob@example.test']);
  assert.equal(worker.setupComplete(email), true);
  assert.deepEqual(worker.enqueue([email, 'bob@example.test'], 'setup'), []);
});

test('有待确认密码时先核实，已有 2FA 密钥只验证，不生成或覆盖', async t => {
  const { store, worker, calls } = fixture(t);
  store.preparePassword(email, 'Candidate12!');
  store.recordPassword(email, { submittedAt: new Date().toISOString() });
  store.recordTwofa(email, { secret });
  worker.enqueue([email], 'setup');
  await worker.drainPromise;
  assert.deepEqual(calls, [`verify-password:${email}`, `verify-twofa:${email}`]);
  assert.equal(store.getPassword(email), 'Candidate12!');
  assert.equal(store.getTwofaSecret(email), secret);
  assert.equal(worker.setupComplete(email), true);
});

test('单独初始化密码或开通 2FA 只执行对应阶段，已有密码保留', async t => {
  const { store, worker, calls, readyPassword } = fixture(t);
  worker.enqueue([email], 'setup-password');
  await worker.drainPromise;
  assert.equal(store.getTwofaSecret(email), null);
  assert.deepEqual(calls, [`password:${email}`]);
  readyPassword('bob@example.test');
  const password = store.getPassword('bob@example.test');
  worker.enqueue(['bob@example.test'], 'setup-twofa');
  await worker.drainPromise;
  assert.deepEqual(calls, [`password:${email}`, 'twofa:bob@example.test']);
  assert.equal(store.getPassword('bob@example.test'), password);
});

test('仅开通 2FA 可使用邮箱登录资料，不强制初始化密码', async t => {
  const { store, worker, readyTwofa } = fixture(t);
  store.writeAccountRows([{ email, mailUrl: 'https://mail.example.test/inbox' }]);
  worker._initializeTwofa = async value => { assert.equal(store.getPassword(value), undefined); readyTwofa(value); };
  worker.enqueue([email], 'setup-twofa');
  await worker.drainPromise;
  assert.equal(worker.setupComplete(email, 'setup-twofa'), true);
  assert.equal(store.getPassword(email), undefined);
});

test('单账号密码失败不执行 2FA，批量继续后续账号并保留候选', async t => {
  const { store, worker, calls } = fixture(t);
  const initialize = worker._initializePassword;
  worker._initializePassword = async value => {
    if (value !== email) return initialize(value);
    store.preparePassword(value, 'Candidate12!');
    store.recordPassword(value, { submittedAt: new Date().toISOString() });
    throw new Error('模拟密码验证失败');
  };
  worker.enqueue([email, 'bob@example.test'], 'setup');
  await worker.drainPromise;
  assert.equal(store.getPassword(email, true), 'Candidate12!');
  assert.equal(store.getAccount(email).status, 'fail');
  assert.ok(!calls.includes('twofa:' + email));
  assert.equal(worker.setupComplete('bob@example.test'), true);
});

test('2FA 失败保留已完成密码，重试只从 2FA 继续', async t => {
  const { store, worker, calls } = fixture(t);
  worker._initializeTwofa = async value => { store.recordTwofa(value, { secret }); throw new Error('模拟验证器失败'); };
  worker.enqueue([email], 'setup');
  await worker.drainPromise;
  assert.ok(store.getPassword(email));
  assert.ok(store.twofaSummary(email).error);
  worker.enqueue([email], 'setup');
  await worker.drainPromise;
  assert.deepEqual(calls, [`password:${email}`, `verify-twofa:${email}`]);
  assert.equal(worker.setupComplete(email), true);
});

test('初始化 API 校验批量参数，返回真实入队和跳过数量', async t => {
  const { store, worker, readyPassword, readyTwofa } = fixture(t);
  readyPassword(email); readyTwofa(email);
  const server = createServer({ store, worker, config, publicDir: path.join(__dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await worker.stop(); server.closeEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(base + '/api/accounts/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const body of [{}, { emails: [] }, { emails: [1] }, { emails: ['missing@example.test'] }, { emails: [email], mode: 'bad' }]) assert.equal((await post(body)).status, 400);
  const response = await post({ emails: [email, 'BOB@example.test', 'bob@example.test'] });
  assert.equal(response.status, 202);
  const data = await response.json();
  assert.equal(data.queued, 1); assert.equal(data.skipped, 1);
  await worker.drainPromise;
  assert.equal((await (await post({ emails: [email, 'bob@example.test'] })).json()).queued, 0);
});
