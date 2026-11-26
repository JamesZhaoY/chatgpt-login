const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

const security = 'https://chatgpt.com/settings/security';

class AccountWindows {
  constructor(dir, browser = chromium) {
    this.dir = dir;
    this.browser = browser;
    this.sessions = new Map();
    this.navigation = new WeakMap();
  }

  async launch(email) {
    const id = createHash('sha256').update(email).digest('hex');
    const profile = path.join(this.dir, 'profiles', 'interactive', id);
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const context = await this.browser.launchPersistentContext(profile, { headless: false, viewport: null });
    context.once('close', () => this.sessions.delete(email));
    return context;
  }

  async open(email, action) {
    let session = this.sessions.get(email);
    if (!session) {
      session = this.launch(email).catch(error => { this.sessions.delete(email); throw error; });
      this.sessions.set(email, session);
    }
    const context = await session;
    const previous = this.navigation.get(context) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.show(context, action));
    this.navigation.set(context, next);
    await next;
  }

  async show(context, action) {
    const page = context.pages()[0] || await context.newPage();
    // 重开初始化入口时保留正在填写的官网页面。
    if (action === 'logout-devices' || page.url() === 'about:blank') {
      await page.goto(action === 'logout-devices' ? security : 'https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    }
    await page.bringToFront();
  }

  async close() {
    await Promise.allSettled([...this.sessions.values()].map(async session => (await session).close()));
  }
}

module.exports = AccountWindows;
