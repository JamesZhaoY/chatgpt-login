const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { frontend } = require('./helpers/frontend');
const Store = require('../src/store');
const { createServer } = require('../src/server');

const email = 'alice+1@example.test';
const secret = 'BH4OWU3OMXPJ7P63';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-editor-test-'));
  const options = { dir, accountsFile: path.join(dir, 'accounts.txt'), infoFile: path.join(dir, 'info.json') };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(options);
  store.writeAccountsFile(`${email}----https://mail.example.test/a----${secret}`);
  return { store, options };
}

test('表单保存逐字段校验，拒绝换行、分隔符、重复邮箱，保留原记录', t => {
  const { store } = fixture(t);
  const before = fs.readFileSync(store.accountsFile, 'utf8');
  const row = { email, mailUrl: 'https://mail.example.test/new', totpSecret: secret };
  for (const rows of [null, [null], [{ ...row, email: '' }], [row, { ...row, email: email.toUpperCase() }], [{ ...row, mailUrl: 'https://mail.example.test/a\nbob@example.test' }], [{ ...row, totpSecret: secret + '----extra' }], [{ ...row, mailUrl: 'https://mail.example.test/a\\nbob@example.test' }], [{ ...row, email: 12 }]]) {
    assert.throws(() => store.serializeAccounts(rows));
  }
  assert.equal(fs.readFileSync(store.accountsFile, 'utf8'), before);
  store.writeAccountsFile(store.serializeAccounts([row]));
  assert.deepEqual(store.parseAccountsFile(), [row]);
  assert.equal(fs.statSync(store.accountsFile).mode & 0o777, 0o600);
});

test('表单移除仅更新账号列表，已有会话及 2FA 继续保存在本机', t => {
  const { store, options } = fixture(t);
  store.saveInfo(email, { accessToken: 'fixture' });
  store.recordTwofa(email, { secret, verifiedAt: '2026-10-15T00:00:00Z' });
  store.writeAccountsFile(store.serializeAccounts([]));
  assert.equal(store.accounts.size, 0);
  assert.equal(store.getTwofaSecret(email), secret);
  store.writeAccountsFile(store.serializeAccounts([{ email, mailUrl: '', totpSecret: '' }]));
  const restored = new Store(options);
  assert.equal(restored.getAccount(email).info.accessToken, 'fixture');
  assert.equal(restored.getTwofaSecret(email), secret);
});

test('导入预览不落盘，结构化保存、读取、错误和忙碌状态贯通', async t => {
  const { store } = fixture(t);
  const worker = { running: false, queue: [], inFlight: new Set(), getState: () => ({ running: false, queue: [], inFlight: [] }) };
  const server = createServer({ store, worker, config: { batch: { headless: true } }, publicDir: path.join(__dirname, '../public') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, data, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  const before = fs.readFileSync(store.accountsFile, 'utf8');
  const preview = await post('/api/accounts/parse', { content: `bob@example.test----https://mail.example.test/b\r\nALICE+1@example.test----https://mail.example.test/new----${secret}` });
  assert.equal(preview.status, 200);
  const rows = (await preview.json()).accounts;
  assert.equal(rows.length, 2);
  assert.equal(rows[1].email, email);
  assert.equal(rows[1].totpSecret, secret);
  assert.equal(fs.readFileSync(store.accountsFile, 'utf8'), before);
  assert.equal((await post('/api/accounts/parse', { content: 'invalid' })).status, 400);
  assert.equal((await post('/api/accounts/parse', { content: before }, { Origin: 'https://other.example.test' })).status, 403);
  assert.equal((await post('/api/accounts-file', { accounts: rows })).status, 200);
  assert.deepEqual((await (await fetch(base + '/api/accounts-file')).json()).accounts, rows.map(({ email, mailUrl }) => ({ email, mailUrl })));
  assert.equal(store.getTwofaSecret(email), secret);
  const saved = fs.readFileSync(store.accountsFile, 'utf8');
  assert.equal((await post('/api/accounts-file', { accounts: [], expectedContent: before })).status, 409);
  assert.equal(fs.readFileSync(store.accountsFile, 'utf8'), saved);
  assert.equal((await post('/api/accounts-file', { accounts: rows, expectedContent: saved })).status, 200);
  assert.equal((await post('/api/accounts-file', { accounts: rows, expectedContent: false })).status, 400);
  assert.equal((await post('/api/accounts-file', { accounts: [{ email, mailUrl: 'javascript:alert(1)' }] })).status, 400);
  assert.equal((await post('/api/accounts-file', { accounts: rows, content: '' })).status, 400);
  worker.running = true;
  assert.equal((await post('/api/accounts-file', { accounts: [] })).status, 409);
  assert.equal(fs.readFileSync(store.accountsFile, 'utf8'), saved);
});

test('导入与表单合并保留其他账号、已有密钥及未保存编辑，合并结果不改原草稿', async () => {
  const { context } = await frontend();
  const current = [{ email, mailUrl: 'https://mail.example.test/a', totpSecret: secret }, { email: 'other@example.test', mailUrl: 'https://mail.example.test/edited', totpSecret: '' }, { email: '', mailUrl: '', totpSecret: '' }];
  const result = context.mergeEditorRows(current, [{ email, mailUrl: 'https://mail.example.test/updated' }, { email: 'new@example.test', mailUrl: '', totpSecret: secret }]);
  assert.equal(result.length, 3);
  assert.equal(result[0].totpSecret, secret);
  assert.equal(result[0].mailUrl, 'https://mail.example.test/updated');
  assert.equal(result[1].mailUrl, 'https://mail.example.test/edited');
  assert.equal(current[0].mailUrl, 'https://mail.example.test/a');
});

test('管理列表只显示配置状态，菜单保留官网修改及中断恢复，秘密字段不渲染到列表', async () => {
  const { context, elements } = await frontend();
  context.fixtureAccount = { email, mailUrl: '', status: 'idle', loginMethod: 'password-totp', password: { saved: true }, twofa: { hasSecret: true } };
  Object.assign(context.app, { accounts: [context.fixtureAccount], connected: true, editorRows: [{email: context.fixtureAccount.email, mailUrl: '', password: '', totpSecret: ''}] });
  context.renderEditor();
  const markup = elements.get('#accountEditorRows').innerHTML;
  assert.doesNotMatch(markup, /<input|account-editor-row/);
  assert.deepEqual(context.editorCredentialPresence(context.app.editorRows[0]), { mailUrl: false, password: true, totpSecret: true });
  assert.match(markup, /data-presence="password" class="presence-status present">有/);
  assert.match(markup, /data-presence="mailUrl" class="presence-status missing">无/);
  assert.equal(context.editorLoginMethod({ email: 'new@example.test', mailUrl: '', password: 'Fixture12!xx', totpSecret: '' }), '密码登录');
  assert.equal(context.editorLoginMethod({ email: 'new@example.test', mailUrl: 'https://mail.example.test/', password: '', totpSecret: secret }), '邮箱验证码 + 2FA');
  assert.equal(context.editorLoginMethod({ email: 'new@example.test', mailUrl: '', password: '', totpSecret: secret }), '待补充密码或取件地址');
  let html = context.accountHTML(context.fixtureAccount);
  assert.match(html, />修改密码<\/button>/);
  assert.match(html, />修改 2FA<\/button>/);
  context.fixtureAccount.twofa = { hasSecret: true, rotating: true, hasPendingSecret: true, pending: true, verifiedAt: 'old-verification' };
  html = context.accountHTML(context.fixtureAccount);
  assert.match(html, /继续修改 2FA/);
  assert.match(html, /复制待确认 2FA 密钥/);
  assert.match(html, /2FA 更换待完成/);
  assert.doesNotMatch(html, /2FA 已验证/);
  const merged = context.mergeEditorRows([{ email, mailUrl: '', password: 'Fixture12!xx', totpSecret: '' }], [{ email, mailUrl: 'https://mail.example.test/' }]);
  assert.equal(merged[0].password, 'Fixture12!xx');
});
