export const app = {
  accounts: [], worker: { queue: [], inFlight: [], running: false }, filter: 'all',
  loaded: false, connected: false, source: null, updated: null, view: 'accounts',
  selected: new Set(), openLogs: new Set(), openPlans: new Set(), busy: new Set(), openAccountMenu: null,
  editorRows: [], editorDirty: false, editorLoaded: false, removedEditorRow: null,
  editorBaseline: new Map(), editorExpectedContent: null, editorPage: 1, editorSearch: '', editorFilter: 'all',
  proxyConfig: null, proxyDirty: false, page: 1, pageSize: 12, openTasks: new Set(),
  detailsEmail: null, detailsTab: 'plan',
};
let renderer = () => {};
let renderFrame = null;
export function setRenderer(callback) { renderer = callback; }
export function scheduleRender() {
  if (renderFrame !== null) return;
  renderFrame = requestAnimationFrame(() => { renderFrame = null; renderer(); });
}
export const STATUS_TEXT = { idle: '待登录', pending: '等待中', running: '登录中', ok: '会话可用', fail: '登录失败', expired: '已过期', disabled: '不可用' };
export const STATUS_ORDER = { running: 0, pending: 1, fail: 2, expired: 3, idle: 4, ok: 5, disabled: 6 };
export const LOGIN_METHODS = { password: '密码登录', 'password-totp': '密码 + 2FA', email: '邮箱验证码登录', 'email-totp': '邮箱验证码 + 2FA', session: '复用已有会话', missing: '待补充密码或取件地址' };
export const active = account => account.status === 'running' || account.status === 'pending';
export const usable = account => {
  const expires = account.tokenExpires || account.info?.expires;
  return Boolean(!account.unavailable && account.info?.accessToken && (!expires || Date.parse(expires) > Date.now()));
};
export const status = account => account.unavailable ? 'disabled' : account.status === 'ok' && !usable(account) ? 'expired' : (STATUS_TEXT[account.status] ? account.status : 'idle');
export const attention = account => !account.unavailable && !active(account) && (!usable(account) || account.status === 'fail' || account.password?.error || account.password?.uncertain || account.twofa?.error || account.twofa?.pending || account.plan?.error);
export const actionable = account => !account.unavailable && !active(account);
export const setupComplete = (account, mode = 'all') => {
  const password = account.password || {};
  const twofa = account.twofa || {};
  const passwordReady = password.saved && password.verifiedAt && !password.uncertain && !password.error;
  const twofaReady = twofa.hasSecret && twofa.enabled && twofa.verifiedAt && !twofa.pending && !twofa.error;
  return Boolean(mode === 'password' ? passwordReady : mode === 'twofa' ? twofaReady : passwordReady && twofaReady);
};

