const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('../src/store');
const Worker = require('../src/worker');
const { createServer } = require('../src/server');
const { generatePassword, fillPasswordForm, initializePassword, verifyPasswordLogin, readPasswordError } = require('../src/password');

const email = 'alice@example.test';
const config = { port: 0, mail: {}, batch: { headless: true, perAccountTimeoutMs: 1000, delayBetweenAccountsMs: 0 } };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-password-test-'));
  const options = { dir, accountsFile: path.join(dir, 'accounts.txt'), infoFile: path.join(dir, 'info.json') };
  fs.writeFileSync(options.accountsFile, `${email}----https://mail.example.test/inbox`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { options, store: new Store(options) };
}

function field({ autocomplete = 'new-password', minLength = 8, name = 'newPassword' } = {}) {
  return {
    name, id: name, autocomplete, minLength, maxLength: -1, labels: [], placeholder: '',
    validity: { valid: true }, validationMessage: '', value: '', getAttribute: () => '',
    async evaluate(fn) { return fn(this); }, async fill(value) { this.value = value; },
  };
}

function mockPage({ result = 'success', minimum = 8, otp = false, current = false, beforeSubmit = () => {},
  reauth = false, reauthResult = 'ok', reauthDelay = 0, reauthAutocomplete = 'current-password', sameUrl = false, beforeReauth = () => {} } = {}) {
  let state = 'settings';
  let submitted = 0;
  let reauthSubmitted = 0;
  let reauthWaits = 0;
  let otpValue = '';
  const oldInput = field({ autocomplete: reauthAutocomplete, name: reauthAutocomplete ? 'currentPassword' : 'password', minLength: 1 });
  const inputs = [field({ minLength: minimum }), field({ name: 'confirmPassword', minLength: minimum })];
  if (current) inputs.unshift(field({ autocomplete: 'current-password', name: 'currentPassword' }));
  const afterIdentity = () => otp ? 'otp' : 'password';
  const page = {
    state: () => state, submissions: () => submitted, reauthSubmissions: () => reauthSubmitted, inputs, oldInput,
    url: () => state === 'untrusted' ? 'https://other.example.test/password' : state === 'settings' || state === 'returned' ? 'https://chatgpt.com/settings/security' : 'https://auth.openai.com/' + (state.startsWith('reauth') && !sameUrl ? 'log-in/password' : state === 'otp' ? otp === 'totp' ? 'mfa/challenge' : 'email-verification' : 'change-password'),
    goto: async () => { state = 'settings'; },
    waitForTimeout: async () => { if (state === 'reauth-wait' && ++reauthWaits >= reauthDelay) state = afterIdentity(); },
    waitForURL: async predicate => { assert.equal(predicate(new URL(page.url())), true); },
    evaluate: async () => state === 'reauth-rejected' ? 'Wrong current password' : state === 'rejected' ? 'Your password must contain: At least 16 characters. Incomplete.' : '',
    getByRole: (role, { name }) => {
      const title = 'Password Manage the password you use to log in ' + (state === 'returned' ? 'Change' : 'Add');
      return locator('entry', name.test(title));
    },
    getByText: () => locator('success'),
    locator: selector => locator(selector === 'body' ? 'body' : selector.startsWith('button') ? 'submit' :
      selector.includes('role="alert"') ? 'error' : selector.startsWith('input[type="password"]') ? 'password' : 'otp'),
  };
  function locator(type, matches = true) {
    return {
      first() { return this; }, or() { return this; },
      all: async () => type === 'password' ? state.startsWith('reauth') ? [oldInput] : state === 'password' ? inputs : [] : [],
      isVisible: async () => matches && ((type === 'password' && (state === 'password' || state.startsWith('reauth'))) || (type === 'otp' && state === 'otp') ||
        (type === 'success' && state === 'success') || (type === 'error' && state === 'rejected') || (type === 'entry' && ['settings', 'returned'].includes(state))),
      innerText: async () => type === 'body' ? otp === 'totp' ? 'Enter the code from your authenticator app' : `Enter the verification code we sent to ${email} to verify your email` : 'Password must contain at least 12 characters',
      fill: async value => { otpValue = value; },
      waitFor: async ({ state: expected }) => {
        if (type === 'otp' && expected === 'hidden') assert.notEqual(state, 'otp');
      },
      click: async () => {
        if (type === 'entry') { state = reauth ? 'reauth' : afterIdentity(); return; }
        if (type === 'submit' && state.startsWith('reauth')) {
          beforeReauth(oldInput);
          reauthSubmitted++;
          state = reauthResult === 'rejected' ? 'reauth-rejected' : reauthResult === 'untrusted' ? 'untrusted' : reauthDelay ? 'reauth-wait' : afterIdentity();
          return;
        }
        if (type === 'submit' && state === 'otp') {
          if (otp === 'totp') assert.match(otpValue, /^\d{6}$/); else assert.equal(otpValue, '062198');
          state = 'password'; return;
        }
        if (type === 'submit') {
          beforeSubmit(inputs);
          submitted++;
          if (result === 'network-error') throw new Error(`Request failed after submitting ${inputs.at(-1).value}`);
          state = result;
        }
      },
    };
  }
  return page;
}

function mailboxContext() {
  let reads = 0;
  return { newPage: async () => ({
    goto: async () => {}, waitForSelector: async () => {}, waitForTimeout: async () => {}, close: async () => {}, isClosed: () => false,
    $$eval: async () => ++reads === 1 ? [] : [{ id: 'fresh-message', idx: 0, time: new Date().toISOString() }],
    locator: () => ({ nth: () => ({
      locator: () => ({ first: () => ({ count: async () => 0 }) }),
      textContent: async () => `To: ${email} Your temporary ChatGPT login code: 062198`,
    }) }),
  }) };
}

function runPassword(store, page, verifyPassword = async () => {}, options = {}) {
  const messages = [];
  const promise = initializePassword({
    store, page, context: mailboxContext(), email, currentPassword: store.getPassword(email),
    signal: new AbortController().signal, mail: { url: 'https://mail.example.test/inbox', pageLoadWaitMs: 0 },
    log: text => messages.push(text), stage: text => messages.push(text),
    verifyPassword, ...options,
  });
  return { promise, messages };
}

test('生成的密码固定为 12 位，包含大小写、数字与符号', () => {
  const values = new Set();
  for (let i = 0; i < 100; i++) {
    const password = generatePassword();
    assert.equal(password.length, 12);
    for (const pattern of [/[A-Z]/, /[a-z]/, /[0-9]/, /[!@#$%]/]) assert.match(password, pattern);
    values.add(password);
  }
  assert.equal(values.size, 100);
});

test('密码独立保存，重启和刷新 Session 不丢失；列表与事件不含明文', t => {
  const { store, options } = fixture(t);
  const events = [];
  store.subscribe(event => events.push(event));
  store.preparePassword(email, 'Ab3!xY7@');
  store.recordPassword(email, { submittedAt: new Date().toISOString() });
  store.confirmPassword(email);
  store.saveInfo(email, { accessToken: 'updated-session', raw: '{"test":true}' });
  const recovered = new Store(options);
  assert.equal(recovered.getPassword(email), 'Ab3!xY7@');
  assert.equal(recovered.passwordSummary(email).saved, true);
  assert.equal(fs.statSync(store.passwordsFile).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(events).includes('Ab3!xY7@'));
  assert.ok(!JSON.stringify(recovered.listAccounts()).includes('Ab3!xY7@'));
  assert.ok(!fs.readFileSync(store.infoFile, 'utf8').includes('Ab3!xY7@'));
});

test('提交后中断保留候选和旧密码，并阻止覆盖未确认候选', t => {
  const { store, options } = fixture(t);
  store.recordPassword(email, { password: 'Old8!abc', updatedAt: new Date().toISOString() });
  store.preparePassword(email, 'New8!xyz');
  store.recordPassword(email, { submittedAt: new Date().toISOString() });
  store.failPassword(email, '网络断开');
  const recovered = new Store(options);
  assert.equal(recovered.getPassword(email), 'Old8!abc');
  assert.equal(recovered.getPassword(email, true), 'New8!xyz');
  assert.equal(recovered.passwordSummary(email).uncertain, true);
  assert.throws(() => recovered.preparePassword(email, 'Other8!x'), /未确认/);
  recovered.failPassword(email, '网站明确拒绝新密码', true);
  assert.equal(recovered.getPassword(email, true), null);
  assert.equal(recovered.getPassword(email), 'Old8!abc');
});

test('旧密码和确认字段填写正确；站点要求超过 12 位时不填写或提交', async () => {
  const page = mockPage({ current: true });
  await page.getByRole('button', { name: /^Password/ }).click();
  await fillPasswordForm(page, 'New8!xyz', 'Old8!abc');
  assert.deepEqual(page.inputs.map(input => input.value), ['Old8!abc', 'New8!xyz', 'New8!xyz']);
  const strict = mockPage({ minimum: 16 });
  await strict.getByRole('button', { name: /^Password/ }).click();
  await assert.rejects(fillPasswordForm(strict, 'New12!xyzABC'), /至少 16 位/);
  assert.ok(strict.inputs.every(input => input.value === ''));
  await assert.rejects(fillPasswordForm({ ...strict, url: () => 'https://other.example.test/password' }, 'New8!xyz'), /非 OpenAI/);
  await assert.rejects(fillPasswordForm(page, 'New8!xyz'), /旧密码/);
});

test('邮箱验证码、密码提交和成功记录贯通，提交前候选已经落盘', async t => {
  const { store } = fixture(t);
  const page = mockPage({ otp: true, beforeSubmit: inputs => {
    const persisted = JSON.parse(fs.readFileSync(store.passwordsFile, 'utf8'))[email];
    assert.equal(persisted.pendingPassword, inputs[0].value);
    assert.ok(persisted.submittedAt);
    assert.equal(persisted.password, undefined);
  } });
  let verified = false;
  const { promise, messages } = runPassword(store, page, async password => {
    assert.equal(password, page.inputs[0].value);
    assert.equal(store.getPassword(email), undefined);
    verified = true;
  });
  await promise;
  assert.equal(page.submissions(), 1);
  assert.equal(store.getPassword(email).length, 12);
  assert.equal(verified, true);
  assert.ok(store.passwordSummary(email).verifiedAt);
  assert.equal(store.passwordSummary(email).uncertain, false);
  assert.ok(messages.join('\n').includes(store.getPassword(email)));
  assert.ok(!messages.join('\n').includes('062198'));
});

test('独立旧密码验证后继续改密，异步跳转或同页切换只提交一次旧密码，再验证新密码登录', async t => {
  for (const options of [{ reauthDelay: 2 }, { sameUrl: true }, { reauthAutocomplete: '' }, { otp: true }, { otp: 'totp' }]) {
    const { store } = fixture(t);
    store.recordPassword(email, { password: 'Old12!xyzABC' });
    const page = mockPage({ reauth: true, ...options, beforeReauth: input => {
      assert.equal(input.value, 'Old12!xyzABC');
      assert.equal(store.getPassword(email, true), null);
      assert.equal(store.passwords.get(email).pendingPassword, undefined);
      assert.ok(page.inputs.every(field => field.value === ''));
    }, beforeSubmit: inputs => {
      assert.equal(page.reauthSubmissions(), 1);
      assert.equal(store.getPassword(email), 'Old12!xyzABC');
      assert.equal(store.getPassword(email, true), inputs[0].value);
    } });
    let verified = 0;
    await runPassword(store, page, async value => {
      verified++;
      assert.equal(value, page.inputs[0].value);
      assert.equal(value.length, 12);
      assert.equal(store.getPassword(email), 'Old12!xyzABC');
    }, { totpSecret: 'BH4OWU3OMXPJ7P63' }).promise;
    assert.equal(page.reauthSubmissions(), 1);
    assert.equal(page.submissions(), 1);
    assert.equal(verified, 1);
    assert.equal(store.getPassword(email), page.inputs[0].value);
    assert.ok(store.passwordSummary(email).verifiedAt);
    assert.equal(store.passwordSummary(email).uncertain, false);
  }
});

test('缺少旧密码、旧密码错误或跳转到非官网页面时停止，不提交新密码或覆盖原记录', async t => {
  for (const [scenario, expected, submissions] of [
    ['missing', /填写当前密码/, 0], ['rejected', /当前密码验证失败：Wrong current password/, 1], ['untrusted', /非 OpenAI 页面/, 1],
  ]) {
    const { store } = fixture(t);
    if (scenario !== 'missing') store.recordPassword(email, { password: 'Old12!xyzABC' });
    const page = mockPage({ reauth: true, reauthResult: scenario });
    await assert.rejects(runPassword(store, page, async () => assert.fail('不能开始新密码登录验证')).promise, expected);
    assert.equal(page.reauthSubmissions(), submissions);
    assert.equal(page.submissions(), 0);
    assert.ok(page.inputs.every(field => field.value === ''));
    assert.equal(store.getPassword(email), scenario === 'missing' ? undefined : 'Old12!xyzABC');
    assert.equal(store.getPassword(email, true), null);
  }
});

test('旧密码提交后页面不响应会限时停止，不重复提交、不生成待确认新密码', async t => {
  const { store } = fixture(t);
  store.recordPassword(email, { password: 'Old12!xyzABC' });
  const page = mockPage({ reauth: true, reauthDelay: Infinity });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  page.waitForTimeout = async () => { now += 5000; };
  try { await assert.rejects(runPassword(store, page).promise, /当前密码验证未完成/); }
  finally { Date.now = realNow; }
  assert.equal(page.reauthSubmissions(), 1);
  assert.equal(page.submissions(), 0);
  assert.equal(store.getPassword(email), 'Old12!xyzABC');
  assert.equal(store.getPassword(email, true), null);
});

test('旧密码验证期间取消任务不会继续提交；新密码验证失败仍保留已提交候选', async t => {
  const { store, options } = fixture(t);
  store.recordPassword(email, { password: 'Old12!xyzABC' });
  const controller = new AbortController();
  const cancelled = mockPage({ reauth: true });
  cancelled.oldInput.fill = async () => { controller.abort(new Error('fixture cancelled')); };
  await assert.rejects(runPassword(store, cancelled, async () => {}, { signal: controller.signal }).promise, /fixture cancelled/);
  assert.equal(cancelled.reauthSubmissions(), 0);
  assert.equal(cancelled.submissions(), 0);
  const page = mockPage({ reauth: true });
  await assert.rejects(runPassword(store, page, async () => { throw new Error('fixture login failed'); }).promise, /fixture login failed/);
  const recovered = new Store(options);
  assert.equal(page.reauthSubmissions(), 1);
  assert.equal(page.submissions(), 1);
  assert.equal(recovered.getPassword(email), 'Old12!xyzABC');
  assert.equal(recovered.getPassword(email, true), page.inputs[0].value);
  assert.equal(recovered.passwordSummary(email).uncertain, true);
});

test('网站返回明确校验失败时不记录为成功，不覆盖旧密码', async t => {
  const { store } = fixture(t);
  store.recordPassword(email, { password: 'Old8!abc' });
  await assert.rejects(runPassword(store, mockPage({ result: 'rejected' })).promise, /At least 16/);
  assert.equal(store.getPassword(email), 'Old8!abc');
  assert.equal(store.getPassword(email, true), null);
  assert.equal(store.passwordSummary(email).uncertain, false);
});

test('提交后网络异常保留候选，但错误中不暴露密码', async t => {
  const { store } = fixture(t);
  const page = mockPage({ result: 'network-error' });
  await assert.rejects(runPassword(store, page).promise, /密码已隐藏/);
  const pending = store.getPassword(email, true);
  assert.equal(pending.length, 12);
  assert.equal(store.getPassword(email), undefined);
  assert.equal(store.passwordSummary(email).uncertain, true);
  assert.ok(!store.passwordSummary(email).error.includes(pending));
});

test('本地记录写入失败时不会向网站提交密码', async t => {
  const { store } = fixture(t);
  store.passwordsFile = path.join(store.dir, 'missing-directory', 'passwords.json');
  const page = mockPage();
  await assert.rejects(runPassword(store, page).promise);
  assert.equal(page.submissions(), 0);
});

test('官网成功后返回首页时仍执行密码登录验证；验证失败保留候选', async t => {
  const { store } = fixture(t);
  let called = 0;
  await assert.rejects(runPassword(store, mockPage({ result: 'returned' }), async () => {
    called++;
    throw new Error('ChatGPT 登录回调失败：OAuthCallback');
  }).promise, /OAuthCallback/);
  assert.equal(called, 1);
  assert.equal(store.getPassword(email), undefined);
  assert.equal(store.getPassword(email, true).length, 12);
  assert.equal(store.passwordSummary(email).uncertain, true);
});

test('识别官网 aria-describedby 中无 alert 的密码长度错误', async () => {
  const vm = require('node:vm');
  let description = 'Your password must contain:At least 12 characters. Incomplete.';
  const document = {
    querySelectorAll: selector => selector.startsWith('input') ? [{
      getClientRects: () => [1], validity: { valid: true },
      getAttribute: () => 'password-rules',
    }] : [],
    getElementById: () => ({ textContent: description }),
  };
  const page = { evaluate: async fn => vm.runInNewContext(`(${fn.toString()})()`, { document }) };
  assert.match(await readPasswordError(page), /At least 12 characters/);
  description = 'At least 12 characters. Complete.';
  assert.equal(await readPasswordError(page), '');
});

function mockLoginPage({ result = 'ok', sessionEmail = email, totp = false } = {}) {
  let state = 'start';
  const values = {};
  const history = [];
  const page = {
    values, history,
    url: () => state === 'done' ? 'https://chatgpt.com/' : state === 'session' ? 'https://chatgpt.com/api/auth/session'
      : state === 'callback-error' ? 'https://chatgpt.com/auth/error?error=OAuthCallback'
      : 'https://auth.openai.com/' + (state === 'password' ? 'log-in/password' : state === 'totp' ? 'mfa/challenge' : 'email-verification'),
    goto: async url => { state = url.includes('/api/auth/session') ? 'session' : 'email'; },
    evaluate: async () => state === 'rejected' ? 'Wrong email or password' : '',
    waitForTimeout: async () => {},
    waitForURL: async fn => { assert.equal(fn(new URL(page.url())), true); },
    locator: selector => loc(selector === 'body' ? 'body' : selector.startsWith('button') ? 'submit'
      : selector.startsWith('input[type="email"]') ? 'email' : selector.startsWith('input[type="password"]') ? 'password' : 'otp'),
    getByRole: role => loc(role === 'link' ? 'use-password' : 'submit'),
  };
  function loc(kind) {
    return {
      first() { return this; }, or() { return this; }, waitFor: async () => {},
      fill: async value => { values[kind] = value; history.push('fill:' + kind); },
      isVisible: async () => state === kind || (state === 'totp' && kind === 'otp') || (state === 'choose-password' && kind === 'use-password'),
      innerText: async () => state === 'session' ? JSON.stringify({ accessToken: 'new-session', user: { email: sessionEmail } }) : state === 'totp' ? 'Enter the code from your authenticator app' : `Check your inbox: ${email}. Resend email`,
      click: async () => {
        history.push('click:' + kind);
        if (kind === 'use-password') state = 'password';
        else if (state === 'email') state = 'choose-password';
        else if (state === 'password') state = result === 'rejected' ? 'rejected' : totp === true ? 'totp' : 'otp';
        else if (state === 'otp') state = totp === 'after-email' ? 'totp' : result === 'callback-error' ? 'callback-error' : 'done';
        else if (state === 'totp') state = 'done';
      },
    };
  }
  return page;
}

test('密码登录显式选择密码入口，并处理密码后的附加邮箱验证码', async () => {
  const page = mockLoginPage();
  const info = await verifyPasswordLogin({
    page, context: mailboxContext(), email, password: 'New12!xyzABC',
    mail: { url: 'https://mail.example.test/inbox', pageLoadWaitMs: 0 }, signal: new AbortController().signal, log: () => {},
  });
  assert.equal(info.accessToken, 'new-session');
  assert.equal(info.email, email);
  assert.equal(page.values.password, 'New12!xyzABC');
  assert.equal(page.values.otp, '062198');
  assert.ok(page.history.indexOf('fill:password') < page.history.indexOf('fill:otp'));
  assert.ok(page.history.includes('click:use-password'));
});

test('错误密码、错误账号和 OAuth 回调失败都不能标记登录成功', async () => {
  for (const [options, message] of [[{ result: 'rejected' }, /Wrong email or password/], [{ result: 'callback-error' }, /OAuthCallback/], [{ sessionEmail: 'wrong@example.test' }, /该账号/]]) {
    await assert.rejects(verifyPasswordLogin({
      page: mockLoginPage(options), context: mailboxContext(), email, password: 'New12!xyzABC',
      mail: { url: 'https://mail.example.test/inbox', pageLoadWaitMs: 0 }, signal: new AbortController().signal, log: () => {},
    }), message);
  }
});

test('密码登录处理验证器挑战，并要求实际通过 2FA 后才算验证成功', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for (const totp of [true, 'after-email']) {
    const page = mockLoginPage({ totp });
    const info = await verifyPasswordLogin({
      page, context: mailboxContext(), email, password: 'New12!xyzABC', totpSecret: secret, requireTotp: true,
      mail: { url: 'https://mail.example.test/inbox', pageLoadWaitMs: 0 }, signal: new AbortController().signal, log: () => {},
    });
    assert.equal(info.accessToken, 'new-session');
    assert.equal(info.totpVerified, true);
    assert.match(page.values.otp, /^\d{6}$/);
  }
  await assert.rejects(verifyPasswordLogin({
    page: mockLoginPage(), context: mailboxContext(), email, password: 'New12!xyzABC', totpSecret: secret, requireTotp: true,
    mail: { url: 'https://mail.example.test/inbox', pageLoadWaitMs: 0 }, signal: new AbortController().signal, log: () => {},
  }), /未出现验证器挑战/);
  await assert.rejects(verifyPasswordLogin({
    page: mockLoginPage({ totp: true }), context: mailboxContext(), email, password: 'New12!xyzABC',
    mail: { url: 'https://mail.example.test/inbox', pageLoadWaitMs: 0 }, signal: new AbortController().signal, log: () => {},
  }), /没有 2FA 密钥/);
});

test('密码 + 2FA 登录未要求邮箱验证码时不访问取件服务', async () => {
  const page = mockLoginPage({ totp: true });
  const context = { newPage: async () => { throw new Error('不应访问取件服务'); } };
  const info = await verifyPasswordLogin({
    page, context, email, password: 'New12!xyzABC',
    totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', requireTotp: true,
    mail: { url: 'https://mail.example.test/unauthorized' },
    signal: new AbortController().signal, log: () => {},
  });
  assert.equal(info.accessToken, 'new-session');
  assert.equal(info.totpVerified, true);
});

test('密码 API 和登录共用队列，重复请求不会重复修改；复制接口按需取值', async t => {
  const { store } = fixture(t);
  const worker = new Worker({ store, config });
  let release;
  let runs = 0;
  worker._initializePassword = async () => {
    runs++;
    await new Promise(resolve => { release = resolve; });
    store.preparePassword(email, 'New8!xyz');
    store.recordPassword(email, { submittedAt: new Date().toISOString() });
    store.confirmPassword(email);
  };
  const server = createServer({ store, worker, config, publicDir: path.join(__dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { release?.(); await worker.stop(); server.closeEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const init = value => fetch(base + '/api/password/init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: value }) });
  assert.equal((await fetch(base + '/api/password?email=' + email)).status, 404);
  assert.equal((await init('unknown@example.test')).status, 400);
  assert.equal((await (await init(email.toUpperCase())).json()).queued, 1);
  assert.equal((await (await init(email)).json()).queued, 0);
  assert.deepEqual(worker.enqueue([email]), []);
  assert.equal(runs, 1);
  release();
  await worker.drainPromise;
  assert.equal((await (await fetch(base + '/api/password?email=' + email)).json()).password, 'New8!xyz');
  assert.ok(!(await (await fetch(base + '/api/accounts')).text()).includes('New8!xyz'));
  assert.equal((await fetch(base + '/api/password?email=' + email, { headers: { Origin: 'https://other.example.test' } })).status, 403);
  store.preparePassword(email, 'Next8!xy');
  store.recordPassword(email, { submittedAt: new Date().toISOString() });
  assert.equal((await init(email)).status, 409);
  assert.equal((await (await fetch(base + '/api/password?pending=1&email=' + email)).json()).password, 'Next8!xy');
  let verifications = 0;
  worker._verifyPassword = async () => { verifications++; store.confirmPassword(email); };
  const response = await fetch(base + '/api/password/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  assert.equal(response.status, 202);
  await worker.drainPromise;
  assert.equal(verifications, 1);
  assert.equal(store.passwordSummary(email).uncertain, false);
  assert.equal(store.getPassword(email), 'Next8!xy');
});
