const PLAN_NAMES = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', team: 'Business', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' };
const ACCOUNT_PATH = '/backend-api/accounts/check/v4-2023-04-27';
const SUBSCRIPTION_PATH = '/backend-api/subscriptions';
const USAGE_PATH = '/backend-api/wham/usage';
const DATA_PATHS = new Set([ACCOUNT_PATH, SUBSCRIPTION_PATH, USAGE_PATH]);
const FEATURES = {
  browsing_available: '网页浏览', search_tool: '网页搜索', code_interpreter_available: '数据分析与代码执行',
  image_gen_tool_enabled: '图片生成', dalle_3: 'DALL·E 3', canvas: 'Canvas', canvas_code_execution: 'Canvas 代码执行',
  plugins_available: '插件', voice_advanced_ga: '高级语音', voice_mode_tool_enabled: '语音模式',
  video_screen_sharing: '视频与屏幕共享', voice_file_upload: '语音文件上传',
  voice_image_upload_wingman: '语音对话图片上传', library_sharing_management_available: '资料库分享',
  wham: 'Codex', gpt4_1: 'GPT-4.1', gpt4_1_mini: 'GPT-4.1 mini', gpt5: 'GPT-5', gpt5_mini: 'GPT-5 mini',
  o1_launch: 'o1', o3: 'o3', 'o3-mini': 'o3-mini', o4_mini: 'o4-mini',
};

function isoDate(value) {
  if (value == null || value === '' || typeof value === 'boolean' || typeof value === 'object') return null;
  const numeric = typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(value);
  const number = numeric ? Number(value) : null;
  const date = new Date(numeric ? (number < 1e12 ? number * 1000 : number) : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function planCode(value) {
  const code = String(value || 'unknown').toLowerCase();
  return code.replace(/^chatgpt/, '').replace(/plan$/, '');
}

function billingProTier(text) {
  const tiers = new Set();
  for (const match of String(text).matchAll(/continue to have access to ChatGPT Pro\s*(100|200|500)\b/gi)) tiers.add(Number(match[1]));
  const lines = String(text).split('\n').map(line => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length - 1; i++) {
    const name = lines[i].match(/^(?:ChatGPT\s+)?Pro\s*(100|200|500)$/i);
    if (name && /^Your (?:plan|subscription) (?:is |will |auto.?renews?|renews?)/i.test(lines[i + 1])) tiers.add(Number(name[1]));
  }
  return tiers.size === 1 ? [...tiers][0] : null;
}

function identifyProTier(identifiers, billingTier) {
  // 已与官网当前套餐核对：chatgptprolite = Pro 100，chatgptpro = Pro 200。
  // 泛化的 plan_type=pro、使用量和当地币种金额不能区分档位。
  const knownSubscriptions = { chatgptprolite: 100, chatgptpro: 200 };
  const evidence = [];
  const add = (source, value, subscriptionCode = false) => {
    if (typeof value !== 'string') return;
    const compact = value.toLowerCase().replace(/[\s_$-]/g, '').replace(/plan$/, '');
    const match = compact.match(/^(?:chatgpt)?pro(100|200|500)$/);
    const tier = match ? Number(match[1]) : subscriptionCode ? knownSubscriptions[compact] : null;
    if (tier) evidence.push({ source, value, tier });
  };
  add('账号订阅权益', identifiers.accountSubscriptionPlan, true);
  add('订阅权益', identifiers.subscriptionPlan, true);
  add('官网套餐名称', identifiers.accountDisplayName);
  add('套餐类型', identifiers.subscriptionPlanType);
  add('账号套餐类型', identifiers.accountPlan);
  if (billingTier) evidence.push({ source: '官网当前套餐', value: `ChatGPT Pro ${billingTier}`, tier: billingTier });
  const tiers = new Set(evidence.map(item => item.tier));
  const proTier = tiers.size === 1 ? [...tiers][0] : null;
  return { proTier, proTierSource: proTier ? (billingTier ? '官网当前套餐' : evidence[0].source) : null, proTierEvidence: evidence,
    proTierStatus: tiers.size > 1 ? 'conflict' : proTier ? 'identified' : 'unknown' };
}

function normalizePlan(session, observations, warnings = [], billingTier = null) {
  const latest = pathname => observations.filter(item => item.path === pathname).at(-1)?.data;
  const currentId = session.account?.id;
  const accounts = latest(ACCOUNT_PATH)?.accounts || {};
  const entries = [...new Map(Object.entries(accounts).filter(([key]) => key !== 'default')
    .map(([key, value]) => [value.account?.id || value.account?.account_id || key, value])).values()];
  if (!entries.length && accounts.default) entries.push(accounts.default);
  const selected = entries.find(value => currentId && (value.account?.id === currentId || value.account?.account_id === currentId))
    || (!currentId && entries.length === 1 ? entries[0] : null);
  const account = selected?.account || session.account || {};
  const extraWarnings = [...warnings];
  const candidate = latest(SUBSCRIPTION_PATH) || {};
  const accountId = currentId || account.account_id || account.id || null;
  const billingAccountId = candidate.account_id || candidate.account?.account_id || candidate.account?.id;
  const subscriptionId = candidate.entitlement?.subscription_id || candidate.last_active_subscription?.subscription_id;
  const expectedSubscriptionId = selected?.entitlement?.subscription_id || selected?.last_active_subscription?.subscription_id;
  const wrongWorkspace = (billingAccountId && accountId && billingAccountId !== accountId)
    || (subscriptionId && expectedSubscriptionId && subscriptionId !== expectedSubscriptionId)
    || (entries.length > 1 && !(billingAccountId && billingAccountId === accountId)
      && !(subscriptionId && subscriptionId === expectedSubscriptionId));
  const subscription = wrongWorkspace ? {} : candidate;
  if (wrongWorkspace && candidate.plan_type) extraWarnings.push('账单所属工作区无法确认，仅显示当前工作区的账号权益');
  const entitlement = subscription.entitlement || selected?.entitlement || {};
  const lastSubscription = subscription.last_active_subscription || selected?.last_active_subscription || {};
  const planType = planCode(subscription.plan_type || account.plan_type || account.planType || entitlement.subscription_plan);
  const hasActiveSubscription = typeof subscription.is_active === 'boolean' ? subscription.is_active
    : typeof entitlement.has_active_subscription === 'boolean' ? entitlement.has_active_subscription : selected && planType === 'free' ? false : null;
  const willRenew = typeof subscription.will_renew === 'boolean' ? subscription.will_renew
    : typeof lastSubscription.will_renew === 'boolean' ? lastSubscription.will_renew : null;
  const periodEndsAt = isoDate(subscription.active_until) || isoDate(subscription.current_billing_period?.end);
  // 订阅响应可能只含部分 entitlement；日期按字段回退到已核对工作区的账号数据。
  const entitlementExpiresAt = isoDate(subscription.entitlement?.expires_at) || isoDate(subscription.entitlement?.subscription_expires_at)
    || isoDate(selected?.entitlement?.expires_at) || isoDate(selected?.entitlement?.subscription_expires_at);
  const featureFlags = [...new Set((selected?.features || []).filter(value => typeof value === 'string'))];
  const usageData = latest(USAGE_PATH);
  const usage = usageData && (usageData.account_id ? usageData.account_id === accountId : entries.length <= 1) ? usageData : null;
  const planIdentifiers = {
    accountPlan: selected?.account?.plan_type || null, accountDisplayName: selected?.account?.plan_display_name || null,
    subscriptionPlanType: subscription.plan_type || null, subscriptionPlan: entitlement.subscription_plan || null,
    accountSubscriptionPlan: selected?.entitlement?.subscription_plan || null,
    usagePlan: usage?.plan_type || null,
  };
  const planFamily = /^pro(?:lite|plus|max|[_-]?(?:100|200|500))?$/.test(planType) || /^Pro(?:\s|$)/i.test(account.plan_display_name || '') ? 'pro' : planType;
  const proDetails = planFamily === 'pro' ? identifyProTier(planIdentifiers, entries.length <= 1 && selected ? billingTier : null) : {};
  if (proDetails.proTierStatus === 'conflict') extraWarnings.push('官网返回的 Pro 档位信息不一致，暂不确定具体档位，请刷新核实');
  const windowInfo = window => window ? {
    usedPercent: Number.isFinite(window.used_percent) ? window.used_percent : null,
    windowSeconds: window.limit_window_seconds || null, resetsAt: isoDate(window.reset_at),
  } : null;
  if (!selected && !subscription.plan_type) extraWarnings.push('未取得套餐接口数据，目前仅显示会话中的套餐，订阅状态尚未确认');
  if (!subscription.plan_type && selected && planType !== 'free') extraWarnings.push('未读取到账单补充信息，日期以账号权益接口为准');
  return {
    planType, planFamily,
    planName: planFamily === 'pro' ? (proDetails.proTier ? `Pro ${proDetails.proTier}` : 'Pro（档位未确认）')
      : (planCode(account.plan_type || account.planType) === planType && account.plan_display_name) || PLAN_NAMES[planType] || (planType === 'unknown' ? '未知套餐' : planType),
    planIdentifiers, ...proDetails,
    accountId,
    subscriptionId: entitlement.subscription_id || null,
    availability: { membership: Boolean(selected || subscription.plan_type), billing: Boolean(subscription.plan_type),
      features: Array.isArray(selected?.features), usage: Boolean(usage?.rate_limit?.primary_window || usage?.rate_limit?.secondary_window || usage?.code_review_rate_limit?.primary_window) },
    workspaceName: account.name || null, workspaceType: account.structure || account.account_type || null,
    role: account.account_user_role || null,
    hasActiveSubscription, willRenew,
    status: hasActiveSubscription === true ? (willRenew === false ? 'active-cancelled' : 'active')
      : planType === 'free' && hasActiveSubscription === false ? 'free' : hasActiveSubscription === false ? 'inactive' : 'unknown',
    activeFrom: isoDate(subscription.active_start), periodEndsAt, entitlementExpiresAt,
    expiresAt: periodEndsAt || entitlementExpiresAt,
    renewsAt: willRenew === false ? null : isoDate(entitlement.renews_at),
    cancelsAt: isoDate(entitlement.cancels_at),
    billingPeriod: subscription.billing_period || entitlement.billing_period || null,
    currency: subscription.billing_currency || entitlement.billing_currency || null,
    purchasePlatform: lastSubscription.purchase_origin_platform || null,
    isDelinquent: typeof subscription.is_delinquent === 'boolean' ? subscription.is_delinquent : entitlement.is_delinquent ?? null,
    gracePeriodEndsAt: isoDate(subscription.grace_period_end_timestamp || entitlement.grace_period_end_timestamp),
    seats: { used: subscription.seats_in_use ?? null, entitled: subscription.seats_entitled ?? null },
    isTrial: account.is_trial ?? (entitlement.trial ? true : null),
    benefits: entitlement.applied_benefits || [], discounts: entitlement.applied_discounts || [],
    scheduledPlanChange: entitlement.scheduled_plan_change || null,
    entitlements: featureFlags.filter(flag => FEATURES[flag]).map(flag => ({ code: flag, name: FEATURES[flag] })),
    featureFlags,
    usage: usage ? {
      source: 'Codex', allowed: usage.rate_limit?.allowed ?? null, limitReached: usage.rate_limit?.limit_reached ?? null,
      primary: windowInfo(usage.rate_limit?.primary_window), secondary: windowInfo(usage.rate_limit?.secondary_window),
      codeReview: windowInfo(usage.code_review_rate_limit?.primary_window),
      credits: usage.credits ? { balance: usage.credits.balance ?? null, unlimited: usage.credits.unlimited ?? null, hasCredits: usage.credits.has_credits ?? null } : null,
      models: Object.entries(usage.model_usage || {}).map(([name, value]) => ({ name, available: value.available ?? null, availableAt: isoDate(value.available_at) })),
    } : null,
    workspaces: entries.map(value => ({
      id: value.account?.id || value.account?.account_id || null,
      name: value.account?.name || null, planType: planCode(value.account?.plan_type || value.entitlement?.subscription_plan),
      role: value.account?.account_user_role || null,
    })),
    fetchedAt: new Date().toISOString(), error: null,
    warnings: [...new Set(extraWarnings)], source: selected || subscription.plan_type ? 'account-api' : 'session',
  };
}

function mergePlanSnapshot(previous, current) {
  if (current.source !== 'account-api' || !current.availability?.membership) {
    throw new Error('未能读取官网套餐信息，请稍后重试');
  }
  const result = { ...current, error: null, attemptedAt: current.fetchedAt, missingSections: [], cachedSections: [], sectionFetchedAt: {} };
  const samePlan = previous?.accountId && previous.accountId === current.accountId && previous.planType === current.planType
    && !(previous.proTier && current.proTier && previous.proTier !== current.proTier);
  const sameSubscription = samePlan && previous.hasActiveSubscription === true && current.hasActiveSubscription === true
    && !(previous.subscriptionId && current.subscriptionId && previous.subscriptionId !== current.subscriptionId)
    && !(previous.entitlementExpiresAt && current.entitlementExpiresAt && previous.entitlementExpiresAt !== current.entitlementExpiresAt);
  for (const [section, label] of Object.entries({ billing: '账单详情', features: '功能权益', usage: 'Codex 额度' })) {
    if (section === 'billing' && current.status === 'free') continue;
    if (current.availability[section]) { result.sectionFetchedAt[section] = current.fetchedAt; continue; }
    // 账单仍可辅助识别 Pro 档位；页面只要求会员类别与窗口额度完整。
    if (section === 'usage') result.missingSections.push({ section, label: '窗口额度' });
    let retained = false;
    if (section === 'billing' && sameSubscription) {
      for (const key of ['activeFrom', 'periodEndsAt', 'billingPeriod', 'currency', 'purchasePlatform']) {
        if (result[key] == null && previous[key] != null) { result[key] = previous[key]; retained = true; }
      }
      if (result.seats?.entitled == null && previous.seats?.entitled != null) { result.seats = previous.seats; retained = true; }
    }
    if (section === 'features' && samePlan && Array.isArray(previous.featureFlags)) {
      result.featureFlags = previous.featureFlags;
      result.entitlements = previous.entitlements || [];
      retained = true;
    }
    if (section === 'usage' && samePlan && previous.usage) { result.usage = previous.usage; retained = true; }
    if (retained) {
      const fetchedAt = previous.sectionFetchedAt?.[section] || previous.fetchedAt;
      result.cachedSections.push({ section, label, fetchedAt });
      result.sectionFetchedAt[section] = fetchedAt;
    }
  }
  result.partial = result.missingSections.length > 0;
  result.expiresAt = result.periodEndsAt || result.entitlementExpiresAt;
  return result;
}

async function fetchPlanDetails({ page, email, signal, log }) {
  signal.throwIfAborted();
  await page.goto('https://chatgpt.com/api/auth/session', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const session = JSON.parse(await page.locator('body').innerText());
  if (typeof session.accessToken !== 'string' || !session.accessToken || session.user?.email?.toLowerCase() !== email.toLowerCase()) throw new Error('会话已失效或邮箱不匹配，请先重新登录该账号');

  const observations = [];
  const pending = new Set();
  const warnings = [];
  const failedPaths = new Map();
  const unreadResponses = new Map();
  const successfulResponses = new Map();
  const capture = response => {
    const url = new URL(response.url());
    if (url.hostname !== 'chatgpt.com' || !DATA_PATHS.has(url.pathname) || response.request().method() !== 'GET') return;
    const reading = (async () => {
      try {
        if (!response.ok()) { failedPaths.set(url.pathname, response.status()); return; }
        if (!(response.headers()['content-type'] || '').includes('json')) return;
        observations.push({ path: url.pathname, data: await response.json() });
        successfulResponses.set(url.pathname, response);
      } catch {
        failedPaths.set(url.pathname, '响应未完整返回');
        unreadResponses.set(url.pathname, response);
      }
    })();
    pending.add(reading);
    reading.then(() => pending.delete(reading), () => pending.delete(reading));
  };
  page.on('response', capture);
  try {
    log('读取会员类别');
    const accountResponse = page.waitForResponse(response => new URL(response.url()).pathname === ACCOUNT_PATH && response.ok(), { timeout: 12000 }).catch(() => null);
    try {
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await accountResponse;
      await Promise.allSettled([...pending]);
    } catch { warnings.push('官网首页未完整加载'); }
    signal.throwIfAborted();
    log('核对会员档位、到期时间与窗口额度');
    const subscriptionResponse = page.waitForResponse(response => new URL(response.url()).pathname === SUBSCRIPTION_PATH && response.ok(), { timeout: 12000 }).catch(() => null);
    const usageResponse = observations.some(item => item.path === USAGE_PATH) ? Promise.resolve()
      : page.waitForResponse(response => new URL(response.url()).pathname === USAGE_PATH && response.ok(), { timeout: 4000 }).catch(() => null);
    try {
      await page.goto('https://chatgpt.com/settings/billing', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await subscriptionResponse;
      await usageResponse;
    } catch { warnings.push('官网账单页未完整加载'); }
    signal.throwIfAborted();
  } finally {
    page.off('response', capture);
    await Promise.allSettled([...pending]);
  }
  const dataNames = { [ACCOUNT_PATH]: '账号权益', [SUBSCRIPTION_PATH]: '账单日期', [USAGE_PATH]: 'Codex 额度' };
  // 页面启动时可能带旧鉴权或未发出请求；缺失部分用刚核对邮箱的 Session 读取固定同源 GET。
  for (const pathname of DATA_PATHS) {
    if (observations.some(item => item.path === pathname)) continue;
    signal.throwIfAborted();
    log(`重新读取${dataNames[pathname]}`);
    let retry;
    try {
      const response = unreadResponses.get(pathname) || successfulResponses.get(ACCOUNT_PATH);
      const observedHeaders = response ? await response.request().allHeaders().catch(() => ({})) : {};
      const headers = Object.fromEntries(Object.entries(observedHeaders)
        .filter(([name]) => !name.startsWith(':') && !['host', 'content-length', 'connection'].includes(name.toLowerCase())));
      headers.authorization = `Bearer ${session.accessToken}`;
      headers.accept = 'application/json';
      if (session.account?.id) headers['chatgpt-account-id'] = session.account.id;
      const retryUrl = response && new URL(response.url()).pathname === pathname ? response.url() : `https://chatgpt.com${pathname}`;
      retry = await page.request.get(retryUrl, { headers, maxRedirects: 0, timeout: 15000 });
      if (retry.ok()) observations.push({ path: pathname, data: await retry.json() });
      else failedPaths.set(pathname, retry.status());
    } catch (error) {
      failedPaths.set(pathname, '重试后仍未完整返回');
      log(`套餐读取重试未完成：${String(error.message).split('\n')[0]}`);
    }
    finally { if (retry) await retry.dispose().catch(() => {}); }
  }
  signal.throwIfAborted();
  if (!observations.some(item => item.path === ACCOUNT_PATH || item.path === SUBSCRIPTION_PATH)) {
    if (failedPaths.get(ACCOUNT_PATH) === 401 || failedPaths.get(SUBSCRIPTION_PATH) === 401) throw Object.assign(new Error('套餐接口拒绝了当前会话（HTTP 401），请重新登录该账号后再查询'), { code: 'PLAN_SESSION_EXPIRED' });
    throw new Error('未能读取官网套餐信息，请稍后重试');
  }
  for (const [pathname, status] of failedPaths) {
    // 官网会先发未登录请求，随后自动恢复；已有成功数据时不显示中间的 401。
    if (!observations.some(item => item.path === pathname)) warnings.push(`${dataNames[pathname]}未能读取（${typeof status === 'number' ? `HTTP ${status}` : status}）`);
  }
  const billingText = await page.locator('body').innerText().catch(() => '');
  return normalizePlan(session, observations, warnings, billingProTier(billingText));
}

module.exports = { fetchPlanDetails, normalizePlan, mergePlanSnapshot, isoDate, billingProTier };
