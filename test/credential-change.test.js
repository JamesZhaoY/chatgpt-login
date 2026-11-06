const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Store = require('../src/store');
const Worker = require('../src/worker');
const { enableTwofa } = require('../src/twofa');
const { createServer } = require('../src/server');

const email = 'alice+1@example.test';
const oldSecret = 'BH4OWU3OMXPJ7P63';
const newSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const password = ' Fixture12!xx ';
const config = { mail: {}, batch: { headless: true, perAccountTimeoutMs: 2000, delayBetweenAccountsMs: 0 } };
const task = () => ({ signal: new AbortController().signal, contexts: new Set() });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-credentials-test-'));
  const options = { dir, accountsFile: path.join(dir, 'accounts.txt'), infoFile: path.join(dir, 'info.json') };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(options);
  store.writeAccountsFile(email);
  return { store, options };
}

test('四字段保存密码和密钥，敏感值不进入账号文本、列表或事件；空字段保留凭据', t => {
  const { store, options } = fixture(t);
  const events = [];
  store.subscribe(value => events.push(value));
  store.writeAccountRows([{ email, mailUrl: '', password, totpSecret: oldSecret }]);
  assert.equal(store.getPassword(email), password);
  assert.equal(store.loginMethod(email), 'password-totp');
  assert.equal(store.twofaSummary(email).verifiedAt, null);
  store.recordPassword(email, { verifiedAt: '2026-10-16T00:00:00Z' });
  store.recordTwofa(email, { enabledAt: '2026-10-16T00:00:00Z', verifiedAt: '2026-10-16T00:00:00Z' });
  store.writeAccountRows([{ email, mailUrl: 'https://mail.example.test/inbox', password: '', totpSecret: '' }]);
  store.writeAccountRows([{ email, password, totpSecret: oldSecret }]);
  const recovered = new Store(options);
  assert.equal(recovered.getPassword(email), password);
  assert.equal(recovered.getTwofaSecret(email), oldSecret);
  assert.ok(recovered.passwordSummary(email).verifiedAt);
  assert.ok(recovered.twofaSummary(email).verifiedAt);
  for (const value of [JSON.stringify(events), JSON.stringify(store.listAccounts()), fs.readFileSync(store.accountsFile, 'utf8')]) {
    assert.ok(!value.includes(password)); assert.ok(!value.includes(oldSecret));
  }
  assert.equal(fs.statSync(store.passwordsFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(store.twofaFile).mode & 0o777, 0o600);
});

test('表单校验、跨文件写入失败不覆盖凭据；保存空密钥也保留旧文本导入的密钥', t => {
  const { store, options } = fixture(t);
  store.writeAccountsFile(`${email}----https://mail.example.test/inbox----${oldSecret}`);
  store.writeAccountRows([{ email, password, totpSecret: '' }]);
  assert.equal(store.getTwofaSecret(email), oldSecret);
  const files = [store.accountsFile, store.passwordsFile, store.twofaFile];
  const before = files.map(file => fs.readFileSync(file, 'utf8'));
  for (const patch of [{ password: '\n' }, { password: 4 }, { password: '   ' }, { totpSecret: '123456' }, { totpSecret: oldSecret + '\n' + oldSecret }, { mailUrl: 'file:///tmp/mail' }]) {
    assert.throws(() => store.writeAccountRows([{ email, password, ...patch }]));
  }
  store.accountsFile = path.join(store.dir, 'missing', 'accounts.txt');
  assert.throws(() => store.writeAccountRows([{ email, password: 'Changed12!xx', totpSecret: newSecret }]));
  store.accountsFile = options.accountsFile;
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), before);
  assert.equal(store.getPassword(email), password);
  assert.equal(store.getTwofaSecret(email), oldSecret);
  assert.equal(new Store(options).getTwofaSecret(email), oldSecret);
});

test('待确认凭据禁止表单覆盖；明确输入当前新凭据后重置验证状态', t => {
  const { store } = fixture(t);
  store.writeAccountRows([{ email, password, totpSecret: oldSecret }]);
  store.recordPassword(email, { verifiedAt: 'verified' });
  store.recordTwofa(email, { enabledAt: 'enabled', verifiedAt: 'verified' });
  store.writeAccountRows([{ email, password: 'Updated12!xx', totpSecret: newSecret }]);
  assert.equal(store.passwordSummary(email).verifiedAt, null);
  assert.equal(store.twofaSummary(email).verifiedAt, null);
  store.preparePassword(email, password); store.recordPassword(email, { submittedAt: 'submitted' });
  assert.throws(() => store.writeAccountRows([{ email, password: 'Third12!xxxx' }]), /待确认/);
  store.beginTwofaRotation(email); store.prepareTwofaRotation(email, oldSecret);
  assert.throws(() => store.writeAccountRows([{ email, totpSecret: oldSecret }]), /尚未确认/);
});

test('登录按密码、邮箱和会话分流，保留别名，2FA 不单独作为登录凭据', async t => {
  const { store } = fixture(t);
  const worker = new Worker({ store, config });
  const routes = [];
  worker._verifyPassword = async (value, current, candidate, requireTotp) => { routes.push('password'); assert.equal(value, email); assert.ok(!requireTotp); };
  worker._loginWithEmail = async value => { routes.push('email'); assert.equal(value, email); };
  await assert.rejects(worker._loginOne(email, task()), /密码或取件地址/);
  store.recordTwofa(email, { secret: oldSecret });
  await assert.rejects(worker._loginOne(email, task()), /不能单独/);
  store.writeAccountRows([{ email, mailUrl: 'https://mail.example.test/inbox' }]);
  assert.equal(store.loginMethod(email), 'email-totp');
  await worker._loginOne(email, task());
  store.twofa.delete(email);
  assert.equal(store.loginMethod(email), 'email');
  await worker._loginOne(email, task());
  store.recordPassword(email, { password });
  assert.equal(store.loginMethod(email), 'password');
  await worker._loginOne(email, task());
  store.recordTwofa(email, { secret: oldSecret });
  assert.equal(store.loginMethod(email), 'password-totp');
  await worker._loginOne(email, task());
  assert.deepEqual(routes, ['email', 'email', 'password', 'password']);
  store.passwords.delete(email); store.accounts.get(email).mailUrl = '';
  store.saveProfile(email, { cookies: [], origins: [] });
  assert.equal(store.loginMethod(email), 'session');
});

test('2FA 更换保留旧值和待确认值，迁移导入列，重启后确认新值不会被旧导入覆盖', t => {
  const { store, options } = fixture(t);
  store.writeAccountsFile(`${email}----https://mail.example.test/inbox----${oldSecret}`);
  store.saveImportedTwofa(email);
  store.recordTwofa(email, { enabledAt: 'enabled', verifiedAt: 'verified' });
  store.beginTwofaRotation(email);
  store.prepareTwofaRotation(email, newSecret);
  assert.throws(() => store.confirmTwofaRotation(email), /没有已提交/);
  assert.equal(store.twofaSummary(email).verifiedAt, null);
  assert.equal(store.twofaSummary(email).enabled, false);
  store.recordTwofa(email, { pendingSubmittedAt: 'submitted', error: '连接中断' });
  const recovered = new Store(options);
  assert.equal(recovered.getTwofaSecret(email), oldSecret);
  assert.equal(recovered.getTwofaSecret(email, true), newSecret);
  recovered.confirmTwofaRotation(email);
  assert.equal(new Store(options).getTwofaSecret(email), newSecret);
  assert.equal(recovered.twofa.get(email).previousSecret, oldSecret);
  assert.equal(recovered.twofaSummary(email).rotating, false);
  assert.ok(recovered.twofaSummary(email).verifiedAt);
  assert.equal(recovered.saveImportedTwofa(email), false);
  assert.ok(!fs.readFileSync(store.accountsFile, 'utf8').includes(oldSecret));
});

// 可见页面状态模型：确认关闭 → 旧 TOTP → 关闭 → 新密钥 → 官网启用。
function securityPage(store, { fail = '', on = true } = {}) {
  let checked = on;
  let view = 'settings';
  const history = [];
  const page = {
    history,
    url: () => 'https://chatgpt.com/settings/security',
    goto: async () => { view = 'settings'; history.push('read-settings'); },
    waitForTimeout: async () => {},
    getByRole: (role, options = {}) => role === 'heading' ? { heading: options.name }
      : loc(role === 'switch' ? 'toggle' : role === 'dialog' || role === 'alertdialog' ? 'modal' : options.name?.test('Not now') ? 'backup' : 'submit'),
    locator: selector => loc(selector === 'body' ? 'body' : selector.startsWith('button') ? 'submit' : selector.includes('type="password"') ? 'password' : 'otp'),
  };
  const visible = kind => kind === 'toggle' ? view === 'settings' : kind === 'modal' ? ['confirm', 'identity', 'binding'].includes(view)
    : kind === 'confirm' || kind === 'binding' ? kind === view : kind === 'otp' ? ['identity', 'binding'].includes(view) : false;
  function loc(kind) {
    return {
      first() { return this; }, last() { return this; }, or() { return this; },
      filter({ has }) { return loc(has.heading.test('Connect your authenticator app') ? 'binding' : 'confirm'); },
      getByRole(role, { name }) { return loc(name.test("Can't scan? Enter key manually") ? 'manual' : kind === 'binding' ? name.test('Verify') ? 'bind' : 'new-code' : 'confirm-disable'); },
      locator: selector => loc(selector === 'code' ? 'key' : 'alert'),
      isVisible: async () => visible(kind),
      getAttribute: async () => String(checked),
      innerText: async () => kind === 'key' ? newSecret : kind === 'alert' ? 'fixture rejection' : view === 'identity' ? 'Enter the code from your authenticator app' : 'Turn off authenticator app',
      waitFor: async ({ state }) => { if ((state === 'hidden') === visible(kind)) throw new Error('fixture state mismatch'); },
      fill: async code => { assert.match(code, /^\d{6}$/); history.push('fill:' + kind); },
      click: async () => {
        history.push('click:' + kind);
        if (kind === 'toggle') {
          assert.ok(store.twofaSummary(email).rotating);
          view = checked ? 'confirm' : 'binding';
        } else if (kind === 'confirm-disable') {
          if (fail === 'disable') throw new Error('fixture disable failed');
          view = 'identity';
        } else if (kind === 'submit') { checked = false; view = 'settings'; }
        else if (kind === 'bind') {
          const disk = JSON.parse(fs.readFileSync(store.twofaFile, 'utf8'))[email];
          assert.equal(disk.secret, oldSecret); assert.equal(disk.pendingSecret, newSecret); assert.ok(disk.pendingSubmittedAt);
          checked = true; view = 'settings';
          if (fail === 'bind') throw new Error('fixture disconnected after submit');
        }
      },
    };
  }
  return page;
}

function rotate(store, page, verifyLogin) {
  return enableTwofa({ page, context: null, email, mail: {}, store, signal: new AbortController().signal,
    log: () => {}, stage: () => {}, replace: true, verifyLogin });
}

test('官网更换流实际关闭、验证旧密钥、绑定新密钥；新登录之前不覆盖旧值', async t => {
  const { store } = fixture(t);
  store.writeAccountRows([{ email, password, totpSecret: oldSecret }]);
  const page = securityPage(store);
  await rotate(store, page, async () => {
    assert.equal(store.getTwofaSecret(email), oldSecret);
    assert.equal(store.getTwofaSecret(email, true), newSecret);
    assert.ok(store.twofa.get(email).pendingEnabledAt);
    store.confirmTwofaRotation(email);
  });
  assert.equal(page.history.filter(value => value === 'click:toggle').length, 2);
  assert.ok(page.history.includes('click:confirm-disable'));
  assert.ok(page.history.includes('fill:otp'));
  assert.equal(store.getTwofaSecret(email), newSecret);
  assert.ok(!fs.readdirSync(store.dir).some(file => /png|jpg|svg/.test(file)));
});

test('关闭失败、提交中断、新登录失败均不虚报成功，旧密钥和已读取的新密钥可恢复', async t => {
  for (const fail of ['disable', 'bind', 'login']) {
    const { store, options } = fixture(t);
    store.writeAccountRows([{ email, password, totpSecret: oldSecret }]);
    await assert.rejects(rotate(store, securityPage(store, { fail }), async () => { throw new Error('fixture login failed'); }), /fixture/);
    const recovered = new Store(options);
    assert.equal(recovered.getTwofaSecret(email), oldSecret);
    assert.equal(recovered.twofaSummary(email).verifiedAt, null);
    assert.equal(recovered.getTwofaSecret(email, true), fail === 'disable' ? null : newSecret);
    assert.equal(recovered.twofaSummary(email).rotating, true);
  }
});

test('中断后官网已开启新绑定则只验证；官网关闭则重新绑定并保留上一候选', async t => {
  for (const on of [true, false]) {
    const { store } = fixture(t);
    store.writeAccountRows([{ email, password, totpSecret: oldSecret }]);
    store.beginTwofaRotation(email); store.prepareTwofaRotation(email, newSecret);
    store.recordTwofa(email, { pendingSubmittedAt: 'submitted', rotationDisabledAt: 'disabled' });
    const page = securityPage(store, { on });
    await rotate(store, page, async () => store.confirmTwofaRotation(email));
    assert.equal(page.history.filter(value => value === 'click:toggle').length, on ? 0 : 1);
    assert.equal(store.getTwofaSecret(email), newSecret);
    if (!on) assert.equal(store.twofa.get(email).supersededSecret, newSecret);
  }
});

test('worker 只有通过新密钥的 TOTP 才确认更换，密码登录无挑战时保留待确认状态', async t => {
  const { store } = fixture(t);
  store.writeAccountRows([{ email, password, totpSecret: oldSecret }]);
  store.beginTwofaRotation(email); store.prepareTwofaRotation(email, newSecret);
  store.recordTwofa(email, { pendingSubmittedAt: 'submitted' });
  const filename = require.resolve('../src/worker');
  const load = createRequire(filename);
  const moduleMock = { exports: {} };
  let challenged = false;
  let contexts = 0;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: moduleMock, require: name => name === './browser' ? {
    getBrowser: async () => ({}), newContext: async (browser, extra) => {
      assert.equal(extra.storageState, undefined); contexts++;
      return { newPage: async () => ({}), storageState: async () => ({ cookies: [], origins: [] }), close: async () => {} };
    },
  } : name === './password' ? { ...load(name), verifyPasswordLogin: async options => {
    assert.equal(options.password, password); assert.equal(options.totpSecret, newSecret);
    if (options.requireTotp && !challenged) throw new Error('本次未出现验证器挑战');
    return { email, accessToken: 'fixture-token', raw: JSON.stringify({ user: { email } }), totpVerified: challenged };
  } } : load(name) });
  const worker = new moduleMock.exports({ store, config });
  await worker._loginOne(email, task());
  assert.equal(store.getTwofaSecret(email), oldSecret);
  assert.equal(store.twofaSummary(email).rotating, true);
  await assert.rejects(worker._verifyTwofa(email, task()), /未出现验证器挑战/);
  challenged = true;
  await worker._verifyTwofa(email, task());
  assert.equal(store.getTwofaSecret(email), newSecret);
  assert.equal(store.twofaSummary(email).rotating, false);
  assert.equal(contexts, 3);
  assert.equal(store.infoStore.get(email).totpVerified, undefined);
});

test('官网修改 API 与原队列互斥，校验凭据，待确认新密钥可单独复制', async t => {
  const { store } = fixture(t);
  const worker = new Worker({ store, config });
  const calls = [];
  let release;
  worker._initializePassword = async value => { calls.push(['password', value]); };
  worker._replaceTwofa = async value => { calls.push(['twofa-replace', value]); await new Promise(resolve => { release = resolve; }); };
  const server = createServer({ store, worker, config, publicDir: path.join(__dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release?.(); await worker.stop(); server.closeEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body = { email }, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/twofa/replace')).status, 400);
  assert.equal((await post('/api/accounts-file', { accounts: [{ email, password, totpSecret: oldSecret }] })).status, 200);
  assert.equal((await post('/api/password/change', { email: 'unknown@example.test' })).status, 400);
  assert.equal((await post('/api/password/change')).status, 202);
  await worker.drainPromise;
  assert.equal((await post('/api/twofa/replace', { email }, { Origin: 'https://other.example.test' })).status, 403);
  assert.equal((await post('/api/twofa/replace')).status, 202);
  assert.equal((await (await post('/api/twofa/replace')).json()).queued, 0);
  assert.equal((await post('/api/accounts-file', { accounts: [] })).status, 409);
  release(); await worker.drainPromise;
  assert.deepEqual(calls, [['password', email], ['twofa-replace', email]]);
  store.beginTwofaRotation(email); store.prepareTwofaRotation(email, newSecret);
  const pending = await (await fetch(base + `/api/twofa?email=${encodeURIComponent(email)}&pending=1`)).json();
  assert.equal(pending.secret, newSecret); assert.match(pending.code, /^\d{6}$/);
  const saved = await (await fetch(base + '/api/accounts-file')).json();
  assert.ok(!JSON.stringify(saved).includes(password)); assert.ok(!JSON.stringify(saved).includes(oldSecret));
});
