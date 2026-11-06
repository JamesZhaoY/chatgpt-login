const { normalizeSecret, freshTotp } = require('./totp');
const { snapshotMailIds, fetchCode } = require('./mailer');
const { assertTrustedPage, submitButton, safePasswordError } = require('./password');

async function enableTwofa({ page, context, email, mail, signal, store, log, stage, verifyLogin, replace = false }) {
  let secret = store.getTwofaSecret(email);
  const oldSecret = secret;
  if (secret && !replace) throw new Error('本机已有 2FA 密钥，请使用「验证 2FA 登录」核实，不要重复绑定');
  if (replace && !secret) throw new Error('请先保存当前的 2FA 密钥');
  try {
    stage('打开验证器设置');
    await page.goto('https://chatgpt.com/settings/security', { waitUntil: 'domcontentloaded' });
    assertTrustedPage(page);
    const toggle = page.getByRole('switch', { name: /^(Authenticator app|验证器应用|身份验证器应用)$/i });
    await toggle.waitFor({ state: 'visible', timeout: 30000 });
    const mailOptions = { ...mail, signal };
    let seenIds = mail.url ? await snapshotMailIds(context, mailOptions) : new Set();
    signal.throwIfAborted();
    let freshAfterMs = Date.now();
    const otp = page.locator('input[autocomplete="one-time-code"]:visible, input[name="code"]:visible, input[inputmode="numeric"]:visible').first();
    const identity = { email: false, totp: false, password: false };
    const verifyIdentity = async () => {
      signal.throwIfAborted();
      assertTrustedPage(page);
      const modal = page.getByRole('dialog').or(page.getByRole('alertdialog')).last();
      const body = await (await modal.isVisible() ? modal : page.locator('body')).innerText();
      if (await otp.isVisible()) {
        const isTotp = /\/mfa\/(?:challenge|verify)/.test(new URL(page.url()).pathname) || /code[\s\S]*(?:authenticator|authentication app)|(?:authenticator|authentication app)[\s\S]*code|验证器.*码|码.*验证器/i.test(body);
        let code;
        if (isTotp) {
          if (identity.totp) throw new Error('旧验证器验证码未通过，请核实当前密钥');
          if (!oldSecret) throw new Error('官网要求现有验证器验证码，请先导入当前 2FA 密钥');
          stage('验证当前 2FA');
          code = await freshTotp(oldSecret, page, signal);
          identity.totp = true;
        } else {
          if (identity.email) throw new Error('2FA 设置需要额外身份验证，请检查官网提示');
          if (!body.toLowerCase().includes(email.toLowerCase()) || !/email|邮箱|邮件/i.test(body)) throw new Error('无法确认 2FA 身份验证邮件的收件人');
          if (!mail.url) throw new Error('官网要求邮箱验证码，请补充取件地址后继续');
          stage('验证 2FA 设置邮箱');
          code = await fetchCode(context, { ...mailOptions, toEmail: email, seenIds, freshAfterMs, snapshotBaseline: false, log });
          identity.email = true;
        }
        signal.throwIfAborted();
        assertTrustedPage(page);
        await otp.fill(code);
        await submitButton(page);
        await otp.waitFor({ state: 'hidden', timeout: 25000 });
        return true;
      }
      const passwordInput = page.locator('input[type="password"]:visible').first();
      if (await passwordInput.isVisible()) {
        if (identity.password || !/log-in\/password/.test(new URL(page.url()).pathname) && !/current password|enter.{0,30}password|confirm.{0,30}password|输入.*密码|当前密码/i.test(body)) throw new Error('无法确认 2FA 设置的密码验证页面，请检查官网提示');
        const password = store.getPassword(email);
        if (!password) throw new Error('官网要求当前密码，请先保存账号密码');
        await passwordInput.fill(password);
        await submitButton(page);
        await passwordInput.waitFor({ state: 'hidden', timeout: 25000 });
        identity.password = true;
        return true;
      }
      return false;
    };

    if (replace) {
      if (store.getTwofaSecret(email, true) && await toggle.getAttribute('aria-checked') === 'true') {
        stage('核实待确认的新 2FA');
        await verifyLogin();
        return;
      }
      if (!store.twofaSummary(email).rotating) store.beginTwofaRotation(email);
      if (await toggle.getAttribute('aria-checked') === 'true') {
        if (store.twofa.get(email)?.rotationDisabledAt) throw new Error('官网验证器状态已变化，请先核实待确认密钥，停止重复关闭验证器');
        stage('关闭官网旧验证器');
        assertTrustedPage(page);
        await toggle.click();
        const confirmation = page.getByRole('dialog').or(page.getByRole('alertdialog')).filter({ has: page.getByRole('heading', { name: /(?:turn off|disable|remove).*(?:authenticator|two.factor|multi.factor|MFA|2FA)|(?:关闭|停用|禁用|移除).*(?:验证器|双重|多重|两步|2FA)/i }) });
        let confirmed = false;
        const disableDeadline = Date.now() + (mail.maxWaitMs || 120000) + 30000;
        while (Date.now() < disableDeadline) {
          signal.throwIfAborted();
          assertTrustedPage(page);
          if (await verifyIdentity()) continue;
          if (await confirmation.isVisible()) {
            if (confirmed) throw new Error('官网尚未确认关闭旧验证器，请检查提示后重试');
            await confirmation.getByRole('button', { name: /^(Turn off(?: .*)?|Disable(?: .*)?|Remove(?: .*)?|Confirm|关闭(?:.*)?|停用(?:.*)?|禁用(?:.*)?|移除(?:.*)?|确认)$/i }).click();
            await confirmation.waitFor({ state: 'hidden', timeout: 25000 });
            confirmed = true;
            continue;
          }
          if (await toggle.isVisible() && await toggle.getAttribute('aria-checked') === 'false' && !await page.getByRole('dialog').or(page.getByRole('alertdialog')).last().isVisible()) break;
          await page.waitForTimeout(300);
        }
        if (!await toggle.isVisible() || await toggle.getAttribute('aria-checked') !== 'false') throw new Error('官网未确认关闭旧验证器，旧密钥已保留');
      }
      // 重新读取官网状态，避免把开关的乐观更新当成已解绑。
      await page.goto('https://chatgpt.com/settings/security', { waitUntil: 'domcontentloaded' });
      assertTrustedPage(page);
      await toggle.waitFor({ state: 'visible', timeout: 30000 });
      if (await toggle.getAttribute('aria-checked') !== 'false') throw new Error('官网未确认关闭旧验证器，旧密钥已保留');
      store.recordTwofa(email, { rotationDisabledAt: new Date().toISOString(), error: null,
        ...(store.getTwofaSecret(email, true) ? { supersededSecret: store.getTwofaSecret(email, true), pendingSecret: null, pendingPreparedAt: null, pendingSubmittedAt: null, pendingEnabledAt: null } : {}) });
      log('旧验证器已关闭，继续绑定新验证器；原密钥保留到新登录验证完成');
      seenIds = mail.url ? await snapshotMailIds(context, mailOptions) : new Set();
      Object.assign(identity, { email: false, totp: false, password: false });
    } else if (await toggle.getAttribute('aria-checked') === 'true') throw new Error('官网已启用验证器，但本机没有密钥；请先导入现有密钥');

    stage(replace ? '绑定官网新验证器' : '启用官网验证器');
    freshAfterMs = Date.now();
    signal.throwIfAborted();
    assertTrustedPage(page);
    await toggle.click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /Connect your authenticator app|连接.*验证器|设置.*验证器/i }) });
    const deadline = Date.now() + (mail.maxWaitMs || 120000) + 45000;
    while (Date.now() < deadline && !await dialog.isVisible()) {
      await verifyIdentity();
      await page.waitForTimeout(300);
    }
    await dialog.waitFor({ state: 'visible', timeout: 1000 });
    stage('读取 2FA 手动密钥');
    await dialog.getByRole('button', { name: /Can.t scan\?.*manually|无法扫描|手动输入/i }).click();
    secret = normalizeSecret((await dialog.locator('code').innerText()).trim());
    signal.throwIfAborted();
    // 只读取手动密钥文本；不下载、截图或落盘二维码。
    if (replace) store.prepareTwofaRotation(email, secret);
    else store.recordTwofa(email, { secret, preparedAt: new Date().toISOString(), error: null });
    log('已提取并保存 2FA Base32 密钥，未保存二维码');
    stage('提交验证器验证码');
    const code = await freshTotp(secret, page, signal);
    assertTrustedPage(page);
    await dialog.getByRole('textbox', { name: /6-digit code|6 位.*码|六位.*码/i }).fill(code);
    signal.throwIfAborted();
    store.recordTwofa(email, { [replace ? 'pendingSubmittedAt' : 'submittedAt']: new Date().toISOString() });
    await dialog.getByRole('button', { name: /^(Verify|验证|确认)$/i }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 25000 }).catch(async () => {
      const message = await dialog.locator('[role="alert"]').first().innerText().catch(() => '验证码未通过或结果未确认');
      throw new Error(`2FA 绑定失败：${message}`);
    });
    signal.throwIfAborted();
    const skipBackup = page.getByRole('button', { name: /^(Not now|暂时不用|暂不|以后再说)$/i });
    await toggle.or(skipBackup).first().waitFor({ state: 'visible', timeout: 15000 });
    if (await skipBackup.isVisible()) await skipBackup.click();
    await toggle.waitFor({ state: 'visible', timeout: 15000 });
    if (await toggle.getAttribute('aria-checked') !== 'true') throw new Error('官网未确认启用验证器，已保留候选密钥');
    store.recordTwofa(email, { [replace ? 'pendingEnabledAt' : 'enabledAt']: new Date().toISOString(), error: null });
    log('✓ 官网已启用验证器，开始全新登录验证');
    stage('验证 2FA 全新登录');
    await verifyLogin();
  } catch (error) {
    const message = safePasswordError(error, secret, oldSecret, store.getPassword(email), store.getTwofaSecret(email, true));
    try { store.recordTwofa(email, { error: message }); } catch {}
    throw new Error(message);
  }
}

module.exports = { enableTwofa };
