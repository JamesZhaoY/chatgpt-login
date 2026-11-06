const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('../src/store');
const { createServer } = require('../src/server');

// 此文件的登录使用模拟页面，禁止启动真实浏览器或访问真实邮箱。
const browserModule = require('../src/browser');
const originalGetBrowser = browserModule.getBrowser;
browserModule.getBrowser = async () => ({});
const Worker = require('../src/worker');
browserModule.getBrowser = originalGetBrowser;

const email = 'alice+1@icloud.com';
const mailUrl = 'https://mail.example.test/inbox/alice';
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const line = `${email}----${mailUrl}----${secret}`;
const config = { port: 0, mail: { pageLoadWaitMs: 0 }, batch: { headless: true, perAccountTimeoutMs: 2000, delayBetweenAccountsMs: 0 } };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-account-import-'));
  const options = { dir, accountsFile: path.join(dir, 'accounts.txt'), infoFile: path.join(dir, 'info.json') };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { options, store: new Store(options) };
}

test('两段与三段混合导入、别名、换行及密钥规范化，第三段不进入取件地址', t => {
  const { store, options } = fixture(t);
  const rows = [` ALICE+1@icloud.com ---- ${mailUrl} ---- gezd-gnbv gy3t qojq gezd gnbv gy3t qojq `, 'bob@example.test----https://mail.example.test/b'];
  const expected = [{ email, mailUrl, totpSecret: secret }, { email: 'bob@example.test', mailUrl: 'https://mail.example.test/b' }];
  for (const newline of ['\n', '\r\n', '\r', '\\n', '\\r\\n', '\u2028']) {
    assert.deepEqual(store.parseAccounts(rows.join(newline)), expected);
    assert.equal(store.writeAccountsFile(rows.join(newline)), 2);
    assert.deepEqual(new Store(options).parseAccountsFile(), expected);
    assert.equal(store.listAccounts()[0].mailUrl, mailUrl);
    assert.equal(store.twofaSummary(email).hasImportedSecret, true);
    assert.equal(store.twofaSummary(email).hasSecret, false);
    assert.equal(store.getTwofaSecret(email), null);
    assert.ok(!JSON.stringify(store.listAccounts()).includes(secret));
  }
  assert.equal(fs.statSync(options.accountsFile).mode & 0o777, 0o600);
  assert.deepEqual(store.parseAccounts(`${line}\n${email}----${mailUrl}`), [expected[0]]);
  assert.deepEqual(store.parseAccounts(`${email}----${mailUrl}----`), [{ email, mailUrl }]);
});

test('非法密钥、列数及冲突在写入前拒绝，错误中不显示密钥', t => {
  const { store, options } = fixture(t);
  store.writeAccountsFile(line);
  const before = fs.readFileSync(options.accountsFile, 'utf8');
  for (const key of ['123456', 'invalid-key!', 'A'.repeat(17), 'A'.repeat(17) + 'B']) {
    assert.throws(() => store.writeAccountsFile(`${email}----${mailUrl}----${key}`), /第 1 行.*Base32/);
  }
  assert.throws(() => store.writeAccountsFile(line + '----extra'), /第 1 行.*格式/);
  const other = 'BH4OWU3OMXPJ7P63';
  assert.throws(() => store.writeAccountsFile(`${line}\n${email}----${mailUrl}----${other}`), /第 2 行.*不同/);
  store.recordTwofa(email, { secret });
  assert.throws(() => store.writeAccountsFile(`${email}----${mailUrl}----${other}`), error => /不同/.test(error.message) && !error.message.includes(other));
  assert.equal(fs.readFileSync(options.accountsFile, 'utf8'), before);
  assert.equal(store.getTwofaSecret(email), secret);
});

test('登录开始前持久保存导入密钥，登录失败仍保留，重复导入不清除验证记录', async t => {
  const { store, options } = fixture(t);
  store.writeAccountsFile(line);
  const events = [];
  store.subscribe(event => events.push(event));
  const worker = new Worker({ store, config });
  worker._loginOne = async () => {
    assert.equal(JSON.parse(fs.readFileSync(store.twofaFile, 'utf8'))[email].secret, secret);
    assert.equal(store.twofaSummary(email).enabled, false);
    throw new Error('模拟登录失败');
  };
  worker.enqueue([email]);
  await worker.drainPromise;
  assert.equal(store.getTwofaSecret(email), secret);
  assert.equal(new Store(options).getTwofaSecret(email), secret);
  assert.equal(store.twofaSummary(email).verifiedAt, null);
  assert.ok(store.twofaSummary(email).importedAt);
  assert.equal(fs.statSync(store.twofaFile).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(events).includes(secret));
  assert.ok(!JSON.stringify(store.listAccounts()).includes(secret));
  store.recordTwofa(email, { enabledAt: '2026-10-15T00:00:00Z', verifiedAt: '2026-10-15T00:00:00Z' });
  const before = fs.readFileSync(store.twofaFile, 'utf8');
  assert.equal(store.saveImportedTwofa(email), false);
  assert.equal(fs.readFileSync(store.twofaFile, 'utf8'), before);
  store.writeAccountsFile(`${email}----${mailUrl}`);
  assert.equal(store.getTwofaSecret(email), secret);
  assert.equal(new Store(options).twofaSummary(email).verifiedAt, '2026-10-15T00:00:00Z');
});

test('密钥无法落盘时不进入登录流程，套餐读取不提前保存密钥', async t => {
  const { store } = fixture(t);
  store.writeAccountsFile(line);
  const worker = new Worker({ store, config });
  worker._fetchPlan = async () => {};
  await worker._runOne(email, 'plan');
  assert.equal(store.getTwofaSecret(email), null);
  store.twofaFile = path.join(store.dir, 'missing', 'twofa.json');
  let loggedIn = false;
  worker._loginOne = async () => { loggedIn = true; };
  await assert.rejects(worker._runOne(email, 'login'));
  assert.equal(loggedIn, false);
  assert.equal(store.getTwofaSecret(email), null);
});

test('HTTP 导入后普通登录会自动保存密钥，列表和事件仅包含状态', async t => {
  const { store } = fixture(t);
  const worker = new Worker({ store, config });
  worker._loginOne = async () => { assert.equal(store.getTwofaSecret(email), secret); store.setStatus(email, 'idle'); };
  const server = createServer({ store, worker, config, publicDir: path.join(__dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await worker.stop(); server.closeEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const imported = await post('/api/accounts-file', { content: line });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).count, 1);
  const accounts = await (await fetch(base + '/api/accounts')).json();
  assert.equal(accounts[0].mailUrl, mailUrl);
  assert.equal(accounts[0].twofa.hasImportedSecret, true);
  assert.ok(!JSON.stringify(accounts).includes(secret));
  assert.equal((await post('/api/login', { email })).status, 202);
  await worker.drainPromise;
  const data = await (await fetch(base + '/api/twofa?email=' + encodeURIComponent(email))).json();
  assert.equal(data.secret, secret);
  assert.match(data.code, /^\d{6}$/);
});

function emailLoginContext({ rejectTotp = false, sessionEmail = email, challenge = true } = {}) {
  let state = 'home';
  let focused;
  let mailReads = 0;
  const values = {};
  const page = {
    values,
    url: () => state === 'home' || state === 'done' ? 'https://chatgpt.com/' : state === 'session' ? 'https://chatgpt.com/api/auth/session'
      : `https://auth.openai.com/${state === 'totp' ? 'mfa/challenge' : 'email-verification'}`,
    goto: async url => { state = url.includes('/api/auth/session') ? 'session' : 'home'; },
    title: async () => 'ChatGPT', waitForTimeout: async () => {},
    waitForURL: async predicate => { if (!predicate(new URL(page.url()))) throw new Error('模拟等待超时'); },
    keyboard: {
      type: async value => { values[focused] = value; },
      press: async key => {
        if (key !== 'Enter') return;
        if (state === 'email') state = 'otp';
        else if (state === 'otp') { assert.equal(values.otp, '062198'); state = challenge ? 'totp' : 'done'; }
      },
    },
    getByText: () => loc('challenge'), getByRole: () => loc('submit'),
    locator: selector => loc(selector === 'body' ? 'body' : selector === '#challenge-form' ? 'challenge'
      : selector.startsWith('button[data-testid="login-button"]') ? 'login'
      : selector.startsWith('button[type="submit"]') ? 'submit'
      : selector.startsWith('input[name="email"]') ? 'email'
      : selector.startsWith('input[type="password"]') ? 'password' : 'otp'),
  };
  const visible = kind => kind === state || (kind === 'otp' && state === 'totp');
  function loc(kind) {
    return {
      first() { return this; }, or() { return this; },
      count: async () => visible(kind) ? 1 : 0, isVisible: async () => visible(kind),
      waitFor: async ({ state: expected }) => {
        if (kind === 'password') return new Promise(() => {});
        if (expected === 'hidden' && visible(kind)) throw new Error('模拟等待超时');
      },
      innerText: async () => state === 'session' ? JSON.stringify({ accessToken: 'fixture-session', user: { email: sessionEmail } })
        : state === 'totp' ? 'Enter the code from your authenticator app' : `Email code sent to ${email}`,
      fill: async value => { values.totp = value; },
      click: async () => {
        focused = kind;
        if (kind === 'login') state = 'email';
        if (kind === 'submit' && state === 'totp' && !rejectTotp) state = 'done';
      },
    };
  }
  const mailbox = () => ({
    goto: async () => {}, waitForSelector: async () => {}, waitForTimeout: async () => {}, close: async () => {}, isClosed: () => false,
    $$eval: async () => ++mailReads === 1 ? [] : [{ id: 'fresh-message', idx: 0, time: new Date().toISOString() }],
    locator: () => ({ nth: () => ({
      locator: () => ({ first: () => ({ count: async () => 0 }) }),
      textContent: async () => `To: ${email} Your temporary ChatGPT login code: 062198`,
    }) }),
  });
  let pages = 0;
  return { page, newPage: async () => pages++ === 0 ? page : mailbox(), close: async () => {}, storageState: async () => ({ cookies: [], origins: [] }) };
}

test('三段导入后无密码也能完成邮箱码 + TOTP，最后核对邮箱再标记已验证', async t => {
  const { store } = fixture(t);
  store.writeAccountsFile(line);
  const worker = new Worker({ store, config });
  const context = emailLoginContext();
  worker._createContext = async (browser, options, task) => { task.contexts.add(context); return context; };
  worker._fillSignupIfNeeded = async () => {};
  let queries = 0;
  worker._fetchPlan = async (value, task) => {
    assert.equal(value, email);
    assert.equal(task.session.email, email);
    assert.equal(task.session.context, context);
    assert.equal(task.session.page, context.page);
    queries++;
  };
  await worker._runOne(email);
  assert.equal(queries, 1);
  assert.equal(context.page.values.email, email);
  assert.equal(context.page.values.otp, '062198');
  assert.match(context.page.values.totp, /^\d{6}$/);
  assert.equal(store.getAccount(email).status, 'ok');
  assert.ok(store.twofaSummary(email).verifiedAt);
  assert.equal(store.twofaSummary(email).enabled, true);
  assert.ok(!store.getAccount(email).logs.join('\n').includes(secret));
});

test('验证器失败、会话邮箱不符或未出现挑战时，不虚报导入的密钥已验证', async t => {
  for (const scenario of [{ rejectTotp: true }, { sessionEmail: 'other@example.test' }, { challenge: false }]) {
    const { store } = fixture(t);
    store.writeAccountsFile(line);
    const worker = new Worker({ store, config });
    const context = emailLoginContext(scenario);
    worker._createContext = async (browser, options, task) => { task.contexts.add(context); return context; };
    worker._fillSignupIfNeeded = async () => {};
    if (scenario.challenge === false) await worker._runOne(email);
    else await assert.rejects(worker._runOne(email), /验证器验证码未通过|该账号的有效会话/);
    assert.equal(store.getTwofaSecret(email), secret);
    assert.equal(store.twofaSummary(email).verifiedAt, null);
    assert.equal(store.twofaSummary(email).enabled, false);
  }
});

test('没有密码时用邮箱验证码验证更换后的 2FA，不复用旧会话；无挑战不能确认新密钥', async t => {
  for (const challenge of [true, false]) {
    const { store, options } = fixture(t);
    store.writeAccountsFile(line);
    store.saveImportedTwofa(email);
    store.beginTwofaRotation(email);
    store.prepareTwofaRotation(email, 'BH4OWU3OMXPJ7P63');
    store.recordTwofa(email, { pendingSubmittedAt: 'submitted' });
    store.saveProfile(email, { cookies: [{ name: 'old', value: 'fixture' }], origins: [] });
    const worker = new Worker({ store, config });
    const context = emailLoginContext({ challenge });
    worker._createContext = async (browser, extra, task) => { assert.equal(extra.storageState, undefined); task.contexts.add(context); return context; };
    worker._fillSignupIfNeeded = async () => {};
    if (challenge) {
      await worker._runOne(email, 'twofa-verify');
      assert.equal(store.getTwofaSecret(email), 'BH4OWU3OMXPJ7P63');
      assert.ok(new Store(options).twofaSummary(email).verifiedAt);
    } else {
      await assert.rejects(worker._runOne(email, 'twofa-verify'), /未出现验证器挑战/);
      assert.equal(store.getTwofaSecret(email), secret);
      assert.equal(store.getTwofaSecret(email, true), 'BH4OWU3OMXPJ7P63');
    }
  }
});
