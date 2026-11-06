const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Store = require('../src/store');
const { matchesRecipient } = require('../src/mailer');

test('多种换行均独立读取邮箱与对应取件地址', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-addresses-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store({ dir, accountsFile: path.join(dir, 'accounts.txt'), infoFile: path.join(dir, 'info.json') });
  const expected = [
    { email: 'alice+1@icloud.com', mailUrl: 'https://mail.example.test/inbox/alice' },
    { email: 'bob+1@icloud.com', mailUrl: 'https://mail.example.test/inbox/bob' },
  ];
  const lines = expected.map(a => `${a.email}----${a.mailUrl}`);
  for (const newline of ['\n', '\r\n', '\r', '\\n', '\\r\\n', '\\r', '\u0085', '\u2028', '\u2029']) {
    assert.deepEqual(store.parseAccounts(lines.join(newline)), expected, JSON.stringify(newline));
    assert.equal(store.writeAccountsFile(lines.join(newline)), 2);
    assert.equal(fs.readFileSync(store.accountsFile, 'utf8'), lines.join('\n'));
    assert.deepEqual(store.parseAccountsFile(), expected);
  }
  assert.throws(() => store.parseAccounts('alice@icloud.com----https://mail.example.test/one bob@icloud.com----https://mail.example.test/two'));
});

test('识别 iCloud 别名收件地址，保留账号标识并拒绝其他邮箱或其他标签', () => {
  assert.equal(matchesRecipient('diktat_pox_3u@icloud.com', 'diktat_pox_3u+1@icloud.com'), true);
  assert.equal(matchesRecipient('ALICE+1@icloud.com', 'alice+1@icloud.com'), true);
  assert.equal(matchesRecipient('alice+2@icloud.com', 'alice+1@icloud.com'), false);
  assert.equal(matchesRecipient('someone@icloud.com', 'alice+1@icloud.com'), false);
  assert.equal(matchesRecipient('alice@example.test', 'alice+1@example.test'), false);
  assert.equal(matchesRecipient('alice+1@icloud.com', 'alice@icloud.com'), false);
});
