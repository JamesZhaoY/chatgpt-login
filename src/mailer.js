/* 用本次发信时间 + 提交前的邮件 ID 基线筛选验证码，保留登录邮箱的 +标签。 */
const { createHash } = require('node:crypto');
const CODE_SUBJECT = 'Your temporary ChatGPT login code';

function matchesRecipient(actual, expected) {
  actual = actual.trim().toLowerCase();
  expected = expected.trim().toLowerCase();
  if (actual === expected) return true;
  // 此取件服务把 iCloud +标签邮件的收件人显示为基础邮箱。
  // 仅允许「目标别名 → 对应基础邮箱」，不把 +1 与 +2 当成同一个收件人。
  const alias = expected.match(/^([^+@]+)\+[^@]+@(icloud\.com|me\.com|mac\.com)$/);
  return Boolean(alias && actual === `${alias[1]}@${alias[2]}`);
}

function mailReceivedAt(time) {
  // 读取 <time datetime> 的带时区时间，不能把网页显示的北京时间当成 UTC。
  if (typeof time !== 'string' || !/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(time)) return NaN;
  return Date.parse(time);
}

function isMailForRequest(mail, freshAfterMs, now = Date.now()) {
  const receivedAt = mailReceivedAt(mail.time);
  // 取件服务的时间精度为秒；同一秒的边界由提交前的 ID 基线补充判断。
  return Number.isFinite(receivedAt) && receivedAt >= Math.floor(freshAfterMs / 1000) * 1000 && receivedAt <= now;
}

function wdmailArticles(articles) {
  // 读取静态 HTML 的正文，不把邮件中的脚本、样式或外部资源载入页面。
  const textOf = node => {
    if (!node) return '';
    const copy = node.cloneNode(true);
    copy.querySelectorAll('script, style, head').forEach(element => element.remove());
    copy.querySelectorAll('[data-cfemail]').forEach(element => {
      const hex = element.getAttribute('data-cfemail') || '';
      if (!/^(?:[\da-f]{2}){2,}$/i.test(hex)) return;
      const key = parseInt(hex.slice(0, 2), 16);
      element.textContent = hex.slice(2).match(/../g).map(byte => String.fromCharCode(parseInt(byte, 16) ^ key)).join('');
    });
    copy.querySelectorAll('br').forEach(element => element.replaceWith('\n'));
    copy.querySelectorAll('p, div, td, th, tr, li, section, h1, h2, h3').forEach(element => element.append('\n'));
    return copy.textContent?.trim() || '';
  };
  return articles.map((article, idx) => {
    // 空邮箱也返回 <article><p>最近 24 小时没有邮件</p></article>。
    // 只跳过明确的空态提示，取件失败页面或字段损坏的真实邮件仍保留校验。
    if (!article.querySelector('h2, .meta, pre, iframe') &&
      /^最近\s*24\s*小时没有邮件[。.]?$/.test(textOf(article))) return null;
    const meta = textOf(article.querySelector('.meta'));
    const field = name => meta.match(new RegExp(`(?:^|\\n)\\s*(?:${name})\\s*[:：]\\s*([^\\n]*)`, 'i'))?.[1]?.trim() || '';
    const srcdoc = article.querySelector('iframe[srcdoc]')?.getAttribute('srcdoc');
    const template = document.createElement('template');
    if (srcdoc) template.innerHTML = srcdoc;
    return {
      idx, subject: textOf(article.querySelector('h2')),
      sender: field('发件人|From'), recipient: field('邮箱|收件人|To'), time: field('时间|Date'),
      text: srcdoc ? textOf(template.content) : textOf(article.querySelector('pre')),
    };
  }).filter(Boolean);
}

function normalizeWdmailMessage(mail) {
  // wdmail 的「时间」使用北京时间，且未写时区。只对该服务补 +08:00。
  const time = mail.time.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/, '$1T$2+08:00');
  const text = mail.text.replace(/\s+/g, ' ').trim();
  const id = `wdmail:${createHash('sha256').update(JSON.stringify([mail.sender, mail.recipient, mail.subject, time, text])).digest('hex')}`;
  return { ...mail, text, time, id };
}

async function scrapeMessages(page, wdmail = false) {
  if (wdmail) {
    const mails = await page.$$eval('article', wdmailArticles);
    if (mails.some(mail => !mail.subject || !mail.sender || !mail.recipient || !Number.isFinite(mailReceivedAt(normalizeWdmailMessage(mail).time)))) {
      throw new Error('取件箱邮件缺少标题、收件人或有效时间，无法识别本次验证码');
    }
    return mails.filter(mail => /ChatGPT/i.test(mail.subject) && /openai|(?:login|verification) code/i.test(`${mail.sender} ${mail.subject}`)).map(normalizeWdmailMessage);
  }
  return page.$$eval('article', articles => articles.map((article, idx) => {
    const subject = article.querySelector('.message-content strong')?.textContent?.trim() || '';
    const sender = article.querySelector('.message-sender span[title]')?.textContent?.trim() || '';
    const timeElement = article.querySelector('time');
    const time = timeElement?.getAttribute('datetime') || timeElement?.textContent?.trim() || '';
    return {
      idx, subject, sender, time,
      // 索引会随插入新邮件改变，不能拿 idx 当邮件身份。
      id: article.getAttribute('data-message-id') || (time ? `${sender}|${subject}|${time}` : ''),
    };
  }).filter(mail => mail.subject.includes('ChatGPT') &&
    (mail.sender.toLowerCase().includes('openai') || mail.subject.toLowerCase().includes('login code'))));
}

function checkUrl(url) {
  let valid = false;
  try { valid = ['http:', 'https:'].includes(new URL(url).protocol); } catch {}
  if (!valid) throw new Error('请配置有效的 http / https 取件地址');
}

async function loadMailbox(page, url, waitMs, timeout = 30000) {
  const deadline = Date.now() + timeout;
  const wdmail = new URL(url).hostname === 'api.wdmail.top';
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  if (response && !response.ok()) throw new Error(`取件服务返回 HTTP ${response.status()}`);
  await page.waitForSelector(wdmail ? 'header, article' : 'article, .empty, [class*="empty"]', { timeout: Math.min(Math.max(1, deadline - Date.now()), 15000) }).catch(() => {});
  await page.waitForTimeout(Math.min(waitMs, Math.max(0, deadline - Date.now())));
  const mails = await scrapeMessages(page, wdmail);
  if (mails.some(mail => !mail.id)) throw new Error('取件箱邮件缺少稳定 ID 或时间，无法识别新验证码');
  return mails;
}

async function snapshotMailIds(context, { url, pageLoadWaitMs = 2000, signal } = {}) {
  checkUrl(url);
  signal?.throwIfAborted();
  const page = await context.newPage();
  try {
    const mails = await loadMailbox(page, url, pageLoadWaitMs);
    signal?.throwIfAborted();
    return new Set(mails.map(mail => mail.id));
  } finally { await page.close().catch(() => {}); }
}

async function fetchCode(context, opts = {}) {
  const {
    url, pollIntervalMs = 4000, maxWaitMs = 120000, pageLoadWaitMs = 2000,
    toEmail, seenIds, freshAfterMs, snapshotBaseline = true, signal, log = () => {},
  } = opts;
  checkUrl(url);
  if (!Number.isFinite(freshAfterMs) || freshAfterMs < 0) throw new Error('取验证码必须提供本次提交或重发的时间');
  signal?.throwIfAborted();
  const seen = seenIds instanceof Set ? seenIds : new Set();
  let baselineDone = !snapshotBaseline || seen.size > 0;
  const page = await context.newPage();
  const deadline = Date.now() + maxWaitMs;
  let round = 0;
  log(`验证码邮件时间起点：${new Date(freshAfterMs).toISOString()}（UTC）`);

  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      round++;
      let candidates;
      try {
        candidates = await loadMailbox(page, url, Math.min(pageLoadWaitMs, Math.max(0, deadline - Date.now())), Math.min(30000, Math.max(1, deadline - Date.now())));
      } catch (e) {
        signal?.throwIfAborted();
        if (page.isClosed() || e.message.includes('缺少稳定 ID')) throw e;
        log(`第 ${round} 轮取件失败，稍后重试：${e.message.split('\n')[0]}`);
        await page.waitForTimeout(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
        continue;
      }
      if (Date.now() >= deadline) break;
      if (!baselineDone) {
        candidates.forEach(mail => seen.add(mail.id));
        baselineDone = true;
        log(`建立基线：${candidates.length} 封历史邮件`);
      } else {
        const unseen = candidates.filter(mail => !seen.has(mail.id));
        const fresh = unseen.filter(mail => isMailForRequest(mail, freshAfterMs))
          .sort((a, b) => mailReceivedAt(b.time) - mailReceivedAt(a.time));
        log(`第 ${round} 轮 · 共 ${candidates.length} 封 · 新 ID ${unseen.length} 封 · 本次时间范围 ${fresh.length} 封`);
        for (const mail of fresh) {
          signal?.throwIfAborted();
          let text = mail.text;
          if (text === undefined) {
            const article = page.locator('article').nth(mail.idx);
            const toggle = article.locator('button.message-row').first();
            if (await toggle.count() && await toggle.getAttribute('aria-expanded') !== 'true') {
              await toggle.click();
              await page.waitForTimeout(Math.min(800, Math.max(0, deadline - Date.now())));
            }
            text = await article.textContent() || '';
          }
          const recipients = (mail.recipient ?? text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
          if (toEmail && !recipients.some(email => matchesRecipient(email, toEmail))) {
            // 正文可能尚未加载，下轮再次检查，不能提前把 ID 排除。
            log('新邮件尚未匹配收件人，继续等待');
            continue;
          }
          const code = text.match(/\b(\d{6})\b/);
          if (code) {
            signal?.throwIfAborted();
            if (Date.now() >= deadline) break;
            seen.add(mail.id);
            log(`✓ 已取得本次请求的新验证码（邮件时间 ${mail.time}）`);
            return code[1];
          }
          log('新邮件正文尚未出现验证码，下轮重试');
        }
      }
      await page.waitForTimeout(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`等待验证码超时（${maxWaitMs / 1000}s）`);
  } finally { await page.close().catch(() => {}); }
}

module.exports = { fetchCode, snapshotMailIds, CODE_SUBJECT, matchesRecipient, mailReceivedAt, isMailForRequest };
