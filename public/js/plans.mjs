import { app } from './state.mjs';
import { esc, dateText } from './ui.mjs';

const planDate = value => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '暂未返回';
const duration = seconds => !seconds ? '周期未知' : seconds % 86400 === 0 ? `${seconds / 86400} 天`
  : seconds % 3600 === 0 ? `${seconds / 3600} 小时` : `${Math.round(seconds / 60)} 分钟`;
const used = window => Number.isFinite(window.usedPercent) ? `已用 ${window.usedPercent}%` : '使用量未知';
const windows = usage => [['主要窗口', usage?.primary], ['每周窗口', usage?.secondary], ['代码审查', usage?.codeReview]].filter(([, window]) => window);

export function membershipName(plan) {
  if (!plan?.fetchedAt) return '待查询';
  return [100, 200, 500].includes(plan.proTier) ? `Pro ${plan.proTier}` : plan.planName || '类别未确认';
}

export function expirySummary(plan, compact = false) {
  if (!plan?.fetchedAt) return '到期待查询';
  if (plan.status === 'free' || plan.planType === 'free') return compact ? '免费账号' : '免费账号 · 无订阅到期时间';
  const valid = value => value && Number.isFinite(Date.parse(value)) ? value : null;
  const expiry = valid(plan.entitlementExpiresAt);
  const periodEnd = valid(plan.periodEndsAt);
  const date = expiry || periodEnd || valid(plan.expiresAt);
  if (!date) return '到期时间暂未返回';
  const cached = plan.error || (!expiry && plan.cachedSections?.some(item => item.section === 'billing'));
  return `${expiry || !periodEnd ? '到期' : '本期结束'} ${compact ? dateText(date, true) : planDate(date)}${cached ? '（上次记录）' : ''}`;
}

export function quotaSummary(plan) {
  const quotas = windows(plan?.usage);
  if (!quotas.length) return plan?.fetchedAt ? '窗口额度暂未返回' : '登录后自动查询额度';
  const cached = plan.cachedSections?.some(item => item.section === 'usage');
  return `${cached ? '上次记录 · ' : ''}${quotas.map(([label, window]) => `${label === '代码审查' ? `${label} ` : ''}${duration(window.windowSeconds)} ${used(window)}`).join(' · ')}`;
}

export function planHTML(account, expanded = app.openPlans.has(account.email)) {
  const plan = account.plan || {};
  const hasData = Boolean(plan.fetchedAt);
  const cachedUsage = plan.cachedSections?.find(item => item.section === 'usage');
  const missingUsage = plan.missingSections?.some(item => item.section === 'usage');
  const quotas = windows(plan.usage);
  const quota = ([label, window]) => `<div class="plan-quota"><div><span>${esc(label)} · ${esc(duration(window.windowSeconds))}</span><strong>${esc(used(window))}</strong></div>
    ${Number.isFinite(window.usedPercent) ? `<meter min="0" max="100" value="${Math.min(100, Math.max(0, window.usedPercent))}" aria-label="${esc(label)}已用百分比">${esc(window.usedPercent)}%</meter>` : ''}
    <span class="plan-muted">重置于 ${esc(planDate(window.resetsAt))}</span></div>`;
  return `<section class="plan-panel" aria-label="${esc(account.email)} 的会员与窗口额度">
    <div class="plan-overview"><div class="plan-identity"><span class="plan-label">会员类别</span><strong>${esc(membershipName(plan))}</strong></div>
      <p class="plan-expiry">${esc(expirySummary(plan))}</p></div>
    ${plan.error ? `<p class="plan-error">会员信息更新失败：${esc(plan.error)}${hasData ? '（保留上次记录）' : ''}${plan.attemptedAt ? ` · 尝试于 ${esc(planDate(plan.attemptedAt))}` : ''}</p>` : ''}
    ${!plan.error && missingUsage ? `<p class="plan-partial">会员类别已更新；窗口额度${cachedUsage ? `沿用 ${esc(planDate(cachedUsage.fetchedAt))} 的记录` : '暂未返回'}。</p>` : ''}
    <div class="plan-details" id="plan-${encodeURIComponent(account.email)}" ${expanded ? '' : 'hidden'}>
      <h3>窗口额度${cachedUsage ? '（上次记录）' : ''}</h3>
      ${quotas.length ? `<div class="plan-quotas">${quotas.map(quota).join('')}</div>` : `<p class="plan-muted">${hasData ? '官网暂未返回窗口额度，可稍后刷新此账号。' : '登录成功后自动查询会员类别、到期时间和窗口额度。'}</p>`}
      ${hasData ? `<p class="plan-footnote">更新于 ${esc(planDate(plan.fetchedAt))} · Codex 窗口额度 · 时间按本机时区显示</p>` : ''}
    </div>
  </section>`;
}
