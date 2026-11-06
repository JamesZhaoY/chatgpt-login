const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { normalizePlan, fetchPlanDetails, mergePlanSnapshot, isoDate, billingProTier } = require('../src/plans');
const Store = require('../src/store');
const LoginWorker = require('../src/worker');
const { createServer } = require('../src/server');

const ACCOUNT = '/backend-api/accounts/check/v4-2023-04-27';
const BILLING = '/backend-api/subscriptions';
const USAGE = '/backend-api/wham/usage';
const session = { user: { email: 'alice+1@example.test' }, accessToken: 'fixture', expires: '2099-01-01T00:00:00Z', account: { id: 'personal', planType: 'free' } };
const entitlement = {
  subscription_id: 'sub-personal', has_active_subscription: true, subscription_plan: 'chatgptplusplan',
  expires_at: '2026-11-15T18:44:54+00:00', renews_at: '2026-11-15T12:44:54+00:00',
  billing_period: 'monthly', billing_currency: 'PHP', applied_benefits: [], applied_discounts: [],
};
const personal = {
  account: { account_id: 'personal', plan_type: 'plus', plan_display_name: 'Plus', structure: 'personal', account_user_role: 'account-owner', is_trial: false },
  features: ['search_tool', 'wham', 'canvas', 'search_tool', 'unknown_flag'], entitlement,
};
const subscription = {
  plan_type: 'plus', is_active: true, will_renew: false, seats_in_use: 1, seats_entitled: 1,
  active_start: '2026-10-15T12:44:54Z', active_until: '2026-11-15T12:44:54Z',
  billing_period: 'monthly', billing_currency: 'PHP', entitlement,
  last_active_subscription: { subscription_id: 'sub-personal', purchase_origin_platform: 'chatgpt_web', will_renew: false },
};
const observations = [
  { path: ACCOUNT, data: { accounts: { personal, default: personal } } },
  { path: BILLING, data: subscription },
  { path: USAGE, data: {
    account_id: 'personal', rate_limit: { allowed: true, limit_reached: false,
      primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1792087067 } },
    credits: { has_credits: false, unlimited: false, balance: '0' },
    model_usage: { 'example-model': { available: false, available_at: null } },
  } },
];

test('真实响应结构：Plus 优先于旧会话，取消续费保留有效权益，两种到期日期分开', () => {
  const plan = normalizePlan(session, observations);
  assert.equal(plan.planName, 'Plus');
  assert.equal(plan.status, 'active-cancelled');
  assert.equal(plan.willRenew, false);
  assert.equal(plan.renewsAt, null);
  assert.equal(plan.periodEndsAt, '2026-11-15T12:44:54.000Z');
  assert.equal(plan.entitlementExpiresAt, '2026-11-15T18:44:54.000Z');
  assert.equal(plan.workspaces.length, 1);
  assert.equal(plan.isTrial, false);
  assert.equal(plan.source, 'account-api');
  assert.deepEqual(plan.entitlements.map(item => item.name), ['网页搜索', 'Codex', 'Canvas']);
  assert.ok(plan.featureFlags.includes('unknown_flag'));
  assert.equal(plan.usage.primary.usedPercent, 0);
  assert.equal(plan.usage.limitReached, false);
  assert.equal(plan.usage.credits.balance, '0');
  assert.equal(plan.usage.models[0].available, false);
  assert.equal(Object.hasOwn(plan, 'observations'), false);
  assert.equal(Object.hasOwn(plan, 'accessToken'), false);
});

test('免费、未知和仅会话套餐不伪造订阅日期；秒和毫秒时间正确转换', () => {
  const fallback = normalizePlan(session, []);
  assert.equal(fallback.status, 'unknown');
  assert.equal(fallback.expiresAt, null);
  assert.equal(fallback.source, 'session');
  assert.ok(fallback.warnings.length);
  const free = normalizePlan(session, [{ path: ACCOUNT, data: { accounts: { personal: { account: { account_id: 'personal', plan_type: 'free' }, features: [] } } } }]);
  assert.equal(free.status, 'free');
  assert.equal(free.expiresAt, null);
  assert.equal(normalizePlan({}, []).planType, 'unknown');
  assert.equal(isoDate(1792087067), isoDate(1792087067000));
  assert.equal(isoDate('1792087067'), isoDate(1792087067));
  for (const value of [null, undefined, '', false, true, {}, 'invalid']) assert.equal(isoDate(value), null);
  const active = normalizePlan(session, [...observations, { path: BILLING, data: { ...subscription, will_renew: true } }]);
  assert.equal(active.status, 'active');
  assert.equal(active.renewsAt, '2026-11-15T12:44:54.000Z');
});

test('订阅仅返回部分权益时从匹配的账号读取到期日期，无效账单时间回退到本期结束', () => {
  const value = normalizePlan(session, [...observations, { path: BILLING, data: {
    ...subscription, entitlement: { subscription_id: entitlement.subscription_id },
    active_until: 'invalid', current_billing_period: { end: '2026-11-18T00:00:00Z' },
  } }]);
  assert.equal(value.entitlementExpiresAt, '2026-11-15T18:44:54.000Z');
  assert.equal(value.periodEndsAt, '2026-11-18T00:00:00.000Z');
  const fresh = normalizePlan(session, [...observations, { path: BILLING, data: {
    ...subscription, entitlement: { ...entitlement, expires_at: 'invalid', subscription_expires_at: 1800000000 },
  } }]);
  assert.equal(fresh.entitlementExpiresAt, isoDate(1800000000));
});

test('工作区隔离：不混入其他工作区或归属无法确认的账单及 Codex 额度', () => {
  const team = { account: { account_id: 'team', plan_type: 'team', name: 'Team' }, entitlement: { subscription_id: 'sub-team' } };
  const accounts = { path: ACCOUNT, data: { accounts: { team, personal, default: team } } };
  const wrong = normalizePlan(session, [accounts,
    { path: BILLING, data: { plan_type: 'team', account_id: 'team', entitlement: team.entitlement, active_until: '2030-01-01T00:00:00Z' } },
    { path: USAGE, data: { account_id: 'team' } },
  ]);
  assert.equal(wrong.planType, 'plus');
  assert.equal(wrong.periodEndsAt, null);
  assert.equal(wrong.entitlementExpiresAt, '2026-11-15T18:44:54.000Z');
  assert.equal(wrong.usage, null);
  assert.ok(wrong.warnings.some(value => value.includes('工作区')));
  const uncertain = normalizePlan(session, [accounts, { path: BILLING, data: { plan_type: 'team' } }]);
  assert.equal(uncertain.planType, 'plus');
  const matched = normalizePlan(session, [accounts, { path: BILLING, data: subscription }]);
  assert.equal(matched.periodEndsAt, '2026-11-15T12:44:54.000Z');
});

test('Pro 档位使用已核对订阅代码或官网当前套餐，支持 100 / 200 / 500', () => {
  const proData = (code, type = 'pro') => [{ path: ACCOUNT, data: { accounts: { personal: {
    account: { account_id: 'personal', plan_type: type, plan_display_name: 'Pro' },
    entitlement: { has_active_subscription: true, subscription_plan: code },
  } } } }];
  for (const [code, tier, type] of [['chatgptprolite', 100, 'prolite'], ['chatgptpro', 200, 'pro'], ['chatgptpro500', 500, 'pro']]) {
    const plan = normalizePlan(session, proData(code, type));
    assert.equal(plan.planFamily, 'pro');
    assert.equal(plan.proTier, tier);
    assert.equal(plan.planName, `Pro ${tier}`);
    assert.equal(plan.proTierStatus, 'identified');
    assert.ok(plan.proTierEvidence.length);
  }
  const explicitPage = normalizePlan(session, proData('unknown-pro-product'), [], 500);
  assert.equal(explicitPage.proTier, 500);
  assert.equal(explicitPage.proTierSource, '官网当前套餐');
  const generic = normalizePlan(session, proData(null));
  assert.equal(generic.proTier, null);
  assert.equal(generic.planName, 'Pro（档位未确认）');
  const conflict = normalizePlan(session, proData('chatgptprolite'), [], 200);
  assert.equal(conflict.proTier, null);
  assert.equal(conflict.proTierStatus, 'conflict');
  assert.ok(conflict.warnings.some(message => message.includes('档位信息不一致')));
  const oldSession = normalizePlan({ account: { id: 'personal', planType: 'pro200' } }, []);
  assert.equal(oldSession.proTier, null);
  const withCredits = normalizePlan(session, [...proData(null), { path: USAGE, data: { account_id: 'personal', plan_type: 'pro', credits: { balance: '500' } } }]);
  assert.equal(withCredits.proTier, null);
});

test('官网档位只从当前套餐提示读取，不把升级选项、旧账单或余额当作当前权益', () => {
  assert.equal(billingProTier("ChatGPT Pro 100\nYour plan is canceled and won't renew. You'll continue to have access to ChatGPT Pro 100 until Nov 16, 2026\nChatGPT Pro 500\nPaid ₱100"), 100);
  assert.equal(billingProTier('ChatGPT Pro 200\nYour plan auto-renews on Nov 16, 2026'), 200);
  assert.equal(billingProTier('ChatGPT Pro 500\nYour subscription will renew on Nov 16, 2026'), 500);
  assert.equal(billingProTier('Upgrade to Pro 500\nChatGPT Pro 100\nBilling history\n$200'), null);
  assert.equal(billingProTier('ChatGPT Pro 100\nYour plan renews tomorrow\nChatGPT Pro 500\nYour plan renews tomorrow'), null);
});

test('其他工作区账单或未匹配的当前会话不能提供 Pro 档位', () => {
  const entries = { personal: { account: { account_id: 'personal', plan_type: 'pro', plan_display_name: 'Pro' }, entitlement: { has_active_subscription: true } },
    other: { account: { account_id: 'other', plan_type: 'pro' }, entitlement: { subscription_plan: 'chatgptpro500' } } };
  const plan = normalizePlan(session, [{ path: ACCOUNT, data: { accounts: entries } }, { path: BILLING, data: { account_id: 'other', plan_type: 'pro', entitlement: { subscription_plan: 'chatgptpro500' } } }], [], 500);
  assert.equal(plan.proTier, null);
  assert.ok(plan.warnings.length);
});

function mockPage(identity = session, failBilling = false, unreadBilling = false) {
  const page = new EventEmitter();
  page.urls = [];
  page.retried = [];
  page.request = { get: async (url, options) => {
    page.retried.push({ url, options });
    return { ok: () => !failBilling, status: () => 503, json: async () => subscription, dispose: async () => {} };
  } };
  page.locator = () => ({ innerText: async () => JSON.stringify(identity) });
  page.waitForResponse = predicate => new Promise(resolve => {
    const listener = response => {
      if (predicate(response)) { page.off('response', listener); resolve(response); }
    };
    page.on('response', listener);
    setTimeout(() => { page.off('response', listener); resolve(null); }, 5);
  });
  page.goto = async url => {
    page.urls.push(url);
    if (url.endsWith('/api/auth/session')) return;
    if (url.endsWith('/settings/billing') && failBilling) throw new Error('billing offline');
    page.emit('response', { url: () => `https://chatgpt.com${ACCOUNT}`, request: () => ({ method: () => 'GET' }), ok: () => false, status: () => 401 });
    page.emit('response', { url: () => `https://chatgpt.com${ACCOUNT}`, request: () => ({ method: () => 'GET' }), ok: () => true,
      headers: () => ({ 'content-type': 'application/json' }), json: async () => { throw new Error('aborted response'); } });
    for (const entry of observations.filter(item => url.endsWith('/settings/billing') ? item.path === BILLING : item.path !== BILLING)) {
      page.emit('response', { url: () => `https://chatgpt.com${entry.path}`, request: () => ({ method: () => 'GET', allHeaders: async () => ({ ':authority': 'chatgpt.com', authorization: 'Bearer fixture', 'chatgpt-account-id': 'personal' }) }),
        ok: () => true, headers: () => ({ 'content-type': 'application/json' }), json: async () => {
          if (unreadBilling && entry.path === BILLING) throw new Error('Protocol error: No resource with given identifier found');
          return entry.data;
        } });
    }
  };
  return page;
}

test('读取流程校验完整 +1 邮箱，仅访问会话、首页与账单页，账单失败仍保留权益', async () => {
  const options = { email: session.user.email, signal: new AbortController().signal, log: () => {} };
  const page = mockPage();
  const plan = await fetchPlanDetails({ ...options, page });
  assert.equal(plan.status, 'active-cancelled');
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(page.urls, ['https://chatgpt.com/api/auth/session', 'https://chatgpt.com/', 'https://chatgpt.com/settings/billing']);
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(page.retried.length, 0);
  const wrong = mockPage({ ...session, user: { email: 'alice@example.test' } });
  await assert.rejects(fetchPlanDetails({ ...options, page: wrong }), /邮箱不匹配/);
  assert.equal(wrong.urls.length, 1);
  const partial = await fetchPlanDetails({ ...options, page: mockPage(session, true) });
  assert.equal(partial.planType, 'plus');
  assert.equal(partial.periodEndsAt, null);
  assert.ok(partial.warnings.length);
});

test('浏览器丢失正文时仅重试原同源 GET，不跟随重定向，不重试已取得的数据', async () => {
  const page = mockPage(session, false, true);
  const plan = await fetchPlanDetails({ page, email: session.user.email, signal: new AbortController().signal, log: () => {} });
  assert.equal(plan.periodEndsAt, '2026-11-15T12:44:54.000Z');
  assert.deepEqual(plan.warnings, []);
  assert.equal(page.retried.length, 1);
  assert.equal(page.retried[0].url, `https://chatgpt.com${BILLING}`);
  assert.equal(page.retried[0].options.maxRedirects, 0);
  assert.equal(page.retried[0].options.headers['chatgpt-account-id'], 'personal');
  assert.equal(page.retried[0].options.headers[':authority'], undefined);
});

test('新版账单页未发送订阅请求时，用已观察的同源鉴权补读现有订阅接口', async () => {
  const page = mockPage();
  const goto = page.goto;
  page.goto = async url => {
    if (url.endsWith('/settings/billing')) { page.urls.push(url); return; }
    return goto(url);
  };
  const plan = await fetchPlanDetails({ page, email: session.user.email, signal: new AbortController().signal, log: () => {} });
  assert.equal(plan.periodEndsAt, '2026-11-15T12:44:54.000Z');
  assert.equal(page.retried.length, 1);
  assert.equal(page.retried[0].url, `https://chatgpt.com${BILLING}`);
  assert.equal(page.retried[0].options.maxRedirects, 0);
});

const config = { port: 0, mail: { url: '' }, batch: { headless: true, delayBetweenAccountsMs: 0, perAccountTimeoutMs: 1000 } };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-plans-test-'));
  const options = { dir, accountsFile: path.join(dir, 'accounts.txt'), infoFile: path.join(dir, 'info.json') };
  fs.writeFileSync(options.accountsFile, `${session.user.email}\nbob@example.test`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { ...options, store: new Store(options) };
}

test('套餐原子保存、重启恢复、事件推送，磁盘写入失败回滚', t => {
  const f = fixture(t);
  const plan = normalizePlan(session, observations);
  let event;
  f.store.subscribe(value => { event = value; });
  f.store.savePlan(session.user.email, plan);
  assert.deepEqual(event, { email: session.user.email, plan });
  assert.deepEqual(new Store(f).listAccounts()[0].plan, plan);
  assert.equal(fs.statSync(f.store.plansFile).mode & 0o777, 0o600);
  const saved = fs.readFileSync(f.store.plansFile, 'utf8');
  f.store.plansFile = path.join(f.dir, 'missing', 'plans.json');
  assert.throws(() => f.store.savePlan(session.user.email, { error: 'failed' }));
  assert.deepEqual(f.store.plans.get(session.user.email), plan);
  assert.equal(fs.readFileSync(path.join(f.dir, 'plans.json'), 'utf8'), saved);
});

test('套餐查询失败保留上次结果和可用会话，后续账号继续读取', async t => {
  const { store } = fixture(t);
  const plan = normalizePlan(session, observations);
  const email = session.user.email;
  store.saveInfo(email, session);
  store.getAccount(email).info = session;
  store.savePlan(email, plan);
  const worker = new LoginWorker({ store, config });
  worker._fetchPlan = async value => {
    if (value === email) throw new Error('会话已失效，请先重新登录');
    store.savePlan(value, { ...plan, planName: 'Free' });
    store.setStatus(value, 'idle');
  };
  worker.enqueue([email, 'bob@example.test'], 'plan');
  await worker.drainPromise;
  const account = store.listAccounts()[0];
  assert.equal(account.status, 'ok');
  assert.equal(account.error, null);
  assert.equal(account.plan.fetchedAt, plan.fetchedAt);
  assert.equal(account.plan.expiresAt, plan.expiresAt);
  assert.match(account.plan.error, /重新登录/);
  assert.ok(account.plan.attemptedAt);
  assert.equal(store.plans.get('bob@example.test').planName, 'Free');
  assert.equal(worker.running, false);
});

test('部分读取缺失时保存当前套餐，保留同一订阅的账单日期并标注原始读取时间', async t => {
  const { store } = fixture(t);
  const email = session.user.email;
  store.saveProfile(email, { cookies: [], origins: [] });
  const previous = { ...normalizePlan(session, observations), planType: 'pro', planName: 'Pro' };
  store.savePlan(email, previous);
  const next = { ...previous, availability: { ...previous.availability, billing: false }, periodEndsAt: null, planFamily: 'pro', proTier: 200, planName: 'Pro 200', proTierSource: '官网当前套餐', proTierStatus: 'identified', proTierEvidence: [{ source: '官网当前套餐', value: 'ChatGPT Pro 200', tier: 200 }], fetchedAt: '2026-10-16T00:00:00Z' };
  const vm = require('node:vm');
  const workerFile = require.resolve('../src/worker');
  const load = require('node:module').createRequire(workerFile);
  const exports = { exports: {} };
  vm.runInNewContext(fs.readFileSync(workerFile, 'utf8'), { module: exports, require: name => name === './plans' ? { fetchPlanDetails: async () => next, mergePlanSnapshot }
    : name === './browser' ? { getBrowser: async () => ({}), newContext: async () => ({ newPage: async () => ({}), close: async () => {} }) } : load(name) });
  const worker = new exports.exports({ store, config });
  await worker._fetchPlan(email, { signal: new AbortController().signal, contexts: new Set() });
  const saved = store.plans.get(email);
  assert.equal(saved.proTier, 200);
  assert.equal(saved.planName, 'Pro 200');
  assert.equal(saved.periodEndsAt, previous.periodEndsAt);
  assert.equal(saved.fetchedAt, next.fetchedAt);
  assert.equal(saved.error, null);
  assert.equal(saved.partial, false);
  assert.equal(saved.missingSections.length, 0);
  assert.equal(saved.sectionFetchedAt.billing, previous.fetchedAt);
  assert.equal(saved.cachedSections[0].section, 'billing');
});

test('空权益是有效更新；缺失额度可留旧记录，但不跨工作区、Pro 档位或订阅周期复用', () => {
  const previous = normalizePlan(session, observations);
  const fresh = { ...previous, fetchedAt: '2026-10-16T00:00:00Z', entitlements: [], featureFlags: [], usage: null,
    availability: { ...previous.availability, usage: false } };
  const partial = mergePlanSnapshot({ ...previous, error: '旧错误' }, fresh);
  assert.deepEqual(partial.entitlements, []);
  assert.deepEqual(partial.usage, previous.usage);
  assert.equal(partial.error, null);
  assert.deepEqual(partial.cachedSections.map(item => item.section), ['usage']);
  const other = mergePlanSnapshot(previous, { ...fresh, accountId: 'other' });
  assert.equal(other.usage, null);
  const upgraded = mergePlanSnapshot({ ...previous, planType: 'pro', proTier: 100 }, { ...fresh, planType: 'pro', proTier: 200 });
  assert.equal(upgraded.usage, null);
  const renewed = mergePlanSnapshot(previous, { ...fresh, periodEndsAt: null, entitlementExpiresAt: '2027-01-01T00:00:00Z', availability: { ...fresh.availability, billing: false } });
  assert.equal(renewed.periodEndsAt, null);
  const changedSubscription = mergePlanSnapshot(previous, { ...fresh, periodEndsAt: null, subscriptionId: 'different', availability: { ...fresh.availability, billing: false } });
  assert.equal(changedSubscription.periodEndsAt, null);
  assert.throws(() => mergePlanSnapshot(previous, normalizePlan(session, [])), /未能读取官网套餐信息/);
  const recovered = mergePlanSnapshot(partial, normalizePlan(session, observations));
  assert.equal(recovered.partial, false);
  assert.deepEqual(recovered.cachedSections, []);
});

test('页面启动时的旧鉴权 401 会使用已核对 Session 重试；仍是 401 时明确要求重新登录', async () => {
  const page = mockPage();
  page.goto = async url => { page.urls.push(url); };
  page.request.get = async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer fixture');
    assert.equal(options.headers['chatgpt-account-id'], 'personal');
    assert.equal(options.maxRedirects, 0);
    return { ok: () => true, json: async () => observations.find(item => url.endsWith(item.path)).data, dispose: async () => {} };
  };
  const opts = { page, email: session.user.email, signal: new AbortController().signal, log: () => {} };
  const plan = await fetchPlanDetails(opts);
  assert.equal(plan.planType, 'plus');
  assert.equal(plan.availability.membership, true);
  page.request.get = async () => ({ ok: () => false, status: () => 401, dispose: async () => {} });
  await assert.rejects(fetchPlanDetails(opts), /HTTP 401.*重新登录/);
});

test('套餐 401 自动恢复一次会话后重试，第二次 401 停止；缺密码或候选未确认时不自动登录', async t => {
  const { store } = fixture(t);
  const email = session.user.email;
  store.saveProfile(email, { cookies: [], origins: [] });
  store.writeAccountsFile(`${email}----https://mail.example.test/inbox----BH4OWU3OMXPJ7P63`);
  const workerFile = require.resolve('../src/worker');
  const load = require('node:module').createRequire(workerFile);
  const vm = require('node:vm');
  let attempts = 0;
  let refreshes = 0;
  let closes = 0;
  let rejectEveryTime = false;
  const exports = { exports: {} };
  vm.runInNewContext(fs.readFileSync(workerFile, 'utf8'), { module: exports, require: name => name === './plans' ? {
    mergePlanSnapshot,
    fetchPlanDetails: async () => {
      attempts++;
      if (attempts === 1 || rejectEveryTime) throw Object.assign(new Error('会话已失效（HTTP 401）'), { code: 'PLAN_SESSION_EXPIRED' });
      return normalizePlan(session, observations);
    },
  } : name === './browser' ? { getBrowser: async () => ({}), newContext: async () => ({ newPage: async () => ({}), close: async () => { closes++; } }) } : load(name) });
  const worker = new exports.exports({ store, config });
  worker._verifyPassword = async () => { assert.equal(closes, 1); assert.equal(store.getTwofaSecret(email), 'BH4OWU3OMXPJ7P63'); refreshes++; };
  const task = () => ({ signal: new AbortController().signal, contexts: new Set() });
  store.recordPassword(email, { password: 'FixtureOnly12!' });
  await worker._fetchPlan(email, task());
  assert.equal(attempts, 2); assert.equal(refreshes, 1); assert.equal(closes, 2);
  assert.equal(store.plans.get(email).error, null);
  attempts = refreshes = closes = 0; rejectEveryTime = true;
  await assert.rejects(worker._fetchPlan(email, task()), /HTTP 401/);
  assert.equal(attempts, 2); assert.equal(refreshes, 1);
  attempts = refreshes = closes = 0;
  store.preparePassword(email, 'CandidateOnly!'); store.recordPassword(email, { submittedAt: new Date().toISOString() });
  await assert.rejects(worker._fetchPlan(email, task()), /HTTP 401/);
  assert.equal(attempts, 1); assert.equal(refreshes, 0);
  attempts = closes = 0; store.passwords.delete(email);
  await assert.rejects(worker._fetchPlan(email, task()), /HTTP 401/);
  assert.equal(attempts, 1); assert.equal(refreshes, 0);
});

test('套餐 API 支持全部/所选、去重和参数校验，队列与原任务互斥', async t => {
  const { store } = fixture(t);
  const worker = new LoginWorker({ store, config });
  worker._fetchPlan = async () => new Promise(() => {});
  const server = createServer({ store, worker, config, publicDir: path.join(__dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await worker.stop(); server.closeEvents(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(base + '/api/plans/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const body of [null, { emails: [] }, { emails: [1] }, { emails: ['unknown@example.test'] }]) assert.equal((await post(body)).status, 400);
  assert.equal((await fetch(base + '/api/plans/refresh')).status, 405);
  const chosen = await post({ emails: [' ALICE+1@EXAMPLE.TEST ', session.user.email] });
  assert.equal(chosen.status, 202);
  assert.equal((await chosen.json()).queued, 1);
  assert.equal(worker.operations.get(session.user.email), 'plan');
  assert.equal(worker.enqueue([session.user.email], 'login').length, 0);
  const all = await post({});
  assert.equal((await all.json()).queued, 1);
  assert.equal((await (await post({})).json()).queued, 0);
  assert.equal((await fetch(base + '/plans.json')).status, 404);
  assert.equal(worker.clearQueue(), 1);
  assert.equal(store.getAccount('bob@example.test').status, 'idle');
});

test('窗口响应缺少窗口数据时保留旧额度并标注缓存，账单和功能缺失不算额度缺失', () => {
  const previous = normalizePlan(session, observations);
  const partial = normalizePlan(session, observations.map(item => item.path === USAGE ? { ...item, data: { account_id: 'personal', rate_limit: { allowed: true } } } : item));
  assert.equal(partial.availability.usage, false);
  const merged = mergePlanSnapshot(previous, partial);
  assert.equal(merged.partial, true);
  assert.deepEqual(merged.usage, previous.usage);
  assert.equal(merged.cachedSections.find(item => item.section === 'usage').fetchedAt, previous.fetchedAt);
  const minimal = mergePlanSnapshot(previous, { ...previous, availability: { membership: true, usage: true, billing: false, features: false } });
  assert.equal(minimal.partial, false);
  assert.deepEqual(minimal.missingSections, []);
});
