#!/usr/bin/env node

/**
 * ChatGPT 批量登录服务
 *
 * 用法： node src/index.js 或 npm start
 *
 * 启动后：
 *   面板：       http://localhost:3210
 *   日志：       控制台，后台启动时可重定向到文件
 *   账号列表：   ./accounts.txt
 *   token 库：   ./info.json (自动重建)
 *   会话缓存：   ./profiles/*.json
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DIR = path.join(__dirname, '..');
const CONFIG_FILE = path.join(DIR, 'config.json');
const ACCOUNTS_FILE = path.join(DIR, 'accounts.txt');
const INFO_FILE = path.join(DIR, 'info.json');
const PROFILES_DIR = path.join(DIR, 'profiles');
const PUBLIC_DIR = path.join(DIR, 'public');

// 准备
if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true, mode: 0o700 });
if (!fs.existsSync(ACCOUNTS_FILE)) {
  fs.writeFileSync(ACCOUNTS_FILE, '# 每行：邮箱----取件URL\n# 例：alice@x.com----https://icloud.olo.lat/p/xxx\n', { mode: 0o600 });
}

// 读配置
const config = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
config.port = Number(process.env.PORT || config.port || 3210);
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT 必须是 1–65535 的整数');
config.mail = { url: '', pageLoadWaitMs: 2000, pollIntervalMs: 4000, maxWaitMs: 120000, ...config.mail };
config.batch = { headless: true, delayBetweenAccountsMs: 3000, perAccountTimeoutMs: 300000, openRetry: 3, openTimeoutMs: 45000, ...config.batch };
config.batch.threadPoolSize ??= 1;
if (!Number.isInteger(config.batch.threadPoolSize) || config.batch.threadPoolSize < 1 || config.batch.threadPoolSize > 10) throw new Error('线程池数量必须是 1–10 的整数');
if (process.env.HEADLESS_OVERRIDE === '0') config.batch.headless = false;
if (process.env.HEADLESS_OVERRIDE === '1') config.batch.headless = true;
for (const [group, names] of [[config.mail, ['pollIntervalMs', 'maxWaitMs']], [config.batch, ['perAccountTimeoutMs', 'openRetry', 'openTimeoutMs']]]) {
  for (const name of names) {
    if (!Number.isFinite(group[name]) || group[name] <= 0) throw new Error(`${name} 必须是正数`);
  }
}
for (const [group, name] of [[config.mail, 'pageLoadWaitMs'], [config.batch, 'delayBetweenAccountsMs']]) {
  if (!Number.isFinite(group[name]) || group[name] < 0) throw new Error(`${name} 必须是非负数`);
}

// 组装
const Store = require('./store');
const LoginWorker = require('./worker');
const { createServer } = require('./server');
const { closeBrowser } = require('./browser');

const store = new Store({
  dir: DIR,
  accountsFile: ACCOUNTS_FILE,
  infoFile: INFO_FILE,
  defaultMailUrl: config.mail?.url || '',
});
const worker = new LoginWorker({ store, config });
const server = createServer({ store, worker, config, publicDir: PUBLIC_DIR });

// 起服务
server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用，请关闭旧服务或设置 PORT` : e.message);
  process.exitCode = 1;
});
server.listen(config.port, '127.0.0.1', () => {
  const n = store.accounts.size;
  const accountsList = store.listAccounts();

  console.log('');
  console.log(`🟢 ChatGPT 批量登录服务`);
  console.log(`   面板：    http://localhost:${config.port}`);
  console.log(`   账号：    ${n} 个`);
  console.log(`   配置：    ${CONFIG_FILE}`);
  console.log(`   浏览器：  ${config.batch.headless ? '无头' : '有头'}`);
  console.log('');

  if (n > 0 && process.stdout.isTTY) {
    console.log('   账号预览:');
    accountsList.slice(0, 5).forEach(a => {
      console.log(`     ${a.email.slice(0, 30).padEnd(30)} → ${a.status}`);
    });
    if (n > 5) console.log(`     …还有 ${n - 5} 个`);
    console.log('');
  }

  // 自动开浏览器（macOS）
  if (process.platform === 'darwin' && !process.env.NO_AUTO_OPEN) {
    execFile('open', [`http://localhost:${config.port}`]);
  }
});

// 优雅退出
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n正在关闭…');
  server.closeEvents();
  const closed = new Promise(resolve => server.close(resolve));
  await worker.stop();
  await closeBrowser();
  server.closeAllConnections?.();
  await closed;
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
