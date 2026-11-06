import { app, STATUS_ORDER, active, usable, status, attention, scheduleRender as render } from './state.mjs';
import { $, esc } from './ui.mjs';
const PLAN_FILTER_NAMES = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro（全部档位）', 'pro-100': 'Pro 100', 'pro-200': 'Pro 200', 'pro-500': 'Pro 500', 'pro-unknown': 'Pro（档位未确认）', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', unknown: '套餐未确认', unfetched: '尚未获取套餐' };
const PAID_PLANS = new Set(['go', 'plus', 'pro', 'business', 'enterprise', 'edu']);
export function filterPlanType(account) {
  if (!account.plan?.fetchedAt) return 'unfetched';
  const type = account.plan.planType || 'unknown';
  const displayType = String(account.plan.planName || '').toLowerCase();
  if (account.plan.planFamily === 'pro' || /^pro(?:\s|（|$)/i.test(displayType)) return 'pro';
  return type === 'team' ? 'business' : PAID_PLANS.has(displayType) || displayType === 'free' ? displayType : type;
}

export function filterProTier(account) {
  return [100, 200, 500].includes(account.plan?.proTier) ? `pro-${account.plan.proTier}` : 'pro-unknown';
}

export function matchesMembership(account, { plan = 'all' } = {}) {
  const type = filterPlanType(account);
  return plan === 'all' || (plan === 'paid' ? PAID_PLANS.has(type) : plan.startsWith('pro-') ? type === 'pro' && filterProTier(account) === plan : type === plan);
}

export function updateMembershipOptions() {
  const types = new Map();
  for (const account of app.accounts) {
    const type = filterPlanType(account);
    types.set(type, (types.get(type) || 0) + 1);
    if (type === 'pro') {
      const tier = filterProTier(account);
      types.set(tier, (types.get(tier) || 0) + 1);
    }
  }
  const update = (selector, options) => {
    const control = $(selector);
    const value = control.value;
    // 刷新套餐后保留当前条件，即便该条件暂时没有匹配项。
    if (value && !options.some(([code]) => code === value)) options.push([value, selector === '#planFilter' ? `${PLAN_FILTER_NAMES[value] || value}（0）` : control.selectedOptions[0]?.textContent || value]);
    const html = options.map(([code, label]) => `<option value="${esc(code)}">${esc(label)}</option>`).join('');
    if (control._options !== html) { control.innerHTML = html; control.value = value || 'all'; control._options = html; }
  };
  const paidCount = app.accounts.filter(account => PAID_PLANS.has(filterPlanType(account))).length;
  const order = Object.keys(PLAN_FILTER_NAMES);
  if (types.has('pro')) for (const tier of ['pro-100', 'pro-200', 'pro-500', 'pro-unknown']) if (!types.has(tier)) types.set(tier, 0);
  const planOptions = [...types].sort(([a], [b]) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)));
  update('#planFilter', [['all', `全部套餐（${app.accounts.length}）`], ['paid', `付费套餐（${paidCount}）`],
    ...planOptions.map(([type, count]) => [type, `${PLAN_FILTER_NAMES[type] || type}（${count}）`])]);
}

export function filteredAccounts() {
  const query = $('#searchInput').value.trim().toLowerCase();
  const terms = query.split(/[\s,，;；]+/).filter(Boolean);
  const membership = { plan: $('#planFilter').value };
  const items = app.accounts.filter(account => {
    const matches = app.filter === 'all' || (app.filter === 'ready' && usable(account)) ||
      (app.filter === 'active' && active(account)) || (app.filter === 'attention' && attention(account)) || (app.filter === 'unavailable' && account.unavailable);
    return matches && matchesMembership(account, membership) && (!terms.length || terms.some(term => `${account.email} ${account.mailUrl}`.toLowerCase().includes(term)));
  });
  const sort = $('#sortSelect').value;
  if (sort === 'email') items.sort((a, b) => a.email.localeCompare(b.email));
  if (sort === 'status') items.sort((a, b) => STATUS_ORDER[status(a)] - STATUS_ORDER[status(b)]);
  return items;
}

export function activeFilterChips() {
  const chips = [];
  if (app.filter !== 'all') chips.push(['status', { ready: '会话可用', active: '进行中', attention: '需处理', failed: '登录失败', unavailable: '不可用' }[app.filter] || app.filter]);
  const search = $('#searchInput').value.trim();
  if (search) chips.push(['search', `搜索：${search}`]);
  for (const [id, label] of [['planFilter', '会员类别']]) {
    const control = $('#' + id);
    if (control.value !== 'all') chips.push([id, `${label}：${control.selectedOptions[0]?.textContent || PLAN_FILTER_NAMES[control.value] || control.value}`]);
  }
  return chips;
}

export function clearFilter(key) {
  if (key === 'status') app.filter = 'all';
  else if (key === 'search') $('#searchInput').value = '';
  else if (key === 'planFilter') $('#planFilter').value = 'all';
  app.page = 1;
  render();
}

export function selectedAccounts() {
  return app.accounts.filter(account => app.selected.has(account.email));
}

export function resetFilters() {
  app.filter = 'all';
  app.page = 1;
  $('#searchInput').value = '';
  $('#planFilter').value = 'all';
  render();
}

export function paginatedAccounts(items = filteredAccounts()) {
  const pages = Math.max(1, Math.ceil(items.length / app.pageSize));
  app.page = Math.max(1, Math.min(app.page, pages));
  const start = (app.page - 1) * app.pageSize;
  return { items: items.slice(start, start + app.pageSize), start, pages, total: items.length };
}

