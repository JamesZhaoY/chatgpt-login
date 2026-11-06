/**
 * 浏览器与上下文管理
 *
 * - 单例 Chromium 进程（带 stealth 插件）
 * - 每次登录创建独立 BrowserContext（隔离 cookie / storage）
 * - newContext 始终带 en-US locale，让 ChatGPT 登录页文案稳定
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

let browserInstance = null;
let launchPromise = null;

async function getBrowser(config) {
  if (browserInstance && browserInstance.isConnected()) return browserInstance;
  if (launchPromise) return launchPromise;
  launchPromise = chromium.launch({
    headless: config.batch.headless,
    chromiumSandbox: false,
    args: ['--disable-blink-features=AutomationControlled'],
  }).then(browser => { browserInstance = browser; return browser; });
  try { return await launchPromise; }
  finally { launchPromise = null; }
}

async function newContext(browser, extra = {}) {
  return browser.newContext({
    viewport: { width: 1280, height: 860 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    ...extra,
  });
}

async function closeBrowser() {
  if (launchPromise) await launchPromise.catch(() => {});
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}

module.exports = { getBrowser, newContext, closeBrowser };
