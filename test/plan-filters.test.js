const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { frontend } = require('./helpers/frontend');

const plan = (planType, status, patch = {}) => ({ plan: { planType, status, fetchedAt: '2026-10-15T00:00:00Z', ...patch } });

test('套餐筛选区分 Free、Plus、Pro、Business 与未获取，不把未知归为免费或付费', async () => {
  const { matches } = await frontend();
  const free = plan('free', 'free');
  const plus = plan('plus', 'active-cancelled');
  const pro = plan('pro', 'active');
  assert.equal(matches(free, { plan: 'free' }), true);
  assert.equal(matches(plus, { plan: 'plus' }), true);
  assert.equal(matches(pro, { plan: 'pro' }), true);
  assert.equal(matches(plan('prolite', 'active', { planName: 'Pro' }), { plan: 'pro' }), true);
  assert.equal(matches(plan('prolite', 'active', { planName: 'Pro' }), { plan: 'paid' }), true);
  assert.equal(matches(pro, { plan: 'plus' }), false);
  assert.equal(matches(plan('team', 'active'), { plan: 'business' }), true);
  assert.equal(matches(plus, { plan: 'paid' }), true);
  assert.equal(matches(free, { plan: 'paid' }), false);
  for (const missing of [{}, { plan: { error: '会话过期' } }]) {
    assert.equal(matches(missing, { plan: 'unfetched' }), true);
    assert.equal(matches(missing, { plan: 'free' }), false);
    assert.equal(matches(missing, { plan: 'paid' }), false);
  }
  assert.equal(matches(plan('unknown', 'unknown'), { plan: 'unknown' }), true);
});

test('Pro 100 / 200 / 500 精确筛选，同时保留全部 Pro 和未确认档位', async () => {
  const { matches, controls, context } = await frontend();
  const variants = [100, 200, 500].map(tier => plan('pro', 'active-cancelled', { planFamily: 'pro', proTier: tier, planName: `Pro ${tier}`, willRenew: false }));
  const unknown = plan('pro', 'active', { planFamily: 'pro', proTier: null, planName: 'Pro（档位未确认）' });
  for (const account of [...variants, unknown]) {
    assert.equal(matches(account, { plan: 'pro' }), true);
    assert.equal(matches(account, { plan: 'paid' }), true);
  }
  for (const tier of [100, 200, 500]) {
    assert.equal(variants.filter(account => matches(account, { plan: `pro-${tier}` })).length, 1);
    assert.equal(matches(unknown, { plan: `pro-${tier}` }), false);
  }
  assert.equal(matches(unknown, { plan: 'pro-unknown' }), true);
  assert.equal(matches(plan('free', 'free'), { plan: 'pro-unknown' }), false);
  context.fixtures = [...variants, unknown];
  context.app.accounts = context.fixtures;
  context.updateMembershipOptions();
  assert.match(controls['#planFilter'].innerHTML, /Pro（全部档位）（4）/);
  for (const tier of [100, 200, 500]) assert.ok(controls['#planFilter'].innerHTML.includes(`Pro ${tier}（1）`));
  assert.match(controls['#planFilter'].innerHTML, /Pro（档位未确认）（1）/);
});

test('会员类别、邮箱搜索和会话状态取交集，排序不改变匹配范围', async () => {
  const { controls, context } = await frontend();
  context.fixtures = [
    { email: 'z+1@example.test', mailUrl: 'https://mail.example.test/a', status: 'ok', info: { accessToken: 'fixture' }, ...plan('plus', 'active-cancelled', { willRenew: false, entitlements: [{ code: 'wham', name: 'Codex' }] }) },
    { email: 'a@example.test', mailUrl: 'https://mail.example.test/b', status: 'idle', ...plan('plus', 'active-cancelled', { willRenew: false, entitlements: [{ code: 'wham', name: 'Codex' }] }) },
    { email: 'b@example.test', mailUrl: '', status: 'idle', ...plan('free', 'free', { entitlements: [{ code: 'wham', name: 'Codex' }] }) },
  ];
  context.app.accounts = context.fixtures;
  controls['#planFilter'].value = 'plus';
  controls['#sortSelect'].value = 'email';
  assert.deepEqual(Array.from(context.filteredAccounts(), a => a.email), ['a@example.test', 'z+1@example.test']);
  controls['#searchInput'].value = '+1';
  assert.deepEqual(Array.from(context.filteredAccounts(), a => a.email), ['z+1@example.test']);
  context.app.filter = 'attention';
  assert.equal(context.filteredAccounts().length, 0);
  context.app.filter = 'ready';
  assert.equal(context.filteredAccounts().length, 1);
  controls['#planFilter'].value = 'pro';
  assert.equal(context.filteredAccounts().length, 0);
});

test('筛选选项随套餐快照更新、转义文字；当前条件消失时保留零匹配，不自动放宽', async () => {
  const { controls, context } = await frontend();
  context.fixtures = [plan('plus', 'active', { entitlements: [{ code: 'wham', name: 'Codex' }, { code: 'test"value', name: '<test>' }] }), plan('free', 'free'), plan('test\"<type>', 'unknown')];
  context.app.accounts = context.fixtures;
  context.updateMembershipOptions();
  assert.match(controls['#planFilter'].innerHTML, /Plus（1）/);
  assert.match(controls['#planFilter'].innerHTML, /Free（1）/);
  assert.match(controls['#planFilter'].innerHTML, /&lt;type&gt;/);
  assert.match(controls['#planFilter'].innerHTML, /test&quot;/);
  controls['#planFilter'].value = 'plus';
  context.app.accounts = [];
  context.updateMembershipOptions();
  assert.equal(controls['#planFilter'].value, 'plus');
  assert.match(controls['#planFilter'].innerHTML, /Plus（0）/);
  assert.equal(context.filteredAccounts().length, 0);
});

test('已取得当前套餐的部分更新显示缺失项与原时间，不显示查询失败', async () => {
  const { context } = await frontend();
  const html = context.planHTML({ email: 'alice@example.test', status: 'ok', plan: {
    planName: 'Plus', planType: 'plus', status: 'active', fetchedAt: '2026-10-16T00:00:00Z',
    error: null, partial: true, missingSections: [{ section: 'usage', label: 'Codex 额度' }],
    cachedSections: [{ section: 'usage', label: 'Codex 额度', fetchedAt: '2026-10-15T00:00:00Z' }],
    usage: { allowed: true },
  } });
  assert.match(html, /会员类别已更新/);
  assert.match(html, /窗口额度沿用/);
  assert.match(html, /窗口额度（上次记录）/);
  assert.ok(!html.includes('会员信息更新失败'));
});

test('会员详情保留类别、日期及窗口额度，零使用量、满额、未知值和重置时间正常显示', async () => {
  const { context } = await frontend();
  const record = { planName: 'Pro', proTier: 500, fetchedAt: '2026-10-21T00:00:00Z',
    entitlements: [{ name: 'HIDDEN_FEATURE' }], benefits: ['HIDDEN_BENEFIT'], currency: 'HIDDEN_CURRENCY',
    usage: { primary: { usedPercent: 0, windowSeconds: 18000, resetsAt: '2026-10-22T00:00:00Z' },
      secondary: { usedPercent: 100, windowSeconds: 604800 }, codeReview: { usedPercent: null } } };
  const html = context.planHTML({ email: 'fixture@example.test', plan: record }, true);
  assert.match(html, /Pro 500/);
  assert.match(html, /5 小时/); assert.match(html, /7 天/);
  assert.match(html, /value="0"/); assert.match(html, /value="100"/);
  assert.match(html, /使用量未知/); assert.match(html, /重置于/);
  assert.doesNotMatch(html, /HIDDEN_|订阅开始|计费周期|功能权益|积分余额/);
  assert.match(context.quotaSummary(record), /5 小时 已用 0%/);
  assert.match(context.quotaSummary(record), /7 天 已用 100%/);
  const legacy = context.planHTML({ email: 'fixture@example.test', plan: { ...record, partial: true, missingSections: [{ section: 'features' }, { section: 'billing' }] } }, true);
  assert.doesNotMatch(legacy, /class="plan-partial"/);
  assert.match(context.planHTML({ email: 'fixture@example.test' }, true), /登录成功后自动查询/);
  const shell = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.doesNotMatch(shell, /id="(?:entitlementFilter|subscriptionFilter)"/);
  assert.match(shell, /id="detailRefreshPlan"/);
  assert.match(shell, /id="btnPlansFiltered"/);
  assert.match(shell, /id="btnPlansSelected"/);
});

test('会员到期优先显示官网权益日期，本期结束单独标识，未知和免费不使用会话有效期', async () => {
  const { context } = await frontend();
  const record = { planType: 'pro', proTier: 200, fetchedAt: '2026-10-22T00:00:00Z',
    entitlementExpiresAt: '2026-11-20T04:00:00Z', periodEndsAt: '2026-11-19T04:00:00Z' };
  assert.equal(context.expirySummary(record, true), '到期 2026-11-20');
  const fallback = { ...record, entitlementExpiresAt: null };
  assert.equal(context.expirySummary(fallback, true), '本期结束 2026-11-19');
  assert.match(context.expirySummary({ ...fallback, cachedSections: [{ section: 'billing' }] }), /上次记录/);
  assert.doesNotMatch(context.expirySummary({ ...record, cachedSections: [{ section: 'billing' }] }), /上次记录/);
  assert.match(context.expirySummary({ ...record, error: 'refresh failed' }), /上次记录/);
  assert.equal(context.expirySummary({ ...record, planType: 'free' }), '免费账号 · 无订阅到期时间');
  const unknown = { fetchedAt: record.fetchedAt, entitlementExpiresAt: 'invalid', periodEndsAt: null };
  assert.equal(context.expirySummary(unknown), '到期时间暂未返回');
  const html = context.planHTML({ email: 'expiry@example.test', info: { expires: '2099-01-01' }, plan: unknown }, true);
  assert.match(html, /到期时间暂未返回/);
  assert.doesNotMatch(html, /2099/);
  const card = context.accountHTML({ email: 'expiry@example.test', plan: record });
  assert.match(card, /Pro 200/);
  assert.match(card, /到期 2026-11-20/);
  assert.match(context.planHTML({ email: 'expiry@example.test', plan: record }, true), /class="plan-expiry">到期 /);
});
