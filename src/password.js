const { randomInt } = require('node:crypto');
const { fetchCode, snapshotMailIds } = require('./mailer');
const { freshTotp } = require('./totp');

const PASSWORD_LENGTH = 12;
const GROUPS = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%'];
const TRUSTED_HOSTS = new Set(['chatgpt.com', 'auth.openai.com']);
const PASSWORD_FIELDS = 'input[type="password"]:visible, input[autocomplete="new-password"]:visible, input[autocomplete="current-password"]:visible';

function generatePassword() {
  const all = GROUPS.join('');
  const characters = GROUPS.map(group => group[randomInt(group.length)]);
  while (characters.length < PASSWORD_LENGTH) characters.push(all[randomInt(all.length)]);
  for (let i = characters.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [characters[i], characters[j]] = [characters[j], characters[i]];
  }
  return characters.join('');
}

function assertTrustedPage(page) {
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || !TRUSTED_HOSTS.has(url.hostname)) throw new Error('密码流程进入了非 OpenAI 页面，已停止');
}

function safePasswordError(error, ...passwords) {
  let message = String(error.message || error).split('\n')[0];
  for (const password of passwords) if (password) message = message.replaceAll(password, '[密码已隐藏]');
  return message;
}

async function submitButton(page) {
  const button = page.locator('button[type="submit"]:visible').or(
    page.getByRole('button', { name: /^(Continue|Save|Update password|Set password|Create password|Change password|Submit|Verify|继续|保存|更新密码|设置密码|修改密码|提交|验证)$/i })
  ).first();
  await button.click({ timeout: 15000 });
}

async function readPasswordForm(page) {
  assertTrustedPage(page);
  const fields = await page.locator(PASSWORD_FIELDS).all();
  const descriptions = await Promise.all(fields.map(field => field.evaluate(el => ({
    name: el.name, id: el.id, autocomplete: el.autocomplete,
    label: [el.getAttribute('aria-label'), el.placeholder, ...[...el.labels || []].map(label => label.textContent)].filter(Boolean).join(' '),
    minLength: el.minLength, maxLength: el.maxLength,
  }))));
  const passwordLogin = fields.length === 1 && new URL(page.url()).pathname === '/log-in/password';
  const current = descriptions.map((field, i) => passwordLogin || field.autocomplete === 'current-password' ||
    /current|old|当前|旧密码/i.test(`${field.name} ${field.id} ${field.label}`) || (fields.length === 3 && i === 0));
  return { fields, descriptions, current };
}

async function fillPasswordForm(page, password, currentPassword) {
  const { fields, descriptions, current } = await readPasswordForm(page);
  if (!fields.length) throw new Error('未找到密码输入框');
  if (current.every(Boolean)) throw new Error('页面仍在验证旧密码，请先重新登录账号');
  if (current.some(Boolean) && !currentPassword) throw new Error('该账号要求旧密码，但本机没有记录；请先在官网重置密码');
  // 校验所有字段后才开始填写。
  descriptions.forEach((field, i) => {
    if (current[i]) return;
    if (field.minLength > PASSWORD_LENGTH) throw new Error(`网站要求至少 ${field.minLength} 位密码，无法设置为 ${PASSWORD_LENGTH} 位`);
    if (field.maxLength >= 0 && field.maxLength < PASSWORD_LENGTH) throw new Error(`网站只接受最多 ${field.maxLength} 位密码`);
  });
  for (let i = 0; i < fields.length; i++) await fields[i].fill(current[i] ? currentPassword : password);
  for (const field of fields) {
    const validation = await field.evaluate(el => ({ valid: el.validity.valid, message: el.validationMessage }));
    if (!validation.valid) throw new Error(`网站未接受 ${PASSWORD_LENGTH} 位密码：${validation.message}`);
  }
}

async function readPasswordError(page) {
  return page.evaluate(() => {
    const messages = [];
    for (const field of document.querySelectorAll('input[type="password"], input[autocomplete="new-password"], input[autocomplete="current-password"]')) {
      if (!field.getClientRects().length) continue;
      if (!field.validity.valid && field.validationMessage) messages.push(field.validationMessage);
      for (const id of (field.getAttribute('aria-describedby') || '').split(/\s+/)) {
        const text = document.getElementById(id)?.textContent?.trim() || '';
        if (/incomplete|invalid|incorrect|too short|不满足|未满足|至少|错误|无效/i.test(text)) messages.push(text);
      }
    }
    for (const element of document.querySelectorAll('[role="alert"], [data-error], .error-message')) {
      if (element.getClientRects().length && element.textContent.trim()) messages.push(element.textContent.trim());
    }
    return [...new Set(messages)].join(' · ');
  }).catch(error => {
    if (/Execution context was destroyed|Cannot find context/i.test(error.message)) return '';
    throw error;
  });
}

async function completeTotpChallenge({ page, otp, totpSecret, signal, log, alreadySubmitted = false }) {
  signal.throwIfAborted();
  const url = new URL(page.url());
  const challengeUrl = /\/mfa\/(?:challenge|verify)/.test(url.pathname);
  if (!challengeUrl) {
    if (!await otp.isVisible()) return false;
    const body = await page.locator('body').innerText();
    if (!/authenticator|authentication app|验证器|身份验证应用/i.test(body)) return false;
  }
  assertTrustedPage(page);
  if (!totpSecret) throw new Error('账号需要验证器验证码，但本机没有 2FA 密钥');
  if (alreadySubmitted) throw new Error('验证器验证码未通过，请检查 2FA 密钥和系统时间');
  await otp.waitFor({ state: 'visible', timeout: 25000 });
  const code = await freshTotp(totpSecret, page, signal);
  assertTrustedPage(page);
  log('正在提交验证器 TOTP 验证码');
  await otp.fill(code);
  await submitButton(page);
  await Promise.any([
    page.waitForURL(next => next.href !== url.href, { timeout: 25000 }),
    otp.waitFor({ state: 'hidden', timeout: 25000 }),
  ]).catch(() => { throw new Error('验证器验证码未通过，请检查密钥和系统时间'); });
  log('✓ 验证器验证码已通过');
  return true;
}

async function verifyPasswordLogin({ page, context, email, password, mail, signal, log, totpSecret, requireTotp = false }) {
  signal.throwIfAborted();
  log(`正在验证密码登录，使用密码：${password}`);
  // 调用方必须提供全新 context，不能把旧 cookie 当成密码验证成功。
  await page.goto('https://chatgpt.com/auth/login_with?callback_path=/', { waitUntil: 'domcontentloaded' });
  const emailField = page.locator('input[type="email"]:visible, input[name="email"]:visible, input[name="login_hint"]:visible').first();
  await emailField.waitFor({ state: 'visible', timeout: 45000 });
  assertTrustedPage(page);
  await emailField.fill(email);
  await submitButton(page);
  const passwordField = page.locator('input[type="password"]:visible').first();
  const usePassword = page.getByRole('link', { name: /^(Continue with password|Use password|使用密码|使用密码继续)$/i })
    .or(page.getByRole('button', { name: /^(Continue with password|Use password|使用密码|使用密码继续)$/i })).first();
  await passwordField.or(usePassword).first().waitFor({ state: 'visible', timeout: 45000 });
  if (!await passwordField.isVisible()) {
    assertTrustedPage(page);
    await usePassword.click();
  }
  await passwordField.waitFor({ state: 'visible', timeout: 20000 });
  // 密码登录可能只要求验证器验证码；不要在确认需要邮箱验证码前访问取件服务。
  // 真正需要邮件时，fetchCode 仍会按提交时间过滤旧邮件。
  const mailOptions = { ...mail, signal };
  const seenIds = new Set();
  signal.throwIfAborted();
  assertTrustedPage(page);
  if (new URL(page.url()).pathname !== '/log-in/password') throw new Error('当前不是密码登录页面，已停止核验');
  await passwordField.fill(password);
  const freshAfterMs = Date.now();
  await submitButton(page);
  const otp = page.locator('input[autocomplete="one-time-code"]:visible, input[name="code"]:visible, input[inputmode="numeric"]:visible').first();
  const deadline = Date.now() + (mail.maxWaitMs || 120000) + 45000;
  let verifiedEmail = false;
  let verifiedTotp = false;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    assertTrustedPage(page);
    const url = new URL(page.url());
    if (url.hostname === 'chatgpt.com' && url.pathname === '/auth/error') throw new Error(`ChatGPT 登录回调失败：${url.searchParams.get('error') || '未知错误'}`);
    if (url.hostname === 'chatgpt.com' && !url.pathname.startsWith('/auth/')) {
      await page.goto('https://chatgpt.com/api/auth/session', { waitUntil: 'domcontentloaded' });
      const raw = await page.locator('body').innerText();
      const session = JSON.parse(raw);
      if (!session.accessToken || session.user?.email?.toLowerCase() !== email.toLowerCase()) throw new Error('密码登录后未取得该账号的有效会话');
      if (requireTotp && !verifiedTotp) throw new Error('本次登录未出现验证器挑战，不能确认 2FA 已启用');
      log('✓ 已用密码完成全新登录，并核对会话邮箱');
      return { email, accessToken: session.accessToken, raw, expires: session.expires || '', fetchedAt: new Date().toISOString(), totpVerified: verifiedTotp };
    }
    const error = await readPasswordError(page);
    if (error) throw new Error(`密码登录失败：${error}`);
    if (await otp.isVisible()) {
      if (await completeTotpChallenge({ page, otp, totpSecret, signal, log, alreadySubmitted: verifiedTotp })) {
        verifiedTotp = true;
        continue;
      }
      const body = await page.locator('body').innerText();
      if (verifiedEmail) throw new Error('密码登录还需要额外验证，请检查官网提示');
      if (!body.toLowerCase().includes(email.toLowerCase()) || !/email|邮箱|邮件/i.test(body)) throw new Error('无法确认附加验证码的收件人');
      if (!mail.url) throw new Error('官网要求邮箱验证码，请为该账号补充取件地址后重试');
      log('密码登录要求附加邮箱验证码，正在读取新邮件');
      const code = await fetchCode(context, { ...mailOptions, toEmail: email, seenIds, freshAfterMs, snapshotBaseline: false, log });
      signal.throwIfAborted();
      assertTrustedPage(page);
      await otp.fill(code);
      await submitButton(page);
      await Promise.any([
        page.waitForURL(next => next.href !== url.href, { timeout: 25000 }),
        otp.waitFor({ state: 'hidden', timeout: 25000 }),
      ]).catch(() => { throw new Error('密码登录的附加邮箱验证码未通过'); });
      verifiedEmail = true;
      continue;
    }
    await page.waitForTimeout(300);
  }
  throw new Error('密码登录验证超时，密码记录仍待确认');
}

async function initializePassword({ page, context, email, currentPassword, mail, signal, log, stage, store, verifyPassword, totpSecret }) {
  const password = generatePassword();
  const mailOptions = { ...mail, signal };
  try {
    stage('打开密码设置');
    await page.goto('https://chatgpt.com/settings/security', { waitUntil: 'domcontentloaded' });
    assertTrustedPage(page);
    const entry = page.getByRole('button', { name: /^Password\b|^密码(?:\s|$)/i }).first();
    await entry.waitFor({ state: 'visible', timeout: 30000 });
    const seenIds = mail.url ? await snapshotMailIds(context, mailOptions) : new Set();
    signal.throwIfAborted();
    const freshAfterMs = Date.now();
    await entry.click();
    log('已打开密码设置，等待身份验证');

    const otp = page.locator('input[autocomplete="one-time-code"]:visible, input[name="code"]:visible, input[inputmode="numeric"]:visible').first();
    const passwordInput = page.locator(PASSWORD_FIELDS).first();
    const deadline = Date.now() + (mail.maxWaitMs || 120000) + 45000;
    let verifiedEmail = false;
    let verifiedTotp = false;
    let currentPasswordSubmittedAt = null;
    let passwordFormReady = false;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      assertTrustedPage(page);
      if (await passwordInput.isVisible()) {
        const { fields, current } = await readPasswordForm(page);
        if (fields.length) {
          if (!current.every(Boolean)) { passwordFormReady = true; break; }
          // 独立的旧密码验证页只是身份验证步骤，不能填入候选新密码。
          if (currentPasswordSubmittedAt !== null) {
            const error = await readPasswordError(page);
            if (error) throw new Error(`当前密码验证失败：${error}`);
            if (Date.now() - currentPasswordSubmittedAt >= 25000) throw new Error('当前密码验证未完成，请检查官网提示或本机保存的当前密码');
            await page.waitForTimeout(300);
            continue;
          }
          if (!currentPassword) throw new Error('官网要求当前密码，请在「编辑账号」中填写当前密码后重试');
          if (fields.length !== 1) throw new Error('无法识别当前密码验证表单，已停止修改');
          stage('验证当前密码');
          signal.throwIfAborted();
          assertTrustedPage(page);
          await fields[0].fill(currentPassword);
          signal.throwIfAborted();
          assertTrustedPage(page);
          currentPasswordSubmittedAt = Date.now();
          await submitButton(page);
          log('已提交当前密码验证，等待进入新密码设置');
          continue;
        }
      }
      if (await otp.isVisible()) {
        const text = await page.locator('body').innerText();
        if (/authenticator|authentication app|验证器|身份验证应用/i.test(text)) {
          if (!totpSecret) throw new Error('该账号要求验证器验证码，但本机没有 2FA 密钥');
          if (verifiedTotp) throw new Error('验证器验证码未通过，请检查密钥与系统时间');
          stage('验证改密所需的 2FA');
          const code = await freshTotp(totpSecret, page, signal);
          assertTrustedPage(page);
          const before = page.url();
          await otp.fill(code);
          await submitButton(page);
          await Promise.any([
            page.waitForURL(url => url.href !== before, { timeout: 25000 }),
            otp.waitFor({ state: 'hidden', timeout: 25000 }),
          ]).catch(() => { throw new Error('改密前的验证器验证码未通过'); });
          verifiedTotp = true;
          log('✓ 改密所需的验证器验证已通过');
          continue;
        }
        if (verifiedEmail) throw new Error('网站仍要求额外身份验证，请先在官网完成验证后重试');
        // 只处理页面明确发给此账号邮箱的验证码。
        if (!text.toLowerCase().includes(email.toLowerCase()) || !/email|邮箱|邮件/i.test(text)) {
          throw new Error('无法确认本次验证码属于该邮箱，已停止密码操作');
        }
        stage('等待密码设置验证码');
        if (!mail.url) throw new Error('官网要求邮箱验证码，请为该账号补充取件地址后重试');
        const code = await fetchCode(context, { ...mailOptions, toEmail: email, seenIds, freshAfterMs, snapshotBaseline: false, log });
        signal.throwIfAborted();
        assertTrustedPage(page);
        await otp.fill(code);
        await submitButton(page);
        await otp.waitFor({ state: 'hidden', timeout: 25000 }).catch(() => { throw new Error('邮箱验证码未通过，请重试'); });
        verifiedEmail = true;
        log('✓ 邮箱身份验证已通过');
        continue;
      }
      await page.waitForTimeout(300);
    }
    signal.throwIfAborted();
    if (!passwordFormReady) throw new Error('等待密码设置表单超时');
    stage(`设置 ${PASSWORD_LENGTH} 位随机密码`);
    await fillPasswordForm(page, password, currentPassword);
    signal.throwIfAborted();
    // 先持久化候选值。即使提交后网络断开或进程退出，也能找回候选密码。
    store.preparePassword(email, password);
    log(`本次 ${PASSWORD_LENGTH} 位随机密码：${password}`);
    store.recordPassword(email, { submittedAt: new Date().toISOString() });
    await submitButton(page);

    const success = page.getByText(/password (?:has been |was )?(?:successfully )?(?:updated|changed|created|set|added)(?: successfully)?|密码(?:已)?(?:成功)?(?:更新|修改|创建|设置|添加)(?:成功|完成)/i).first();
    const confirm = async () => {
      stage('使用新密码验证登录');
      await verifyPassword(password);
      signal.throwIfAborted();
      store.confirmPassword(email);
      store.recordPassword(email, { verifiedAt: new Date().toISOString() });
      log(`✓ 密码修改及登录验证成功，密码：${password}`);
    };
    const resultDeadline = Date.now() + 30000;
    while (Date.now() < resultDeadline) {
      signal.throwIfAborted();
      assertTrustedPage(page);
      if (await success.isVisible()) {
        await confirm();
        return;
      }
      const message = await readPasswordError(page);
      if (message) {
          // 明确的密码校验错误可撤销候选；其他错误保留候选以防请求其实已生效。
          const rejected = /at least|incomplete|too short|password.*(?:must|weak|incorrect|invalid|cannot|can't)|密码.*(?:至少|不能|无效|错误|不符合|过短|过弱)/i.test(message);
          const error = new Error(`密码设置失败：${message}`);
          error.passwordRejected = rejected;
          throw error;
      }
      if (new URL(page.url()).hostname === 'chatgpt.com' && !await passwordInput.isVisible()) {
        // 实际改密成功会返回未登录的首页，并不一定显示 Change 按钮。
        await confirm();
        return;
      }
      await page.waitForTimeout(300);
    }
    log('未识别到成功页面，改用全新密码登录确认结果');
    await confirm();
  } catch (error) {
    const message = safePasswordError(error, password, currentPassword);
    store.failPassword(email, message, error.passwordRejected === true);
    throw new Error(message);
  }
}

module.exports = { generatePassword, fillPasswordForm, initializePassword, verifyPasswordLogin, completeTotpChallenge, readPasswordError, safePasswordError, assertTrustedPage, submitButton };
