const { test } = require('node:test');
const assert = require('node:assert/strict');
const { snapshotMailIds, fetchCode } = require('../src/mailer');
const { evaluateArticles } = require('./helpers/mailbox-dom');

const email = 'alice+1@icloud.com';
const url = 'https://api.wdmail.top/m?f=html&e=alice@icloud.com:fixture-only';
const base = Math.floor(Date.now() / 1000) * 1000 - 60000;
const opts = { url, toEmail: email, freshAfterMs: base + 30000, pageLoadWaitMs: 0, pollIntervalMs: 1, maxWaitMs: 150, snapshotBaseline: false };
const node = (tag, attrs = {}, children = []) => ({ tag, attrs, children });
const protectedEmail = (email, key = 42) => node('a', { class: '__cf_email__', 'data-cfemail': Buffer.from([key, ...Buffer.from(email).map(byte => byte ^ key)]).toString('hex') }, ['[email protected]']);
const localTime = ms => new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
const emptyMailbox = () => ({ articles: [node('article', {}, [node('p', {}, ['最近 24 小时没有邮件'])])], frames: {} });
function fixture(messages, key = 42) {
  const frames = {};
  const articles = messages.map((mail, index) => {
    const srcdoc = `fixture-${index}-${mail.code}`;
    const meta = node('div', { class: 'meta' }, [
      '发件人：ChatGPT <', protectedEmail('noreply@tm.openai.com', key), '>', node('br'),
      '邮箱：', protectedEmail(mail.to || 'alice@icloud.com', key), node('br'),
      '时间：', mail.time ?? localTime(base + mail.offset),
    ]);
    frames[srcdoc] = node('', {}, [node('head', {}, [node('style', {}, ['color: #123456; width:654321px;']), node('title', {}, ['Your temporary ChatGPT verification code'])]),
      node('body', {}, [node('script', {}, ['666666']), node('p', {}, ['Enter this temporary verification code to continue:']), node('div', {}, [mail.code]),
        node('p', {}, ['Please ignore this email if this wasn’t you trying to create a ChatGPT account.'])])]);
    return node('article', {}, [node('h2', {}, [mail.subject || 'Your temporary ChatGPT verification code']), meta,
      node('pre', {}, [mail.plain ? `Your code: ${mail.code}` : 'Your temporary ChatGPT verification code @font-face { ... #123456 ...']),
      ...mail.plain ? [] : [node('iframe', { sandbox: '', referrerpolicy: 'no-referrer', srcdoc })]]);
  });
  return { articles, frames };
}
function inbox(rounds) {
  let round = -1;
  let closed = 0;
  let observed = [];
  return {
    closed: () => closed, observed: () => observed,
    context: { newPage: async () => ({
      goto: async target => { assert.equal(target, url); round++; return { ok: () => true }; },
      waitForSelector: async selector => { assert.equal(selector, 'header, article'); },
      waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 1))),
      close: async () => { closed++; }, isClosed: () => false,
      $$eval: async (selector, fn) => {
        assert.equal(selector, 'article');
        observed = evaluateArticles(fn, rounds[Math.min(round, rounds.length - 1)]);
        return observed;
      },
      locator: () => { throw new Error('wdmail 不应使用旧站点的折叠邮件选择器'); },
    }) },
  };
}

test('wdmail 实际结构：解码隐藏的收件人、读取内嵌完整正文，排除 CSS / 脚本中的六位数字', async () => {
  const box = inbox([fixture([{ offset: 31000, code: '062198' }])]);
  const logs = [];
  assert.equal(await fetchCode(box.context, { ...opts, seenIds: new Set(), log: value => logs.push(value) }), '062198');
  assert.equal(box.observed()[0].recipient, 'alice@icloud.com');
  assert.equal(box.observed()[0].sender, 'ChatGPT <noreply@tm.openai.com>');
  assert.ok(!box.observed()[0].text.includes('123456'));
  assert.ok(!box.observed()[0].text.includes('666666'));
  assert.ok(!logs.join('\n').includes('062198'));
  assert.equal(box.closed(), 1);
});

test('wdmail 空邮箱提示也使用 article：基线为零，继续等待并读取后来送达的邮件', async () => {
  const baseline = inbox([emptyMailbox()]);
  const seenIds = await snapshotMailIds(baseline.context, opts);
  assert.equal(seenIds.size, 0);
  assert.equal(baseline.closed(), 1);
  const pending = inbox([emptyMailbox(), fixture([{ offset: 31000, code: '062198' }])]);
  assert.equal(await fetchCode(pending.context, { ...opts, seenIds }), '062198');
  assert.equal(seenIds.size, 1);
  assert.equal(pending.closed(), 1);
});

test('只跳过明确的空邮箱占位，真实邮件缺少时间或取件错误页面仍报错', async () => {
  const mixed = fixture([{ offset: 31000, code: '062198' }]);
  mixed.articles.unshift(...emptyMailbox().articles);
  assert.equal((await snapshotMailIds(inbox([mixed]).context, opts)).size, 1);
  assert.equal(await fetchCode(inbox([mixed]).context, { ...opts, seenIds: new Set() }), '062198');
  for (const content of [
    { articles: [node('article', {}, [node('p', {}, ['取件失败，请检查邮箱凭据'])])], frames: {} },
    fixture([{ time: '', code: '062198' }]),
    { articles: [node('article', {}, [node('h2', {}, ['Your temporary ChatGPT verification code']), node('p', {}, ['最近 24 小时没有邮件'])])], frames: {} },
  ]) await assert.rejects(snapshotMailIds(inbox([content]).context, opts), /有效时间/);
});

test('wdmail 北京时间按真实时刻过滤，+1 兼容基础邮箱；跳过旧邮件、未来邮件、其他标签和其他收件人', async () => {
  const box = inbox([fixture([
    { offset: 29000, code: '111111' }, { offset: 90000, code: '999999' }, { offset: 40000, code: '444444', to: 'alice+2@icloud.com' },
    { offset: 42000, code: '555555', to: 'other@icloud.com' }, { offset: 31000, code: '222222' }, { offset: 35000, code: '333333' },
  ])]);
  assert.equal(await fetchCode(box.context, { ...opts, seenIds: new Set() }), '333333');
  assert.equal(opts.toEmail, email);
});

test('wdmail 邮件基线不受索引、Cloudflare 混淆密钥或正文换行改变，重发时间排除前一次验证码', async () => {
  const baseline = inbox([fixture([{ offset: 31000, code: '111111' }])]);
  const seenIds = await snapshotMailIds(baseline.context, opts);
  assert.equal(seenIds.size, 1);
  const delivered = inbox([fixture([{ offset: 32000, code: '222222' }, { offset: 31000, code: '111111' }], 77)]);
  assert.equal(await fetchCode(delivered.context, { ...opts, seenIds }), '222222');
  assert.equal(seenIds.size, 2);
  const again = await snapshotMailIds(inbox([fixture([{ offset: 31000, code: ' 111111\n' }], 90)]).context, opts);
  assert.ok(seenIds.has([...again][0]));
  const resend = inbox([fixture([{ offset: 32000, code: '222222' }, { offset: 50000, code: '333333' }])]);
  assert.equal(await fetchCode(resend.context, { ...opts, freshAfterMs: base + 45000, seenIds }), '333333');
});

test('wdmail 同一秒的不同邮件使用不同 ID；纯文本正文可读，未知时间不当作新邮件', async () => {
  const box = inbox([fixture([{ offset: 31000, code: '111111' }, { offset: 31000, code: '222222' }])]);
  assert.equal((await snapshotMailIds(box.context, opts)).size, 2);
  const plain = inbox([fixture([{ offset: 31000, code: '062198', plain: true }])]);
  assert.equal(await fetchCode(plain.context, { ...opts, seenIds: new Set() }), '062198');
  await assert.rejects(snapshotMailIds(inbox([fixture([{ time: '时间未知', code: '062198' }])]).context, opts), /有效时间/);
  assert.equal((await snapshotMailIds(inbox([fixture([])]).context, opts)).size, 0);
  await assert.rejects(fetchCode(inbox([fixture([{ offset: 10000, code: '111111' }])]).context, { ...opts, seenIds: new Set(), maxWaitMs: 15 }), /超时/);
});
