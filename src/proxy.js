const { isIP } = require('node:net');

const DEFAULT_PROXY = { enabled: false, server: '', username: '', password: '' };

function normalizeProxy(input, previous = DEFAULT_PROXY) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean') throw new Error('请提供有效的代理配置和启用状态');
  for (const key of ['server', 'username', 'password']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 2048 || /[\x00-\x1f\x7f]/.test(input[key]))) throw new Error('代理地址、账号和密码必须是有效的单行文本');
  }
  if (input.clearPassword !== undefined && typeof input.clearPassword !== 'boolean') throw new Error('清除代理密码选项不正确');
  let server = (input.server || '').trim();
  let username = input.username || '';
  let password = input.password || '';
  if (server) {
    let url;
    try { url = new URL(server.includes('://') ? server : `http://${server}`); }
    catch { throw new Error('代理地址格式不正确，请填写 IP 或域名与端口'); }
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname || /[\s\\]/.test(server) || !['', '/'].includes(url.pathname) || url.search || url.hash) throw new Error('代理地址只支持 HTTP、HTTPS 或 SOCKS5，不应包含路径或查询参数');
    let inlineUser, inlinePassword;
    try { inlineUser = decodeURIComponent(url.username); inlinePassword = decodeURIComponent(url.password); }
    catch { throw new Error('代理地址中的账号密码编码不正确'); }
    if (inlineUser && username && inlineUser !== username || inlinePassword && password && inlinePassword !== password) throw new Error('地址中的认证信息与单独填写的账号密码不一致');
    username ||= inlineUser;
    password ||= inlinePassword;
    if (/[\x00-\x1f\x7f]/.test(username + password)) throw new Error('代理账号密码不能包含换行或控制字符');
    const port = url.port || ({ 'http:': '80', 'https:': '443' })[url.protocol];
    if (!port || Number(port) < 1) throw new Error('请填写有效的代理端口');
    server = `${url.protocol}//${url.hostname}:${port}`;
  }
  if (input.enabled && !server) throw new Error('启用代理前请填写代理地址');
  if (input.clearPassword && password) throw new Error('清除密码时请留空密码输入框');
  // 只保留同一代理及同一账号的密码，切换地址时不能把旧凭据发给新代理。
  if (!password && !input.clearPassword && server && server === previous.server && username === previous.username) password = previous.password || '';
  if (input.clearPassword) password = '';
  if (password && !username) throw new Error('填写代理密码时也需要填写认证账号');
  if (server.startsWith('socks5:') && (username || password)) throw new Error('SOCKS5 仅支持无认证代理；需要账号密码时请使用 HTTP 或 HTTPS 代理');
  return { enabled: input.enabled, server, username, password };
}

function proxySummary(proxy = DEFAULT_PROXY) {
  return { enabled: proxy.enabled, server: proxy.server, username: proxy.username, hasPassword: Boolean(proxy.password) };
}

function proxyOptions(proxy = DEFAULT_PROXY) {
  if (!proxy.enabled) return undefined;
  return { server: proxy.server, ...(proxy.username ? { username: proxy.username, password: proxy.password || '' } : {}) };
}

async function testProxy(proxy) {
  if (!proxy.enabled) throw new Error('请先勾选启用代理，再检测出口 IP');
  const started = Date.now();
  let context;
  try {
    // 独立网络上下文，不读取账号的 Cookie 或 Session；不改变已保存配置。
    context = await require('playwright').request.newContext({ proxy: proxyOptions(proxy), timeout: 8000 });
    const response = await context.get('https://api64.ipify.org?format=json', { maxRedirects: 0 });
    if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
    const { ip } = await response.json();
    if (typeof ip !== 'string' || !isIP(ip)) throw new Error('INVALID_IP');
    return { ip, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
  } catch (error) {
    // 驱动错误可能含认证信息，向界面返回固定文案。
    const message = String(error.message || error);
    if (/407|authentication|credentials/i.test(message)) throw new Error('代理认证失败，请检查账号和密码');
    if (/timeout|timed out/i.test(message)) throw new Error('代理检测超时，请检查代理地址和网络');
    if (message === 'INVALID_IP') throw new Error('出口检测未返回有效 IP，请稍后重试');
    throw new Error('无法通过此代理检测出口 IP，请检查地址、端口及代理是否可用');
  } finally { await context?.dispose().catch(() => {}); }
}

module.exports = { DEFAULT_PROXY, normalizeProxy, proxySummary, proxyOptions, testProxy };
