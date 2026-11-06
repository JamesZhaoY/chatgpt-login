const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Store = require('../src/store');
const { mergePlanSnapshot } = require('../src/plans');

const email = 'alice+1@example.test';
const password = 'Fixture12!xx';
const secret = 'BH4OWU3OMXPJ7P63';
const info = { email, accessToken: 'fixture-token', raw: JSON.stringify({ user: { email }, accessToken: 'fixture-token' }), fetchedAt: '2026-10-21T00:00:00Z' };
const plan = { planType: 'pro', planFamily: 'pro', planName: 'Pro 200', proTier: 200, source: 'account-api', accountId: 'fixture-account',
  availability: { membership: true, usage: true }, usage: { primary: { usedPercent: 0, windowSeconds: 18000 } }, fetchedAt: '2026-10-21T00:00:00Z' };

// Only in-memory browser doubles and temporary account stores; no external logins.
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-auto-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store({ dir, accountsFile: path.join(dir, 'accounts.txt'), infoFile: path.join(dir, 'info.json') });
  store.writeAccountRows([{ email, mailUrl: 'https://mail.example.test/inbox' }]);
  const contexts = [];
  const queries = [];
  const verifications = [];
  const filename = require.resolve('../src/worker');
  const load = createRequire(filename);
  const exports = { exports: {} };
  const mocks = {
    './browser': {
      getBrowser: async () => ({}), newContext: async (_, options) => {
        const page = { goto: async () => {}, locator: () => ({ innerText: async () => info.raw }) };
        const context = { page, options, closes: 0, pages: 0, newPage: async () => { context.pages++; return page; },
          storageState: async () => ({ cookies: [], origins: [] }), close: async () => { context.closes++; } };
        contexts.push(context);
        return context;
      },
    },
    './password': { ...load('./password'), verifyPasswordLogin: async options => {
      assert.equal(options.email, email);
      assert.equal(options.context.options.storageState, undefined, 'credential verification requires a fresh session');
      assert.equal(options.page, options.context.page);
      assert.equal(options.password, password);
      verifications.push(options);
      return { ...info, totpVerified: Boolean(options.requireTotp) };
    }, ...overrides.password },
    './twofa': { ...load('./twofa'), ...overrides.twofa },
    './plans': { mergePlanSnapshot, fetchPlanDetails: async options => {
      queries.push(options);
      assert.equal(options.email, email);
      const context = contexts.find(item => item.page === options.page);
      assert.ok(context, 'query must use an existing account page');
      assert.equal(context.closes, 0, 'page must stay open until membership query completes');
      return overrides.query ? overrides.query(options) : plan;
    } },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: exports, require: name => mocks[name] || load(name), AbortController, setTimeout, clearTimeout,
  });
  const config = { mail: {}, batch: { perAccountTimeoutMs: 1000, delayBetweenAccountsMs: 0 } };
  const worker = new exports.exports({ store, config });
  return { store, worker, contexts, queries, verifications };
}

for (const method of ['password', 'session']) test(`${method} 登录后自动查询一次，复用同一个上下文和页面，结束时关闭`, async t => {
  const { store, worker, contexts, queries, verifications } = fixture(t);
  if (method === 'password') store.recordPassword(email, { password });
  else store.saveProfile(email, { cookies: [], origins: [] });
  await worker._runOne(email);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].pages, 1);
  assert.equal(contexts[0].closes, 1);
  assert.equal(queries.length, 1);
  assert.equal(verifications.length, method === 'password' ? 1 : 0);
  assert.equal(store.getAccount(email).status, 'ok');
  assert.equal(store.plans.get(email).planName, 'Pro 200');
  assert.equal(store.plans.get(email).usage.primary.usedPercent, 0);
});

test('多步初始化复用设置页面，新密码和新 2FA 仍分别全新登录，最后仅查询一次', async t => {
  const settingsPages = [];
  const f = fixture(t, {
    password: { initializePassword: async options => {
      settingsPages.push(options.page);
      options.store.preparePassword(email, password);
      options.store.recordPassword(email, { submittedAt: 'submitted' });
      await options.verifyPassword(password);
      options.store.confirmPassword(email);
      options.store.recordPassword(email, { verifiedAt: 'verified' });
    } },
    twofa: { enableTwofa: async options => {
      settingsPages.push(options.page);
      options.store.recordTwofa(email, { secret, enabledAt: 'enabled' });
      await options.verifyLogin();
    } },
  });
  f.store.saveProfile(email, { cookies: [], origins: [] });
  await f.worker._runOne(email, 'setup');
  assert.equal(f.worker.setupComplete(email), true);
  assert.equal(f.contexts.length, 3);
  assert.equal(f.verifications.length, 2);
  assert.equal(f.verifications[1].requireTotp, true);
  assert.equal(f.verifications[1].totpSecret, secret);
  assert.equal(settingsPages[0], f.contexts[0].page);
  assert.equal(settingsPages[1], f.contexts[1].page);
  assert.equal(f.queries.length, 1);
  assert.equal(f.queries[0].page, f.contexts[2].page);
  assert.ok(f.contexts.every(context => context.pages === 1 && context.closes === 1));
});

test('自动查询 401 保留登录与旧额度，不再次登录；后续队列正常执行', async t => {
  const f = fixture(t, { query: async () => { throw Object.assign(new Error('fixture HTTP 401'), { code: 'PLAN_SESSION_EXPIRED' }); } });
  f.store.recordPassword(email, { password });
  f.store.savePlan(email, plan);
  f.worker.enqueue([email]);
  await f.worker.drainPromise;
  const account = f.store.getAccount(email);
  assert.equal(account.status, 'ok');
  assert.equal(account.error, null);
  assert.ok(f.store.passwordSummary(email).verifiedAt);
  assert.deepEqual(f.store.plans.get(email).usage, plan.usage);
  assert.match(f.store.plans.get(email).error, /401/);
  assert.equal(f.queries.length, 1);
  assert.equal(f.verifications.length, 1);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.contexts[0].closes, 1);
  f.worker.enqueue([email]);
  await f.worker.drainPromise;
  assert.equal(f.store.getAccount(email).status, 'ok');
  assert.equal(f.queries.length, 2);
});

test('单账号手动刷新遇到 401 时恢复一次密码会话，重试复用新登录页面', async t => {
  let calls = 0;
  const f = fixture(t, { query: async () => {
    if (++calls === 1) throw Object.assign(new Error('fixture HTTP 401'), { code: 'PLAN_SESSION_EXPIRED' });
    return plan;
  } });
  f.store.recordPassword(email, { password });
  f.store.saveProfile(email, { cookies: [], origins: [] });
  await f.worker._runOne(email, 'plan');
  assert.equal(f.contexts.length, 2);
  assert.equal(f.verifications.length, 1);
  assert.equal(f.queries.length, 2);
  assert.equal(f.queries[1].page, f.verifications[0].page);
  assert.ok(f.contexts.every(context => context.closes === 1));
  assert.equal(f.store.plans.get(email).error, null);
});

for (const stop of ['timeout', 'cancel']) test(`自动查询 ${stop} 释放窗口并保留登录成功，迟到的结果不能覆盖记录`, async t => {
  let finish;
  const f = fixture(t, { query: async () => {
    if (stop === 'cancel') setImmediate(() => f.worker.currentController.abort(new Error('fixture cancel')));
    return new Promise(resolve => { finish = resolve; });
  } });
  f.worker.config.batch.perAccountTimeoutMs = 100;
  f.store.recordPassword(email, { password });
  f.store.savePlan(email, plan);
  await f.worker._runOne(email);
  assert.equal(f.store.getAccount(email).status, 'ok');
  assert.match(f.store.plans.get(email).error, stop === 'timeout' ? /超时/ : /cancel/);
  assert.equal(f.contexts[0].closes, 1);
  const saved = f.store.plans.get(email);
  finish({ ...plan, planName: 'late result' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.plans.get(email), saved);
});

test('会员查询落盘失败不把已经验证的密码或登录标成失败', async t => {
  const f = fixture(t);
  f.store.recordPassword(email, { password });
  f.store.savePlan(email, plan);
  f.store.plansFile = path.join(f.store.dir, 'missing', 'plans.json');
  f.worker.enqueue([email]);
  await f.worker.drainPromise;
  assert.equal(f.store.getAccount(email).status, 'ok');
  assert.equal(f.store.passwordSummary(email).error, null);
  assert.equal(f.store.plans.get(email).fetchedAt, plan.fetchedAt);
  assert.equal(f.contexts[0].closes, 1);
});
