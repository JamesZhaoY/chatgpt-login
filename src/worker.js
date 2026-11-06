/**
 * 登录核心：单账号 flow + 队列调度
 *
 * 流程：
 *   1. 有 session 缓存 → /api/auth/session 验证，有效就直接返回
 *   2. 完整登录 → chatgpt.com → 点 Log in → SPA modal → 输邮箱（人类节奏）
 *   3. 邮箱 fresh（按时间戳过滤旧码）→ 提取 6 位 → 提交
 *   4. 失败重试 3 次（Resend 触发新码）
 *   5. 成功后存 profile + info，复用当前页面读取会员与窗口额度
 */

const fs = require('fs');
const { getBrowser, newContext } = require('./browser');
const { fetchCode, snapshotMailIds } = require('./mailer');
const { proxyOptions } = require('./proxy');
const { initializePassword, verifyPasswordLogin, completeTotpChallenge, safePasswordError } = require('./password');
const { enableTwofa } = require('./twofa');
const { fetchPlanDetails, mergePlanSnapshot } = require('./plans');

const SESSION_URL = 'https://chatgpt.com/api/auth/session';
const HOME_URL = 'https://chatgpt.com/';

class LoginWorker {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
    this.queue = [];
    this.inFlight = new Set();
    this.running = false;
    this.stopping = false;
    this.currentController = null;
    this.controllers = new Set();
    this.drainPromise = null;
    this.operations = new Map();
  }

  enqueue(emails, operation = 'login') {
    if (!['login', 'password', 'password-verify', 'twofa', 'twofa-verify', 'twofa-replace', 'plan', 'setup', 'setup-password', 'setup-twofa'].includes(operation)) throw new Error('未知任务类型');
    if (this.stopping) throw Object.assign(new Error('服务正在关闭'), { status: 503 });
    const queued = [];
    emails.forEach(email => {
      if (!this.store.accounts.has(email)) return;
      if (this.inFlight.has(email)) return;
      if (this.queue.includes(email)) return;
      const acc = this.store.getAccount(email);
      if (acc.status === 'running' || acc.unavailable) return;
      if (operation === 'password' && this.store.passwordSummary(email).uncertain) return;
      if (operation.startsWith('setup') && this.setupComplete(email, operation)) return;
      this.operations.set(email, operation);
      const labels = { password: '密码初始化排队中', 'password-verify': '密码登录验证排队中', twofa: '2FA 绑定排队中', 'twofa-verify': '2FA 登录验证排队中', plan: '套餐信息读取排队中', setup: '密码与 2FA 初始化排队中', 'setup-password': '初始化密码排队中', 'setup-twofa': '开通 2FA 排队中' };
      this.store.setStatus(email, 'pending', { stage: operation === 'twofa-replace' ? '更换官网 2FA 排队中' : labels[operation] || '排队中', error: null, operation });
      this.queue.push(email);
      queued.push(email);
    });
    this._broadcastState();
    if (!this.running && this.queue.length) this.drainPromise = this._drain();
    return queued;
  }

  clearQueue() {
    const removed = this.queue.splice(0);
    for (const email of removed) {
      const acc = this.store.accounts.get(email);
      if (acc) this.store.setStatus(email, this.store.infoStatus(acc.info), { stage: '', error: null, operation: null });
      this.operations.delete(email);
    }
    this._broadcastState();
    return removed.length;
  }

  async stop() {
    this.stopping = true;
    this.clearQueue();
    for (const controller of this.controllers) controller.abort(new Error('服务关闭，当前登录已停止'));
    await this.drainPromise;
  }

  _broadcastState() {
    this.store.broadcast({ type: 'worker', worker: this.getState() });
  }

  async _runOne(email, operation = 'login') {
    const controller = new AbortController();
    this.currentController = controller;
    this.controllers.add(controller);
    const task = { signal: controller.signal, contexts: new Set(), proxy: proxyOptions(this.config.proxy) };
    const timeout = (this.config.batch.perAccountTimeoutMs || 300000) * (['setup', 'twofa-replace'].includes(operation) ? 2 : 1);
    const timer = setTimeout(() => controller.abort(new Error(`单账号任务超时（${timeout / 1000}s）`)), timeout);
    const aborted = new Promise((_, reject) => task.signal.addEventListener('abort', () => reject(task.signal.reason), { once: true }));
    let completed;
    try {
      if (operation !== 'plan') this.store.saveImportedTwofa(email);
      const run = (async () => {
        await (operation === 'password' ? this._initializePassword(email, task)
        : operation === 'password-verify' ? this._verifyPassword(email, task)
        : operation === 'twofa' ? this._initializeTwofa(email, task)
        : operation === 'twofa-replace' ? this._replaceTwofa(email, task)
        : operation === 'twofa-verify' ? this._verifyTwofa(email, task)
        : operation.startsWith('setup') ? this._setupAccount(email, task, operation)
        : operation === 'plan' ? this._fetchPlan(email, task) : this._loginOne(email, task));
        if (operation === 'plan' || !task.session) return;
        // 多步初始化只在最终验证成功后查询一次；查询错误不能覆盖登录/改密结果。
        const acc = this.store.getAccount(email);
        completed = { status: acc.status, stage: acc.stage, operation: null, error: acc.error };
        await this._fetchPlan(email, task, true);
        task.signal.throwIfAborted();
        const updated = this.store.plans.get(email)?.partial ? '会员已更新，窗口额度待刷新' : '会员与窗口额度已更新';
        this.store.setStatus(email, completed.status, { ...completed, stage: `${completed.stage || '登录成功'} · ${updated}` });
      })();
      await Promise.race([run, aborted]);
    } catch (error) {
      if (!completed) throw error;
      const record = this.store.passwords.get(email);
      const message = safePasswordError(error, record?.password, record?.pendingPassword, this.store.getTwofaSecret(email), this.store.getTwofaSecret(email, true));
      try { this.store.savePlan(email, { ...this.store.plans.get(email), error: message, attemptedAt: new Date().toISOString() }); }
      catch { this.store.log(email, '会员查询结果无法写入本机，已保留之前的记录'); }
      this.store.setStatus(email, completed.status, { ...completed, stage: `${completed.stage || '登录成功'} · 会员信息待刷新` });
      this.store.log(email, `会员信息自动更新未完成，已保留登录结果与上次记录：${message}`);
    }
    finally {
      clearTimeout(timer);
      await Promise.allSettled([...task.contexts].map(context => context.close()));
      if (this.currentController === controller) this.currentController = null;
      this.controllers.delete(controller);
    }
  }

  async _createContext(browser, extra, task) {
    task.signal.throwIfAborted();
    // 一项任务的登录、取件、改密和验证固定使用开始时的代理；后续任务读取新配置。
    const proxy = Object.hasOwn(task, 'proxy') ? task.proxy : proxyOptions(this.config.proxy);
    const context = await newContext(browser, { ...extra, proxy });
    if (task.signal.aborted) {
      await context.close().catch(() => {});
      task.signal.throwIfAborted();
    }
    task.contexts.add(context);
    return context;
  }

  async _releaseContext(context, task) {
    // 成功登录的页面留到同一账号任务结束，供设置和会员查询复用。
    if (task.session?.context === context) return;
    await context.close().catch(() => {});
    task.contexts.delete(context);
  }

  async _drain() {
    if (this.running) return;
    this.running = true;
    this._broadcastState();
    try {
      const pool = new Set();
      const run = async () => {
        const email = this.queue.shift();
        const operation = this.operations.get(email) || 'login';
        this.inFlight.add(email);
        this._broadcastState();
        try {
          await this._runOne(email, operation);
        } catch (e) {
          const record = this.store.passwords.get(email);
          const message = safePasswordError(e, record?.password, record?.pendingPassword, this.store.getTwofaSecret(email), this.store.getTwofaSecret(email, true));
          if (operation.startsWith('password')) {
            try { this.store.failPassword(email, message); } catch { /* 保留磁盘上的候选密码，错误仍显示在任务上。 */ }
          }
          if (operation.startsWith('twofa')) {
            try { this.store.recordTwofa(email, { error: message }); } catch {}
          }
          if (operation === 'plan') {
            try { this.store.savePlan(email, { ...this.store.plans.get(email), error: message, attemptedAt: new Date().toISOString() }); } catch {}
            this.store.setStatus(email, this.store.infoStatus(this.store.getAccount(email).info), { stage: '套餐查询失败', error: null, operation: null });
          } else {
            this.store.setStatus(email, 'fail', { stage: '已停止', error: message });
          }
          this.store.log(email, `✗ 失败：${message}`);
        } finally {
          this.inFlight.delete(email);
          this.operations.delete(email);
          this._broadcastState();
        }
        if (this.queue.length) {
          await new Promise(r => setTimeout(r, this.config.batch.delayBetweenAccountsMs));
        }
      };
      while (this.queue.length || pool.size) {
        while (this.queue.length && pool.size < (this.config.batch.threadPoolSize || 1)) {
          const pending = run();
          pool.add(pending);
          pending.finally(() => pool.delete(pending));
        }
        if (pool.size) await Promise.race(pool);
      }
    } finally {
      this.running = false;
      this._broadcastState();
    }
  }

  async _fetchPlan(email, task, retried = false) {
    const acc = this.store.getAccount(email);
    const profileFile = this.store.profilePath(email);
    const session = task.session?.email === email ? task.session : null;
    if (!session && !fs.existsSync(profileFile)) throw new Error('尚未保存该账号的登录会话，请先登录后获取会员信息');
    this.store.setStatus(email, 'running', { stage: '读取会员类别、到期时间与窗口额度', operation: 'plan', error: null });
    const context = session?.context || await this._createContext(await getBrowser(this.config), { storageState: profileFile }, task);
    let refreshSession = false;
    try {
      const current = await fetchPlanDetails({
        page: session?.page || await context.newPage(), email, signal: task.signal,
        log: message => { if (!task.signal.aborted) this.store.log(email, message); },
      });
      task.signal.throwIfAborted();
      const plan = mergePlanSnapshot(this.store.plans.get(email), current);
      this.store.savePlan(email, plan);
      this.store.setStatus(email, this.store.infoStatus(acc.info), { stage: plan.partial ? '会员类别已更新，窗口额度待刷新' : '会员与窗口额度已更新', operation: null, error: null });
      this.store.log(email, `✓ 会员信息已获取：${plan.planName}${plan.partial ? '（窗口额度暂未返回）' : ''}`);
    } catch (error) {
      if (error.code !== 'PLAN_SESSION_EXPIRED' || retried || !this.store.getPassword(email) || this.store.passwordSummary(email).uncertain) throw error;
      refreshSession = true;
      if (task.session?.context === context) task.session = null;
    } finally {
      await this._releaseContext(context, task);
    }
    if (refreshSession) {
      task.signal.throwIfAborted();
      this.store.log(email, '套餐接口拒绝旧会话，使用已保存的密码重新登录后重试一次');
      this.store.saveImportedTwofa(email);
      await this._verifyPassword(email, task);
      task.signal.throwIfAborted();
      return this._fetchPlan(email, task, true);
    }
  }

  setupComplete(email, operation = 'setup') {
    const password = this.store.passwordSummary(email);
    const twofa = this.store.twofaSummary(email);
    const passwordReady = password.saved && password.verifiedAt && !password.uncertain && !password.error;
    const twofaReady = twofa.hasSecret && twofa.enabled && twofa.verifiedAt && !twofa.pending && !twofa.error;
    return Boolean(operation === 'setup-password' ? passwordReady : operation === 'setup-twofa' ? twofaReady : passwordReady && twofaReady);
  }

  async _setupAccount(email, task, operation = 'setup') {
    let phase = 'password';
    try {
      task.signal.throwIfAborted();
      this.store.setStatus(email, 'running', { stage: '检查密码与 2FA 状态', operation, error: null });
      if (operation !== 'setup-twofa' && !this.setupComplete(email, 'setup-password')) {
        if (this.store.getPassword(email, true) || this.store.getPassword(email)) await this._verifyPassword(email, task);
        else await this._initializePassword(email, task);
      }
      task.signal.throwIfAborted();
      if (operation !== 'setup-password' && !this.setupComplete(email, 'setup-twofa')) {
        phase = 'twofa';
        this.store.setStatus(email, 'running', { stage: '开通并验证 2FA', operation, error: null });
        if (this.store.twofaSummary(email).rotating) await this._replaceTwofa(email, task);
        else if (this.store.getTwofaSecret(email)) await this._verifyTwofa(email, task);
        else await this._initializeTwofa(email, task);
      }
      task.signal.throwIfAborted();
      if (!this.setupComplete(email, operation)) throw new Error('初始化尚未确认完成，请查看密码与 2FA 状态');
      const acc = this.store.getAccount(email);
      const stage = operation === 'setup-password' ? '密码初始化完成' : operation === 'setup-twofa' ? '2FA 开通完成' : '密码与 2FA 初始化完成';
      this.store.setStatus(email, this.store.infoStatus(acc.info), { stage, operation: null, error: null });
      this.store.log(email, `✓ ${stage}`);
    } catch (error) {
      const record = this.store.passwords.get(email);
      const message = safePasswordError(error, record?.password, record?.pendingPassword, this.store.getTwofaSecret(email), this.store.getTwofaSecret(email, true));
      try {
        if (phase === 'password') this.store.failPassword(email, message);
        else this.store.recordTwofa(email, { error: message });
      } catch {}
      throw new Error(message);
    }
  }

  async _verifyPassword(email, task, candidate, requireTotp = false) {
    const password = candidate || this.store.getPassword(email, true) || this.store.getPassword(email);
    if (!password) throw new Error('没有可用于验证的密码');
    const acc = this.store.getAccount(email);
    this.store.setStatus(email, 'running', { stage: requireTotp ? '验证密码与 2FA 全新登录' : '使用密码全新登录', operation: requireTotp ? 'twofa-verify' : candidate ? 'password' : 'password-verify', error: null });
    const log = message => { if (!task.signal.aborted) this.store.log(email, message); };
    const browser = await getBrowser(this.config);
    const context = await this._createContext(browser, {}, task);
    try {
      const page = await context.newPage();
      const totpSecret = this.store.twofa.get(email)?.pendingSubmittedAt ? this.store.getTwofaSecret(email, true) : this.store.getTwofaSecret(email);
      const { totpVerified, ...info } = await verifyPasswordLogin({
        page, context, email, password,
        mail: { ...this.config.mail, url: acc.mailUrl || this.config.mail.url },
        signal: task.signal, log,
        totpSecret, requireTotp,
      });
      task.signal.throwIfAborted();
      const state = await context.storageState();
      task.signal.throwIfAborted();
      this.store.saveProfile(email, state);
      this.store.saveInfo(email, info);
      acc.info = info;
      if (totpVerified) this._recordTotpVerification(email, totpSecret);
      if (!candidate) {
        if (this.store.getPassword(email, true) === password) this.store.confirmPassword(email);
        this.store.recordPassword(email, { verifiedAt: new Date().toISOString(), error: null });
        this.store.setStatus(email, 'ok', { info, stage: '密码登录验证成功', operation: null, error: null });
        log(`✓ 密码登录验证成功，密码：${password}`);
      } else if (password === this.store.getPassword(email)) this.store.recordPassword(email, { verifiedAt: new Date().toISOString(), error: null });
      task.session = { email, context, page };
      return info;
    } finally {
      await this._releaseContext(context, task);
    }
  }

  async _verifyTwofa(email, task) {
    if (!this.store.getTwofaSecret(email)) throw new Error('本机没有该账号的 2FA 密钥');
    if (this.store.getTwofaSecret(email, true) && !this.store.twofa.get(email)?.pendingSubmittedAt) throw new Error('新 2FA 尚未提交，请点击「修改 2FA」继续绑定');
    const password = this.store.getPassword(email, true) || this.store.getPassword(email);
    if (password) await this._verifyPassword(email, task, undefined, true);
    else await this._loginWithEmail(email, task, true);
    task.signal.throwIfAborted();
    if (this.store.twofaSummary(email).rotating) throw new Error('2FA 更换尚未完成，请点击「修改 2FA」继续绑定');
    const acc = this.store.getAccount(email);
    const method = password ? '密码' : '邮箱验证码';
    this.store.setStatus(email, 'ok', { info: acc.info, stage: `${method} + 2FA 登录验证成功`, operation: null, error: null });
    this.store.log(email, `✓ 已用${method} + 验证器验证码完成全新登录，2FA 密钥已确认有效`);
  }

  _recordTotpVerification(email, secret) {
    if (secret === this.store.getTwofaSecret(email, true)) this.store.confirmTwofaRotation(email);
    else if (!this.store.twofaSummary(email).rotating) {
      const now = new Date().toISOString();
      this.store.recordTwofa(email, { enabledAt: this.store.twofa.get(email)?.enabledAt || now, verifiedAt: now, error: null });
    }
  }

  async _replaceTwofa(email, task) {
    return this._initializeTwofa(email, task, true);
  }

  async _initializeTwofa(email, task, replace = false) {
    if (replace && !this.store.getTwofaSecret(email)) throw new Error('请先保存当前的 2FA 密钥');
    if (!replace && this.store.getTwofaSecret(email)) throw new Error('已有 2FA 密钥，请先使用验证 2FA 登录');
    if (!this.store.getPassword(email) && !this.store.getPassword(email, true) && !this.store.getAccount(email).mailUrl && !this.config.mail.url) throw new Error('请先填写当前密码或取件地址，再设置并验证 2FA');
    const resuming = replace && this.store.twofaSummary(email).rotating;
    await this._loginOne(email, task);
    task.signal.throwIfAborted();
    if (resuming && !this.store.twofaSummary(email).rotating) return;
    const acc = this.store.getAccount(email);
    const session = JSON.parse(acc.info.raw);
    if (session.user?.email?.toLowerCase() !== email.toLowerCase()) throw new Error('会话邮箱与所选账号不一致');
    const { context, page } = task.session;
    try {
      await enableTwofa({
        page, context, email, store: this.store, signal: task.signal, replace,
        mail: { ...this.config.mail, url: acc.mailUrl || this.config.mail.url },
        log: message => { if (!task.signal.aborted) this.store.log(email, message); },
        stage: text => { task.signal.throwIfAborted(); this.store.setStatus(email, 'running', { stage: text, operation: replace ? 'twofa-replace' : 'twofa', error: null }); },
        verifyLogin: () => this._verifyTwofa(email, task),
      });
    } finally {
      await this._releaseContext(context, task);
    }
  }

  async _initializePassword(email, task) {
    if (this.store.passwordSummary(email).uncertain) throw new Error('上次提交结果未确认，请先核实已保留的候选密码');
    const acc = this.store.getAccount(email);
    await this._loginOne(email, task);
    task.signal.throwIfAborted();
    const session = JSON.parse(this.store.accounts.get(email).info.raw);
    if (typeof session.user?.email !== 'string' || session.user.email.toLowerCase() !== email.toLowerCase()) {
      throw new Error('会话邮箱与所选账号不一致，已停止密码操作');
    }
    const { context, page } = task.session;
    const stage = text => {
      task.signal.throwIfAborted();
      this.store.setStatus(email, 'running', { stage: text, error: null, operation: 'password' });
    };
    const log = text => { if (!task.signal.aborted) this.store.log(email, text); };
    try {
      await initializePassword({
        page, context, email,
        currentPassword: this.store.getPassword(email),
        mail: { ...this.config.mail, url: acc.mailUrl || this.config.mail.url },
        signal: task.signal, log, stage, store: this.store,
        verifyPassword: password => this._verifyPassword(email, task, password),
        totpSecret: this.store.getTwofaSecret(email),
      });
      task.signal.throwIfAborted();
      // 验证流程已经保存全新登录会话，不再用改密前的 context 覆盖。
      this.store.setStatus(email, this.store.infoStatus(acc.info), { info: acc.info, stage: '密码已设置并验证', error: null, operation: null });
    } finally {
      await this._releaseContext(context, task);
    }
  }

  async _loginOne(email, task) {
    task.signal.throwIfAborted();
    if (task.session?.email === email) return this.store.getAccount(email).info;
    if (this.store.getPassword(email, true) || this.store.getPassword(email)) return this._verifyPassword(email, task);
    if (this.store.loginMethod(email) === 'missing') throw new Error('请填写当前密码或取件地址后登录；2FA 密钥不能单独用于登录');
    return this._loginWithEmail(email, task);
  }

  async _loginWithEmail(email, task, requireTotp = false) {
    const { signal } = task;
    const acc = this.store.getAccount(email);
    const totpSecret = this.store.twofa.get(email)?.pendingSubmittedAt ? this.store.getTwofaSecret(email, true) : this.store.getTwofaSecret(email);
    if (requireTotp && !acc.mailUrl && !this.config.mail.url) throw new Error('请填写当前密码或取件地址，再验证 2FA 登录');
    this.store.clearLogs(email);
    const log = msg => { if (!signal.aborted) this.store.log(email, msg); };
    const setStatus = (status, extra) => {
      signal.throwIfAborted();
      this.store.setStatus(email, status, extra);
    };
    const saveSession = raw => {
      signal.throwIfAborted();
      const session = JSON.parse(raw);
      if (!session.accessToken || session.user?.email?.toLowerCase() !== email.toLowerCase()) throw new Error('登录后未取得该账号的有效会话');
      const info = { email, accessToken: session.accessToken, raw, expires: session.expires || '', fetchedAt: new Date().toISOString() };
      this.store.saveInfo(email, info);
      setStatus('ok', { stage: '完成', info, error: null });
      return info;
    };

    setStatus('running', { stage: '开始', error: null });
    log(`开始登录 ${email}`);
    log(`取件箱：${acc.mailUrl || '(未配置)'}`);

    const profileFile = this.store.profilePath(email);
    const browser = await getBrowser(this.config);
    signal.throwIfAborted();

    // ---------- 分支 1：复用 session ----------
    if (!requireTotp && fs.existsSync(profileFile)) {
      setStatus('running', { stage: '校验旧会话' });
      log('发现已存的会话文件，校验有效性');
      let ctx;
      try {
        ctx = await this._createContext(browser, { storageState: profileFile }, task);
        const p = await ctx.newPage();
        setStatus('running', { stage: '抓 session' });
        await p.goto(SESSION_URL, { waitUntil: 'domcontentloaded' });
        const raw = await p.locator('body').innerText();
        const info = saveSession(raw);
        task.session = { email, context: ctx, page: p };
        log(`✓ 复用旧会话成功（accessToken ${info.accessToken.length} 字符）`);
        return;
      } catch (e) {
        signal.throwIfAborted();
        if (e.code) throw e;
        log(`旧会话校验未通过（${e.message}），尝试完整登录`);
      } finally {
        if (ctx) {
          await this._releaseContext(ctx, task);
        }
      }
    }

    // ---------- 分支 2：完整登录 ----------
    if (!acc.mailUrl && !this.config.mail.url) throw new Error('已保存的会话失效，请填写当前密码或取件地址后登录');
    setStatus('running', { stage: '打开登录页' });
    log('打开新浏览器上下文（stealth + en-US）');
    const context = await this._createContext(browser, {}, task);

    try {
      const page = await context.newPage();
      // 步骤 1：进首页 → 点 Log in → 等 modal 邮箱框
      // chatgpt.com 风控/网络问题会 timeout，重试 N 次（可配）
      const OPEN_RETRY = this.config.batch.openRetry || 3;
      const OPEN_TIMEOUT = this.config.batch.openTimeoutMs || 45000;
      let opened = false;
      for (let attempt = 1; attempt <= OPEN_RETRY && !opened; attempt++) {
        try {
          await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: OPEN_TIMEOUT });
          opened = true;
          log(`已打开 chatgpt.com（title: ${await page.title()}）`);
        } catch (e) {
          log(`第 ${attempt}/${OPEN_RETRY} 次打开 chatgpt.com 失败（${e.message.split('\n')[0]}）`);
          if (attempt === OPEN_RETRY) throw e;
          await page.waitForTimeout(5000);
        }
      }

      // Cloudflare challenge 出现就等 + reload
      const cfCheck = await page.locator('#challenge-form').or(page.getByText(/Just a moment|请稍候|Verifying/i))
        .first().count().then(n => n > 0).catch(() => false);
      if (cfCheck) {
        log('检测到 Cloudflare challenge，等 15s…');
        await page.waitForTimeout(15000);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }

      const loginBtnSel = [
        'button[data-testid="login-button"]:visible',
        'button:visible:has-text("Log in")',
        'a:visible:has-text("Log in")',
        'button:visible:has-text("登录")',
      ].join(', ');
      const loginBtn = page.locator(loginBtnSel).first();
      await loginBtn.waitFor({ state: 'visible', timeout: 30000 });
      log('找到 Log in 按钮，点击');
      await loginBtn.click();
      log('点了 Log in，等登录 modal 渲染…');
      await page.waitForTimeout(2000);

      // 步骤 2：填邮箱（用 type 而不是 fill，更像人类）
      setStatus('running', { stage: '填邮箱' });
      const emailSel = [
        'input[name="email"]:visible',
        'input[type="email"]:visible',
        'input[autocomplete="username"]:visible',
        'input[name="login_hint"]:visible',
      ].join(', ');
      const emailInput = page.locator(emailSel).first();
      await emailInput.waitFor({ state: 'visible', timeout: 45000 });

      log('邮箱框已出现，等 5s 让可能的 challenge 完成');
      await page.waitForTimeout(5000);

      await emailInput.click();
      await page.waitForTimeout(300);
      await page.keyboard.type(email, { delay: 30 });
      await page.waitForTimeout(500);

      setStatus('running', { stage: '检查收件箱' });
      const mailOptions = { ...this.config.mail, url: acc.mailUrl || this.config.mail.url, signal };
      const seenMailIds = await snapshotMailIds(context, mailOptions);
      log(`提交邮箱前已记录 ${seenMailIds.size} 封历史邮件`);
      let mailRequestedAt = Date.now();
      await page.keyboard.press('Enter');
      log(`已填写并提交登录邮箱：${email}`);
      await page.waitForTimeout(2000);
      log(`提交后 url: ${page.url()}`);

      // 步骤 3：等验证码框（或密码框 → 切到验证码路径）
      setStatus('running', { stage: '等待输入框' });
      const pwdSel = 'input[type="password"]:visible, input[name="password"]:visible, input[autocomplete="current-password"]:visible';
      const otpSel = [
        'input[name="code"]:visible',
        'input[inputmode="numeric"]:visible',
        'input[autocomplete="one-time-code"]:visible',
        'input[aria-label*="code" i]:visible',
        'input[placeholder*="code" i]:visible',
        'input[maxlength="6"]:visible',
      ].join(', ');

      const winner = await Promise.race([
        page.locator(pwdSel).first().waitFor({ state: 'visible', timeout: 45000 })
            .then(() => 'password').catch(() => null),
        page.locator(otpSel).first().waitFor({ state: 'visible', timeout: 45000 })
            .then(() => 'code').catch(() => null),
      ]);

      if (winner === 'code') {
        log('直接出现验证码框');
      } else if (winner === 'password') {
        log('检测到密码框，找「其他登录方式」切到验证码');
        const switchSel = [
          'a:visible:has-text("email code")',
          'a:visible:has-text("try another way")',
          'a:visible:has-text("different method")',
          'a:visible:has-text("use code")',
          'button:visible:has-text("email")',
          'button:visible:has-text("one-time code")',
          'button:visible:has-text("another")',
        ].join(', ');
        const switchBtn = page.locator(switchSel).first();
        const has = await switchBtn.count().then(n => n > 0).catch(() => false);
        if (!has) throw new Error('密码页找不到「切换邮箱码」入口');
        const beforeSwitch = await snapshotMailIds(context, mailOptions);
        beforeSwitch.forEach(id => seenMailIds.add(id));
        mailRequestedAt = Date.now();
        await switchBtn.click({ timeout: 10000 });
        log('已点击切换链接，等验证码框');
        await page.locator(otpSel).first().waitFor({ state: 'visible', timeout: 30000 });
        log('已切到邮箱验证码路径');
      } else {
        throw new Error('45s 内既没看到密码框也没看到验证码框');
      }

      // 步骤 4：取件 → 提交 → 失败重试（最多 3 次）
      let loggedIn = false;
      let submittedTotp = false;
      for (let attempt = 1; attempt <= 3 && !loggedIn; attempt++) {
        if (await completeTotpChallenge({ page, otp: page.locator(otpSel).first(), totpSecret, signal, log })) {
          submittedTotp = true;
          loggedIn = true;
          break;
        }
        setStatus('running', { stage: `去取件（第 ${attempt} 次）` });
        const code = await fetchCode(context, {
          ...mailOptions,
          toEmail: email,
          seenIds: seenMailIds,
          freshAfterMs: mailRequestedAt,
          snapshotBaseline: false, // 基线已在提交前建立，刚送达的验证码不能被当成历史。
          log,
        });

        setStatus('running', { stage: `提交验证码（第 ${attempt} 次）` });
        const otpNow = page.locator(otpSel).first();
        await otpNow.click().catch(() => {});
        await page.keyboard.press('MetaOrControl+A').catch(() => {});
        await page.keyboard.press('Delete').catch(() => {});
        await page.keyboard.type(code, { delay: 30 });
        await page.waitForTimeout(500);
        await page.keyboard.press('Enter').catch(() => {});
        log('验证码已提交，等跳转…');

        try {
          // 邮箱码通过后可能进入首页、注册页或验证器挑战。
          // 验证器也使用 OTP 输入框，需同时识别跳转，最终以匹配邮箱的会话确认成功。
          const otpLeft = page.locator(otpSel).first();
          const gone = await Promise.any([
            otpLeft.waitFor({ state: 'hidden', timeout: 12000 }),
            page.waitForURL(u => u.pathname.includes('about-you') || /\/mfa\/(?:challenge|verify)/.test(u.pathname), { timeout: 12000 }),
          ]).then(() => true).catch(() => false);

          if (gone) {
            loggedIn = true;
            const cur = page.url();
            if (cur.includes('about-you')) {
              log('✓ 验证码对了，进入 about-you 新账号注册流程');
            } else {
              log(`✓ 验证码对了（当前 url: ${cur}）`);
            }
          } else {
            throw new Error('OTP 输入框仍在，视为未跳转');
          }
        } catch {
          const errText = await page.locator('text=/incorrect|invalid|expired|错误|失效|已过期/i')
            .first().isVisible({ timeout: 2000 }).catch(() => false);
          log(`第 ${attempt} 次没通过${errText ? '（页面报错验证码错误/过期）' : ''}${attempt < 3 ? '，找「重新发送」' : ''}`);

          if (attempt < 3) {
            const beforeResend = await snapshotMailIds(context, mailOptions);
            beforeResend.forEach(id => seenMailIds.add(id));
            // 多找几种「重发」/「重新发送」文案
            const resendSel = [
              'button:visible:has-text("Resend")',
              'a:visible:has-text("Resend")',
              'button:visible:has-text("重新发送")',
              'button:visible:has-text("send again")',
              'button:visible:has-text("Send new code")',
              'a:visible:has-text("Send new code")',
              'button:visible:has-text("new code")',
              'a:visible:has-text("new code")',
              '[role="button"]:visible:has-text("Resend")',
              '[role="button"]:visible:has-text("new code")',
            ].join(', ');
            const resendBtn = page.locator(resendSel).or(page.getByText(/resend|重新发送|new code/i)).first();
            const has = await resendBtn.count().then(n => n > 0).catch(() => false);
            if (has) {
              mailRequestedAt = Date.now();
              await resendBtn.click({ timeout: 5000 });
              log('点了「重新发送」，等 OpenAI 发新码');
            } else {
              log('没找到重发按钮，退回去用「修改邮箱」重来');
              // try back / change email 链接
              const backSel = 'a:visible:has-text("Back"), button:visible:has-text("Back"), a:visible:has-text("Go back"), a:visible:has-text("try a different email"), a:visible:has-text("Edit")';
              const backBtn = page.locator(backSel).first();
              const hasBack = await backBtn.count().then(n => n > 0).catch(() => false);
              if (hasBack) {
                await backBtn.click({ timeout: 5000 }).catch(() => {});
                log('点了「返回 / 修改邮箱」，重新走邮箱→OTP 流程');
                // 重新 OTP 阶段又得回到邮箱提交那一步。让 worker 跳到 catch-all，让外层重跑
                throw new Error('OTP 失败且无 Resend 入口，需要从头重跑');
              }
              await page.waitForTimeout(5000);
            }
          }
        }
      }

      if (!loggedIn) throw new Error('3 次尝试后验证码仍无法登录');

      // 步骤 4.5：检测是否是「新注册流程」
      // OpenAI 对新邮箱在 OTP 验证后会让你补「姓名 + 生日」，旧账号则直接落到 chatgpt.com
      setStatus('running', { stage: '检查注册流程' });
      await page.waitForTimeout(2000);   // 给跳转落地一些时间
      submittedTotp = await completeTotpChallenge({ page, otp: page.locator(otpSel).first(), totpSecret, signal, log, alreadySubmitted: submittedTotp }) || submittedTotp;
      await this._fillSignupIfNeeded(page, email, log);

      // 步骤 5：抓 session
      setStatus('running', { stage: '抓 session' });
      await page.waitForTimeout(3000);
      await page.goto(SESSION_URL, { waitUntil: 'domcontentloaded' });
      const raw = await page.locator('body').innerText();
      const session = JSON.parse(raw);
      if (!session.accessToken || session.user?.email?.toLowerCase() !== email.toLowerCase()) throw new Error('登录后未取得该账号的有效会话');
      if (requireTotp && !submittedTotp) throw new Error('本次登录未出现验证器挑战，不能确认 2FA 已启用');
      const state = await context.storageState();
      signal.throwIfAborted();
      this.store.saveProfile(email, state);
      const info = saveSession(raw);
      if (submittedTotp) {
        this._recordTotpVerification(email, totpSecret);
      }
      task.session = { email, context, page };
      log(`✓ 完成（accessToken ${info.accessToken.length} 字符，过期 ${info.expires}）`);

    } finally {
      await this._releaseContext(context, task);
    }
  }

  /**
   * 新账号注册时 OpenAI 会跳到 auth.openai.com/about-you，让填「Full name + Age」。
   * 字段是最简版（两个 input），不是生日三段 select。
   */
  async _fillSignupIfNeeded(page, email, log) {
    await page.waitForTimeout(1500);

    const url = page.url();
    const isAboutYou = url.includes('about-you');

    // 用具体属性定位（不要被可见 input 顺序干扰）
    // 当前 OpenAI 表单：input[name="age"] 是 age，另一个 input 通常是 name 字段
    const nameInputLoc = page.locator('input[name="name"]:visible, input[autocomplete="name"]:visible, input[placeholder*="name" i]:visible').first();
    const ageInputLoc = page.locator('input[name="age"]:visible, input[placeholder*="Age" i]:visible, input[type="number"]:visible').first();

    const hasName = await nameInputLoc.count().then(n => n > 0).catch(() => false);
    const hasAge = await ageInputLoc.count().then(n => n > 0).catch(() => false);
    log(`字段定位：name=${hasName}, age=${hasAge}`);
    if (!isAboutYou && !(hasName && hasAge)) return;
    if (!hasName || !hasAge) throw new Error('注册信息页缺少姓名或年龄输入框');

    // 随机数据
    const FIRST = ['Alex', 'Jordan', 'Taylor', 'Casey', 'Morgan', 'Riley', 'Avery',
                   'Quinn', 'Skyler', 'Cameron', 'Blake', 'Drew', 'Jamie', 'Charlie'];
    const LAST = ['Smith', 'Brown', 'Johnson', 'Lee', 'Davis', 'Wilson', 'Moore',
                  'Clark', 'Hall', 'Young', 'Wright', 'King', 'Green', 'Baker'];
    const name = `${FIRST[Math.floor(Math.random() * FIRST.length)]} ${LAST[Math.floor(Math.random() * LAST.length)]}`;
    const age = 25 + Math.floor(Math.random() * 11);  // 25-35

    log(`随机：${name} · ${age} 岁`);

    // 表单上一堆 label/scaffold 挡 click，但 React 受控 input 需要逐字符 type
    // 最稳的两板斧：
    //   ① JS 直接 focus + dispatch React 认识的 input 事件
    //   ② 通过 keyboard.type 模拟人类输入（必要时兜底）
    async function fillReact(loc, value) {
      const handle = await loc.elementHandle();
      if (!handle) return false;
      // React 16+ 受控 input 赋值要同时改 value 并 dispatch input 事件
      await handle.evaluate((el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.focus();
      }, value);
      return true;
    }

    if (hasName) {
      await fillReact(nameInputLoc, name);
      log(`姓名已填：${name}`);
    }
    if (hasAge) {
      await fillReact(ageInputLoc, String(age));
      log(`年龄已填：${age}`);
    }
    await page.waitForTimeout(500);
    // 校验值真的写进去了
    const nameVal = await nameInputLoc.inputValue().catch(() => '');
    const ageVal = await ageInputLoc.inputValue().catch(() => '');
    log(`校验：name="${nameVal}" age="${ageVal}"`);

    await page.waitForTimeout(500);

    // 点 Continue 按钮（黑色大 pill）
    const submitSel = [
      'button[type="submit"]:visible',
      'button:visible:has-text("Continue")',
      'button:visible:has-text("继续")',
      'button:visible:has-text("Next")',
    ].join(', ');
    const submitBtn = page.locator(submitSel).first();
    const hasSubmit = await submitBtn.count().then(n => n > 0).catch(() => false);
    if (hasSubmit) {
      await submitBtn.click({ timeout: 10000 });
      log('点了 Continue，等跳回 chatgpt.com…');
      await page.waitForURL(u => u.hostname === 'chatgpt.com' && !u.pathname.includes('/auth/'),
                            { timeout: 45000 });
      log('✓ 注册完成，已进入 chatgpt.com');
    } else {
      throw new Error('注册信息页找不到继续按钮');
    }

    await page.waitForTimeout(2000);
  }

  getState() {
    return { queue: [...this.queue], inFlight: [...this.inFlight], running: this.running };
  }
}

module.exports = LoginWorker;
