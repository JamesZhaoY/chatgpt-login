const { normalizeSecret, freshTotp } = require('./totp');
const { snapshotMailIds, fetchCode } = require('./mailer');
const { assertTrustedPage, submitButton, safePasswordError } = require('./password');

async function readAuthenticatorState(toggle) {
  const value = await toggle.getAttribute('aria-checked');
  if (value !== 'true' && value !== 'false') throw new Error('无法确认官网验证器开关状态，已停止操作，请先在官网检查');
  return value === 'true';
}

async function clickTwofaControl(control, step, signal) {
  try { await control.click({ timeout: 30000 }); }
  catch (error) {
    signal.throwIfAborted();
    if (!/timeout/i.test(error.message)) throw error;
    throw new Error(`${step}点击超时；操作结果未确认，请先检查官网验证器状态再重试`);
  }
}

async function describeBindingControls(dialog) {
  if (typeof dialog.evaluate !== 'function') return '';
  try {
    return await dialog.evaluate(root => {
      const controls = [...root.querySelectorAll('button, a, [role="button"], summary, [tabindex]')]
        .filter(el => el.getClientRects().length)
        .map(el => {
          const label = (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim();
          if (!label || label.length > 80 || /@|https?:|\d{6,}|\b[A-Z2-7]{12,}\b/.test(label)) return null;
          if (!/^[\p{L}\s\p{P}]+$/u.test(label)) return null;
          return `${el.tagName.toLowerCase()}:${label}`;
        }).filter(Boolean).slice(0, 12);
      return controls.join('、');
    });
  } catch { return ''; }
}

async function describeKeyFields(dialog) {
  if (typeof dialog.evaluate !== 'function') return '';
  try {
    return await dialog.evaluate(root => [...root.querySelectorAll('input, textarea, code, pre, strong, b, span, div, p')]
      .filter(el => el.getClientRects().length && (el.matches('input, textarea') || el.children.length === 0))
      .map(el => {
        const value = el.matches('input, textarea') ? el.value : el.textContent;
        const compact = String(value || '').replace(/[\s-]/g, '');
        if (!/^[A-Z2-7]{16,128}={0,6}$/i.test(compact)) return null;
        return `${el.tagName.toLowerCase()}${el.getAttribute('role') ? '[role]' : ''}${el.matches('input, textarea') ? '[value]' : '[text]'}`;
      }).filter(Boolean).slice(0, 8).join('、'));
  } catch { return ''; }
}

async function describeBindingStructure(dialog) {
  if (typeof dialog.evaluate !== 'function') return '';
  try {
    return await dialog.evaluate(root => [...root.querySelectorAll('input, textarea, code, pre, strong, b, span, div, p')]
      .filter(el => el.getClientRects().length && (el.matches('input, textarea') || el.children.length === 0))
      .map(el => {
        const value = String(el.matches('input, textarea') ? el.value : el.textContent || '').trim();
        if (value.length < 8 || value.length > 160) return null;
        return `${el.tagName.toLowerCase()}:${value.length}:${/^[A-Z2-7\s=-]+$/i.test(value) ? 'base32形态' : '文本'}`;
      }).filter(Boolean).slice(0, 15).join('、'));
  } catch { return ''; }
}

async function readBindingSecret(dialog, page, signal) {
  const code = dialog.locator('code').first();
  // 一些测试或旧版页面仅提供 code 元素。
  if (typeof dialog.evaluate !== 'function') return normalizeSecret((await code.innerText()).trim());
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    assertTrustedPage(page);
    const candidates = await dialog.evaluate(root => {
      const values = [];
      for (const el of root.querySelectorAll('input, textarea, code, pre, div, span, p, strong, b, [role="textbox"]')) {
        if (!el.getClientRects().length) continue;
        const text = el.matches('input, textarea') ? el.value : [...el.childNodes]
          .filter(node => node.nodeType === 3).map(node => node.textContent).join('');
        const compact = String(text || '').trim().replace(/[\s-]/g, '').toUpperCase();
        if (/^[A-Z2-7]{16,128}={0,6}$/.test(compact)) values.push(compact);
      }
      return [...new Set(values)];
    });
    if (candidates.length > 1) throw new Error('绑定窗口中发现多个可能的密钥，无法安全确认');
    if (candidates.length === 1) return normalizeSecret(candidates[0]);
    await page.waitForTimeout(300);
  }
  throw new Error('未能读取绑定窗口中的手动密钥，官网状态未确认');
}

async function enableTwofa({ page, context, email, mail, signal, store, log, stage, verifyLogin, replace = false, checkOnly = false }) {
  let secret = store.getTwofaSecret(email);
  const oldSecret = secret;
  const resumingSetup = !replace && Boolean(secret) && store.twofaSummary(email).canResumeSetup;
  if (checkOnly && !store.twofaSummary(email).setupNeedsCheck) throw new Error('没有需要核对的绑定提交');
  if (secret && !replace && !resumingSetup && !checkOnly) throw new Error('本机已有 2FA 密钥，请使用「验证 2FA 登录」核实，不要重复绑定');
  if (replace && !secret) throw new Error('请先保存当前的 2FA 密钥');
  try {
    stage('打开验证器设置');
    await page.goto('https://chatgpt.com/settings/security', { waitUntil: 'domcontentloaded' });
    assertTrustedPage(page);
    const toggle = page.getByRole('switch', { name: /^(Authenticator app|验证器应用|身份验证器应用)$/i });
    await toggle.waitFor({ state: 'visible', timeout: 30000 });
    if (checkOnly) {
      signal.throwIfAborted();
      if (!await readAuthenticatorState(toggle)) {
        // 仅在重新打开官网设置且确认关闭后，解除上一次提交的待确认状态。
        const record = store.twofa.get(email);
        store.recordTwofa(email, { lastSubmittedAt: record.submittedAt, submittedAt: null, error: null });
        return '官网验证器已关闭，可继续启用 2FA';
      }
      store.recordTwofa(email, { enabledAt: new Date().toISOString(), error: null });
      return '官网验证器已开启，现有密钥待验证';
    }
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
        log('正在点击官网验证器开关以关闭旧验证器');
        await clickTwofaControl(toggle, '关闭旧验证器开关', signal);
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
    } else if (await readAuthenticatorState(toggle)) throw new Error('官网已启用验证器，但本机没有密钥；请先导入现有密钥');

    stage(replace ? '绑定官网新验证器' : '启用官网验证器');
    freshAfterMs = Date.now();
    signal.throwIfAborted();
    assertTrustedPage(page);
    log('已确认官网验证器开关关闭，正在打开绑定流程');
    await clickTwofaControl(toggle, '打开验证器绑定开关', signal);
    let dialog = page.getByRole('dialog').or(page.getByRole('alertdialog')).filter({ has: page.getByRole('heading', { name: /(?:connect|set\s*up|add|configure).*authenticator|连接.*验证器|设置.*验证器|添加.*验证器/i }) });
    const deadline = Date.now() + (mail.maxWaitMs || 120000) + 45000;
    while (Date.now() < deadline && !await dialog.isVisible()) {
      await verifyIdentity();
      await page.waitForTimeout(300);
    }
    signal.throwIfAborted();
    if (!await dialog.isVisible()) throw new Error('等待验证器绑定窗口超时；未确认官网状态，请在官网检查后再重试');
    stage('读取 2FA 手动密钥');
    let controls = await describeBindingControls(dialog);
    if (controls) log(`绑定窗口可用控件：${controls}`);
    const manualName = /^(?:key|密钥)$|can.t scan|(?:enter|show|view|copy|use).*(?:setup\s*)?(?:key|code)|manual(?:ly)?.*(?:key|code)|无法扫描|手动.*(?:密钥|输入|代码)|(?:显示|复制|查看).*密钥/i;
    const intro = dialog.filter({ has: page.getByRole('heading', { name: /^set up an authenticator app$|^设置验证器应用$/i }) });
    const introContinue = intro.getByRole('button', { name: /^(Continue|继续)$/i });
    const initialManual = dialog.getByRole('button', { name: manualName }).or(dialog.getByRole('link', { name: manualName })).first();
    if (await intro.isVisible() && await introContinue.isVisible() && !await initialManual.isVisible() && !await dialog.locator('code').first().isVisible()) {
      log('已识别验证器介绍页面，继续打开绑定页面');
      await clickTwofaControl(introContinue, '继续验证器设置', signal);
      assertTrustedPage(page);
      dialog = page.getByRole('dialog').or(page.getByRole('alertdialog')).last();
      await dialog.waitFor({ state: 'visible', timeout: 15000 });
      controls = await describeBindingControls(dialog);
      if (controls) log(`绑定窗口可用控件：${controls}`);
    }
    const keyElement = dialog.locator('code').first();
    if (!await keyElement.isVisible()) {
      log('已识别验证器绑定窗口，正在打开手动密钥入口');
      const manual = dialog.getByRole('button', { name: manualName }).or(dialog.getByRole('link', { name: manualName })).first();
      try { await clickTwofaControl(manual, '打开手动密钥入口', signal); }
      catch (error) {
        signal.throwIfAborted();
        const count = await manual.count().catch(() => 0);
        if (!count) throw new Error('绑定窗口中未找到手动密钥入口；请核对官网窗口内容后重试');
        if (!await manual.isVisible().catch(() => false)) throw new Error('手动密钥入口未显示；请核对官网窗口内容后重试');
        if (!await manual.isEnabled().catch(() => false)) throw new Error('手动密钥入口不可点击；请核对官网窗口内容后重试');
        throw error;
      }
      await page.waitForTimeout(500);
      const afterControls = await describeBindingControls(dialog);
      if (afterControls) log(`选择手动密钥后的控件：${afterControls}`);
      const keyFields = await describeKeyFields(dialog);
      if (keyFields) log(`手动密钥字段结构：${keyFields}`);
      const structure = await describeBindingStructure(dialog);
      if (structure) log(`绑定页面字段结构：${structure}`);
    } else log('已识别验证器绑定窗口中显示的手动密钥');
    secret = await readBindingSecret(dialog, page, signal);
    signal.throwIfAborted();
    // 只读取手动密钥文本；不下载、截图或落盘二维码。
    if (replace) store.prepareTwofaRotation(email, secret);
    else if (resumingSetup && secret !== oldSecret) {
      store.replaceUnsubmittedTwofaSecret(email, oldSecret, secret);
      log('官网生成了新的未提交密钥，已保留之前的候选密钥');
    } else store.recordTwofa(email, { secret, preparedAt: new Date().toISOString(), error: null });
    log('已提取并保存 2FA Base32 密钥，未保存二维码');
    stage('提交验证器验证码');
    assertTrustedPage(page);
    const codeName = /^(?:code|验证码)$|6-digit code|verification code|6 位.*码|六位.*码|验证码/i;
    let codeInput = dialog.getByRole('textbox', { name: codeName }).first();
    if (!await codeInput.isVisible()) {
      log('已保存手动密钥，继续进入验证码输入页面');
      await clickTwofaControl(dialog.getByRole('button', { name: /^(Continue|继续)$/i }), '继续到验证器验证码', signal);
      assertTrustedPage(page);
      dialog = page.getByRole('dialog').or(page.getByRole('alertdialog')).last();
      const nextControls = await describeBindingControls(dialog);
      if (nextControls) log(`验证码页面可用控件：${nextControls}`);
      codeInput = dialog.getByRole('textbox', { name: codeName }).first();
      await codeInput.waitFor({ state: 'visible', timeout: 15000 });
    }
    const code = await freshTotp(secret, page, signal);
    await codeInput.fill(code);
    signal.throwIfAborted();
    store.recordTwofa(email, { [replace ? 'pendingSubmittedAt' : 'submittedAt']: new Date().toISOString() });
    log('正在提交验证器验证码');
    await clickTwofaControl(dialog.getByRole('button', { name: /^(Verify|Continue|验证|确认|继续)$/i }), '提交验证器验证码', signal);
    // 成功提示可能复用原弹窗。以重新打开的安全设置为准，避免把弹窗状态当成绑定结果。
    await Promise.any([
      codeInput.waitFor({ state: 'hidden', timeout: 25000 }),
      dialog.waitFor({ state: 'hidden', timeout: 25000 }),
    ]).catch(() => {});
    signal.throwIfAborted();
    stage('核对官网验证器开关');
    await page.goto('https://chatgpt.com/settings/security', { waitUntil: 'domcontentloaded' });
    assertTrustedPage(page);
    await toggle.waitFor({ state: 'visible', timeout: 15000 });
    if (!await readAuthenticatorState(toggle)) throw new Error('验证码已提交，官网暂未确认启用。请核对绑定结果，候选密钥已保留');
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

module.exports = { enableTwofa, readBindingSecret };
