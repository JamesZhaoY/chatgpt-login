const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchCode, mailReceivedAt, isMailForRequest } = require('../src/mailer');

const base = Math.floor(Date.now() / 1000) * 1000 - 60000;
const sentAt = base + 30000;
const opts = {
  url: 'https://mail.example.test/inbox', toEmail: 'alice+1@icloud.com',
  freshAfterMs: sentAt, seenIds: new Set(), snapshotBaseline: false,
  maxWaitMs: 30, pollIntervalMs: 1, pageLoadWaitMs: 0,
};
const message = (id, offset, code) => ({ id, time: new Date(base + offset).toISOString(), text: `收件人 alice@icloud.com 验证码 ${code}` });

function inbox(messages) {
  return { newPage: async () => ({
    goto: async () => {}, waitForSelector: async () => {}, close: async () => {}, isClosed: () => false,
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 1))),
    $$eval: async (selector, fn) => fn(messages.map(mail => ({
      getAttribute: () => mail.id,
      querySelector: selector => selector === 'time' ? { getAttribute: () => mail.time, textContent: mail.time } :
        { textContent: selector.includes('strong') ? 'Your temporary ChatGPT login code' : 'noreply@openai.com' },
    }))),
    locator: () => ({ nth: i => ({
      textContent: async () => messages[i].text,
      locator: () => ({ first: () => ({ count: async () => 0 }) }),
    }) }),
  }) };
}

test('邮件 UTC 与 +08:00 时间指向同一时刻，不猜测无时区的显示时间', () => {
  assert.equal(mailReceivedAt('2026-10-15T11:45:06.000Z'), mailReceivedAt('2026-10-15T19:45:06+08:00'));
  assert.ok(Number.isNaN(mailReceivedAt('2026-10-15 19:45:06')));
  assert.ok(Number.isNaN(mailReceivedAt('')));
});

test('按提交时间排除旧邮件、未知时间与未来时间，兼容邮件秒级精度', () => {
  assert.equal(isMailForRequest(message('old', 29000, '111111'), sentAt, base + 60000), false);
  assert.equal(isMailForRequest(message('same-second', 30000, '222222'), sentAt + 800, base + 60000), true);
  assert.equal(isMailForRequest(message('new', 31000, '333333'), sentAt, base + 60000), true);
  assert.equal(isMailForRequest(message('future', 70000, '444444'), sentAt, base + 60000), false);
  assert.equal(isMailForRequest({ time: '时间未知' }, sentAt, base + 60000), false);
});

test('+1 登录账号从基础邮箱取件，旧邮件即使有新 ID 也跳过，选择时间最新的新邮件', async () => {
  const mails = [
    message('late-old-id', 20000, '111111'),
    message('newer', 31000, '222222'),
    message('newest', 40000, '333333'),
    message('baseline-id', 45000, '444444'),
  ];
  const seenIds = new Set(['baseline-id']);
  assert.equal(await fetchCode(inbox(mails), { ...opts, seenIds }), '333333');
  assert.equal(opts.toEmail, 'alice+1@icloud.com');
});

test('重发后使用新的时间起点，不使用上一次发信产生的验证码', async () => {
  const mails = [message('previous-attempt', 40000, '111111'), message('resend', 51000, '222222')];
  assert.equal(await fetchCode(inbox(mails), { ...opts, freshAfterMs: base + 50000, seenIds: new Set() }), '222222');
});

test('只有过时邮件时继续等待，缺少本次请求时间时拒绝取码', async () => {
  await assert.rejects(fetchCode(inbox([message('old', 10000, '111111')]), opts), /超时/);
  await assert.rejects(fetchCode(inbox([]), { ...opts, freshAfterMs: undefined }), /本次提交或重发的时间/);
});
