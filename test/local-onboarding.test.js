const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, scryptSync } = require('node:crypto');
const { chromium } = require('playwright');
const { generateTotp } = require('../src/totp');
const { startFixture } = require('./helpers/local-onboarding');

test('本地注册、填资料、设置密码及启用 TOTP 使用同一标签页与服务端会话', async t => {
  const fixture = await startFixture();
  t.after(fixture.close);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const external = [];
  await context.route('**/*', route => {
    const origin = new URL(route.request().url()).origin;
    if (origin === fixture.origin) return route.continue();
    external.push(origin);
    return route.abort();
  });
  let pagesOpened = 0;
  context.on('page', () => pagesOpened++);
  const page = await context.newPage();
  const goto = step => fixture.origin + '/' + step;
  async function submit(label, value, next) {
    await page.getByLabel(label, { exact: true }).fill(value);
    await Promise.all([page.waitForURL(goto(next)), page.getByRole('button', { name: 'Continue' }).click()]);
  }
  await page.goto(goto('register'));
  const password = randomUUID();
  await submit('Email', 'single-session@example.test', 'profile');
  await submit('Display name', 'Local Tester', 'password');
  await submit('Password', password, 'authenticator');

  const [session] = fixture.sessions.values();
  // Reaching the form is insufficient: prove a wrong code cannot activate it.
  const rejected = await context.request.post(goto('authenticator'), {
    headers: { Origin: fixture.origin }, form: { code: '000000' },
  });
  assert.equal(rejected.status(), 422);
  assert.equal(session.mfa, false);
  const code = generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', { now: 59000 }).code;
  await submit('Authenticator code', code, 'done');
  assert.equal(await page.getByRole('heading').innerText(), 'Setup complete');
  assert.deepEqual(fixture.events.map(event => event.step), ['register', 'profile', 'password', 'authenticator']);
  assert.equal(fixture.sessions.size, 1);
  assert.ok(fixture.events.every(event => event.id === session.id));
  assert.equal(session.displayName, 'Local Tester');
  assert.deepEqual(session.hash, scryptSync(password, session.id, 32));
  assert.equal(session.mfa, true);
  assert.equal(pagesOpened, 1);
  assert.equal(browser.contexts().length, 1);
  assert.deepEqual(external, []);
});
