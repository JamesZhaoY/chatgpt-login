const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const AccountWindows = require('../src/account-window');

test('单账号窗口保留当前步骤，设备管理在同一个窗口打开，不同邮箱使用独立配置', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-window-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const contexts = [];
  const windows = new AccountWindows(dir, {
    async launchPersistentContext(profile) {
      let url = 'about:blank';
      const page = { url: () => url, goto: async next => { url = next; }, bringToFront: async () => {} };
      const context = new EventEmitter();
      Object.assign(context, { profile, pages: () => [page], close: async () => context.emit('close') });
      contexts.push(context);
      return context;
    },
  });
  const email = 'first@example.test';
  await Promise.all([windows.open(email, 'setup'), windows.open(email, 'setup')]);
  assert.equal(contexts.length, 1);
  const page = contexts[0].pages()[0];
  await page.goto('https://example.test/profile-in-progress');
  await windows.open(email, 'setup');
  assert.equal(page.url(), 'https://example.test/profile-in-progress');
  await windows.open(email, 'logout-devices');
  assert.equal(page.url(), 'https://chatgpt.com/settings/security');
  await windows.open('second@example.test', 'setup');
  assert.notEqual(contexts[0].profile, contexts[1].profile);
  await windows.close();
  assert.equal(windows.sessions.size, 0);
});
