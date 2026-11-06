const fs = require('fs');
const path = require('path');
const { normalizeSecret, generateTotp } = require('./totp');
const { DEFAULT_PROXY, normalizeProxy, proxySummary } = require('./proxy');

const LOG_CAP = 300;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_NEWLINES = /\\r\\n|\\[rn]|\r\n?|\n|\u0085|\u2028|\u2029/g;

function writeAtomic(file, content) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function writeAtomicSet(entries) {
  const originals = new Map(entries.map(([file]) => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
  const written = [];
  try {
    for (const [file, content] of entries) { writeAtomic(file, content); written.push(file); }
  } catch (error) {
    for (const file of written.reverse()) {
      const original = originals.get(file);
      if (original === null) fs.rmSync(file, { force: true }); else writeAtomic(file, original);
    }
    throw error;
  }
}

class Store {
  constructor({ dir, accountsFile, infoFile, defaultMailUrl = '' }) {
    Object.assign(this, { dir, accountsFile, infoFile, defaultMailUrl });
    this.accounts = new Map();
    this.infoStore = new Map();
    this.passwordsFile = path.join(dir, 'passwords.json');
    this.passwords = new Map();
    this.twofaFile = path.join(dir, 'twofa.json');
    this.twofa = new Map();
    this.importedTwofa = new Map();
    this.plansFile = path.join(dir, 'plans.json');
    this.plans = new Map();
    this.accountFlagsFile = path.join(dir, 'account-flags.json');
    this.accountFlags = new Map();
    this.listeners = new Set();
    this.proxyFile = path.join(dir, 'proxy.json');
    this.proxy = { ...DEFAULT_PROXY };
    if (fs.existsSync(this.proxyFile)) {
      try { this.proxy = normalizeProxy(JSON.parse(fs.readFileSync(this.proxyFile, 'utf8'))); }
      catch { throw new Error('proxy.json 格式不正确，请检查代理配置后重启'); }
    }
    this._loadInfo();
    if (fs.existsSync(this.passwordsFile)) {
      const data = JSON.parse(fs.readFileSync(this.passwordsFile, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('passwords.json 格式不正确');
      this.passwords = new Map(Object.entries(data));
    }
    if (fs.existsSync(this.twofaFile)) {
      const data = JSON.parse(fs.readFileSync(this.twofaFile, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('twofa.json 格式不正确');
      this.twofa = new Map(Object.entries(data));
    }
    if (fs.existsSync(this.plansFile)) {
      const data = JSON.parse(fs.readFileSync(this.plansFile, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('plans.json 格式不正确');
      this.plans = new Map(Object.entries(data));
    }
    if (fs.existsSync(this.accountFlagsFile)) {
      const data = JSON.parse(fs.readFileSync(this.accountFlagsFile, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.values(data).some(value => !value || typeof value.unavailable !== 'boolean')) throw new Error('account-flags.json 格式不正确');
      this.accountFlags = new Map(Object.entries(data));
    }
    this._loadAccounts();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  saveProxy(input) {
    const proxy = normalizeProxy(input, this.proxy);
    writeAtomic(this.proxyFile, JSON.stringify(proxy, null, 2));
    this.proxy = proxy;
    this.broadcast({ type: 'proxy', proxy: proxySummary(proxy) });
    return proxy;
  }

  broadcast(evt) {
    for (const fn of this.listeners) {
      try { fn(evt); } catch (e) { console.error('[store] 事件发送失败:', e.message); }
    }
  }

  _loadInfo() {
    if (!fs.existsSync(this.infoFile)) return;
    // 损坏的文件必须保留并报错，不能当成空库后覆盖。
    const data = JSON.parse(fs.readFileSync(this.infoFile, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('info.json 格式不正确，请检查文件后重启');
    }
    for (const [email, info] of Object.entries(data)) this.infoStore.set(email.toLowerCase(), info);
  }

  persistInfo() {
    writeAtomic(this.infoFile, JSON.stringify(Object.fromEntries(this.infoStore), null, 2));
  }

  parseAccounts(content) {
    if (typeof content !== 'string') throw new Error('账号列表必须是文本');
    const accounts = new Map();
    for (const [i, rawLine] of content.split(ACCOUNT_NEWLINES).entries()) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const fields = line.split('----').map(value => value.trim());
      if (fields.length > 3) throw new Error(`第 ${i + 1} 行：请使用 邮箱----取件地址----2FA密钥 格式`);
      const email = fields[0].toLowerCase();
      const mailUrl = fields[1] || this.defaultMailUrl;
      if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new Error(`第 ${i + 1} 行：邮箱格式不正确`);
      if (mailUrl) {
        let valid = false;
        try { valid = !/[\s\\]/.test(mailUrl) && ['http:', 'https:'].includes(new URL(mailUrl).protocol); } catch {}
        if (!valid) throw new Error(`第 ${i + 1} 行：取件地址必须是完整的 http / https URL`);
      }
      let totpSecret = accounts.get(email)?.totpSecret;
      if (fields[2]) {
        let secret;
        try {
          secret = normalizeSecret(fields[2]);
          generateTotp(secret, { now: 0 });
        } catch { throw new Error(`第 ${i + 1} 行：第三段必须是有效的 Base32 2FA 密钥，不能填写 6 位验证码`); }
        if ((totpSecret && totpSecret !== secret) || (this.getTwofaSecret(email) && this.getTwofaSecret(email) !== secret)) {
          throw new Error(`第 ${i + 1} 行：该邮箱已有不同的 2FA 密钥，请核实后再导入`);
        }
        totpSecret = secret;
      }
      accounts.set(email, { email, mailUrl, ...(totpSecret ? { totpSecret } : {}) });
    }
    return [...accounts.values()];
  }

  parseAccountsFile() {
    return this.parseAccounts(fs.existsSync(this.accountsFile) ? fs.readFileSync(this.accountsFile, 'utf8') : '');
  }

  serializeAccounts(rows) {
    if (!Array.isArray(rows)) throw new Error('账号表单必须是列表');
    const emails = new Set();
    return rows.map((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`第 ${index + 1} 行：账号格式不正确`);
      const fields = ['email', 'mailUrl', 'totpSecret'].map(key => {
        const value = row[key] ?? '';
        if (typeof value !== 'string' || /----|[\r\n\u0085\u2028\u2029]|\\[rn]/.test(value)) {
          throw new Error(`第 ${index + 1} 行：每个字段只能填写一项，不能包含换行或分隔符`);
        }
        return value.trim();
      });
      const email = fields[0].toLowerCase();
      if (!email || !EMAIL_PATTERN.test(email)) throw new Error(`第 ${index + 1} 行：邮箱格式不正确`);
      if (emails.has(email)) throw new Error(`第 ${index + 1} 行：邮箱重复，请合并后保存`);
      emails.add(email);
      return (fields[2] ? fields : fields.slice(0, 2)).join('----');
    }).join('\n');
  }

  writeAccountsFile(content) {
    const parsed = this.parseAccounts(content);
    writeAtomic(this.accountsFile, content.replace(ACCOUNT_NEWLINES, '\n'));
    this._loadAccounts(parsed);
    this.broadcast({ type: 'accounts', accounts: this.listAccounts() });
    return parsed.length;
  }

  writeAccountRows(rows) {
    if (!Array.isArray(rows)) throw new Error('账号表单必须是列表');
    const content = this.serializeAccounts(rows.map(row => row && ({ email: row.email, mailUrl: row.mailUrl })));
    const parsed = this.parseAccounts(content);
    const passwords = new Map(this.passwords);
    const twofa = new Map(this.twofa);
    let passwordChanged = false;
    let twofaChanged = false;
    const now = new Date().toISOString();
    rows.forEach((row, index) => {
      const email = row.email.trim().toLowerCase();
      const password = row.password ?? '';
      if (typeof password !== 'string' || password.length > 1024 || /[\r\n\u0085\u2028\u2029]/.test(password) || (password && !password.trim())) {
        throw new Error(`第 ${index + 1} 行：密码必须是非空白的单行文本`);
      }
      if (password && password !== passwords.get(email)?.password) {
        if (this.passwordSummary(email).uncertain) throw new Error(`第 ${index + 1} 行：密码提交结果待确认，请先验证候选密码`);
        const previous = passwords.get(email);
        passwords.set(email, { ...previous, previousPassword: previous?.password || null, password,
          updatedAt: now, importedAt: now, verifiedAt: null, error: null, pendingPassword: null, pendingAt: null, submittedAt: null });
        passwordChanged = true;
      }
      if (row.totpSecret != null && typeof row.totpSecret !== 'string') throw new Error(`第 ${index + 1} 行：2FA 密钥必须是 Base32 文本`);
      const suppliedSecret = row.totpSecret?.trim() || this.importedTwofa.get(email);
      if (suppliedSecret) {
        let secret;
        try {
          if (/[\r\n\u0085\u2028\u2029]|\\[rn]|----/.test(suppliedSecret)) throw new Error();
          secret = normalizeSecret(suppliedSecret); generateTotp(secret, { now: 0 });
        }
        catch { throw new Error(`第 ${index + 1} 行：2FA 密钥不是有效的 Base32 格式`); }
        const previous = twofa.get(email);
        if (secret !== previous?.secret) {
          if (previous?.rotationStartedAt || previous?.pendingSecret) throw new Error(`第 ${index + 1} 行：2FA 更换尚未确认，请先验证待确认密钥`);
          twofa.set(email, { ...previous, previousSecret: previous?.secret || null, secret,
            importedAt: now, preparedAt: null, submittedAt: null, enabledAt: null, verifiedAt: null, error: null });
          twofaChanged = true;
        }
      }
    });
    const files = [];
    if (passwordChanged) files.push([this.passwordsFile, JSON.stringify(Object.fromEntries(passwords), null, 2)]);
    if (twofaChanged) files.push([this.twofaFile, JSON.stringify(Object.fromEntries(twofa), null, 2)]);
    files.push([this.accountsFile, content]);
    writeAtomicSet(files);
    this.passwords = passwords;
    this.twofa = twofa;
    this._loadAccounts(parsed);
    this.broadcast({ type: 'accounts', accounts: this.listAccounts() });
    return parsed.length;
  }

  _loadAccounts(parsed = this.parseAccountsFile()) {
    const next = new Map();
    const imported = new Map();
    for (const { email, mailUrl, totpSecret } of parsed) {
      const account = this.getAccount(email);
      account.mailUrl = mailUrl;
      next.set(email, account);
      if (totpSecret) imported.set(email, totpSecret);
    }
    this.accounts = next;
    this.importedTwofa = imported;
  }

  getAccount(email) {
    if (!this.accounts.has(email)) {
      const info = this.infoStore.get(email) || null;
      this.accounts.set(email, {
        email, mailUrl: this.defaultMailUrl, status: this.infoStatus(info),
        stage: '', error: null, info, logs: [], operation: null, unavailable: Boolean(this.accountFlags.get(email)?.unavailable),
      });
    }
    return this.accounts.get(email);
  }

  setAccountUnavailable(email, unavailable) {
    const account = this.accounts.get(email);
    if (!account) throw Object.assign(new Error('账号不存在，请刷新列表'), { status: 404 });
    if (typeof unavailable !== 'boolean') throw Object.assign(new Error('账号可用状态格式不正确'), { status: 400 });
    if (['running', 'pending'].includes(account.status)) throw Object.assign(new Error('该账号正在执行或等待任务，请完成后再操作'), { status: 409 });
    const flags = new Map(this.accountFlags);
    if (unavailable) flags.set(email, { unavailable: true, updatedAt: new Date().toISOString() });
    else flags.delete(email);
    writeAtomic(this.accountFlagsFile, JSON.stringify(Object.fromEntries(flags), null, 2));
    this.accountFlags = flags;
    account.unavailable = unavailable;
    this.broadcast({ type: 'accounts', accounts: this.listAccounts() });
  }

  removeAccount(email) {
    const account = this.accounts.get(email);
    if (!account) throw Object.assign(new Error('账号不存在，请刷新列表'), { status: 404 });
    if (['running', 'pending'].includes(account.status)) throw Object.assign(new Error('该账号正在执行或等待任务，请完成后再操作'), { status: 409 });
    const rows = this.parseAccountsFile().filter(row => row.email !== email);
    const files = [[this.accountsFile, this.serializeAccounts(rows)]];
    // 三段导入的密钥还可能只在账号文本中；移除列表项前一并保存以便重新导入恢复。
    const twofa = new Map(this.twofa);
    if (this.importedTwofa.has(email) && !this.getTwofaSecret(email)) {
      twofa.set(email, { ...twofa.get(email), secret: this.importedTwofa.get(email), importedAt: new Date().toISOString() });
      files.push([this.twofaFile, JSON.stringify(Object.fromEntries(twofa), null, 2)]);
    }
    writeAtomicSet(files);
    this.twofa = twofa;
    this._loadAccounts(rows);
    this.broadcast({ type: 'accounts', accounts: this.listAccounts() });
  }

  infoStatus(info) {
    if (!info?.accessToken) return 'idle';
    const expires = this.infoExpires(info);
    return !expires || Date.parse(expires) > Date.now() ? 'ok' : 'expired';
  }

  infoExpires(info) {
    let expires = info?.expires || '';
    try {
      const payload = JSON.parse(Buffer.from(info.accessToken.split('.')[1], 'base64url').toString('utf8'));
      if (Number.isFinite(payload.exp)) {
        const tokenExpires = new Date(payload.exp * 1000).toISOString();
        if (!expires || Date.parse(tokenExpires) < Date.parse(expires)) expires = tokenExpires;
      }
    } catch {}
    return expires;
  }

  clearLogs(email) {
    const acc = this.accounts.get(email);
    if (!acc) return;
    acc.logs = [];
    this.broadcast({ email, logs: [] });
  }

  log(email, msg) {
    const acc = this.accounts.get(email);
    if (!acc) return;
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const line = `[${ts}] ${msg}`;
    acc.logs.push(line);
    if (acc.logs.length > LOG_CAP) acc.logs.splice(0, acc.logs.length - LOG_CAP);
    this.broadcast({ email, log: line });
  }

  setStatus(email, status, extra = {}) {
    const acc = this.accounts.get(email);
    if (!acc) return;
    Object.assign(acc, extra, { status });
    const event = { email, status, stage: acc.stage, error: acc.error, operation: acc.operation };
    if (Object.hasOwn(extra, 'info')) {
      event.info = acc.info;
      event.tokenExpires = this.infoExpires(acc.info);
    }
    this.broadcast(event);
  }

  saveInfo(email, info) {
    const previous = this.infoStore.get(email);
    this.infoStore.set(email, info);
    try { this.persistInfo(); }
    catch (e) {
      if (previous === undefined) this.infoStore.delete(email);
      else this.infoStore.set(email, previous);
      throw e;
    }
  }

  passwordSummary(email) {
    const record = this.passwords.get(email);
    return {
      saved: Boolean(record?.password), updatedAt: record?.updatedAt || null, verifiedAt: record?.verifiedAt || null,
      uncertain: Boolean(record?.pendingPassword && record?.submittedAt),
      error: record?.error || null,
    };
  }

  recordPassword(email, patch) {
    const previous = this.passwords.get(email);
    const record = { ...previous, ...patch };
    this.passwords.set(email, record);
    try { writeAtomic(this.passwordsFile, JSON.stringify(Object.fromEntries(this.passwords), null, 2)); }
    catch (error) {
      if (previous) this.passwords.set(email, previous);
      else this.passwords.delete(email);
      throw error;
    }
    // 密码元数据中不带明文；按用户要求，运行日志会记录本次密码。
    this.broadcast({ email, password: this.passwordSummary(email), loginMethod: this.loginMethod(email) });
    return record;
  }

  preparePassword(email, password) {
    if (this.passwordSummary(email).uncertain) throw new Error('上次密码提交结果未确认，请先复制待确认密码并确认账号状态');
    return this.recordPassword(email, { pendingPassword: password, pendingAt: new Date().toISOString(), submittedAt: null, error: null });
  }

  confirmPassword(email) {
    const record = this.passwords.get(email);
    if (!record?.pendingPassword || !record.submittedAt) throw new Error('没有已提交的候选密码');
    return this.recordPassword(email, {
      password: record.pendingPassword, updatedAt: new Date().toISOString(),
      pendingPassword: null, pendingAt: null, submittedAt: null, error: null,
    });
  }

  failPassword(email, error, rejected = false) {
    const record = this.passwords.get(email);
    const clearPending = rejected || !record?.submittedAt;
    return this.recordPassword(email, {
      error,
      ...(clearPending ? { pendingPassword: null, pendingAt: null, submittedAt: null } : {}),
    });
  }

  getPassword(email, pending = false) {
    const record = this.passwords.get(email);
    return pending ? (record?.submittedAt ? record.pendingPassword : null) : record?.password;
  }

  twofaSummary(email) {
    const record = this.twofa.get(email);
    return {
      hasSecret: Boolean(record?.secret), enabled: Boolean(record?.enabledAt && !record?.rotationStartedAt),
      hasImportedSecret: this.importedTwofa.has(email), importedAt: record?.importedAt || null,
      pending: Boolean(record?.secret && !record?.enabledAt || record?.rotationStartedAt || record?.pendingSecret),
      rotating: Boolean(record?.rotationStartedAt), hasPendingSecret: Boolean(record?.pendingSecret),
      enabledAt: record?.enabledAt || null, verifiedAt: record?.rotationStartedAt ? null : record?.verifiedAt || null,
      error: record?.error || null,
    };
  }

  recordTwofa(email, patch) {
    const previous = this.twofa.get(email);
    if (previous?.secret && patch.secret && previous.secret !== patch.secret) throw new Error('已有 2FA 密钥，不能覆盖；请先核实已启用的验证器');
    const record = { ...previous, ...patch };
    return this._saveTwofaRecord(email, record);
  }

  _saveTwofaRecord(email, record, stripImported = false) {
    const next = new Map(this.twofa).set(email, record);
    const files = [[this.twofaFile, JSON.stringify(Object.fromEntries(next), null, 2)]];
    if (stripImported && this.importedTwofa.has(email)) {
      const rows = this.parseAccountsFile().map(row => row.email === email ? { ...row, totpSecret: '' } : row);
      files.unshift([this.accountsFile, this.serializeAccounts(rows)]);
    }
    writeAtomicSet(files);
    this.twofa = next;
    if (stripImported) this.importedTwofa.delete(email);
    this.broadcast({ email, twofa: this.twofaSummary(email), loginMethod: this.loginMethod(email) });
    return record;
  }

  getTwofaSecret(email, pending = false) {
    const record = this.twofa.get(email);
    return (pending ? record?.pendingSecret : record?.secret) || null;
  }

  beginTwofaRotation(email) {
    const previous = this.twofa.get(email);
    if (!previous?.secret) throw new Error('没有旧 2FA 密钥，请先保存当前密钥');
    if (previous.pendingSecret) throw new Error('已有待确认的新 2FA 密钥，请先验证登录');
    // 先迁移导入列，避免新密钥确认后重启又读到旧密钥。
    return this._saveTwofaRecord(email, { ...previous, rotationStartedAt: previous.rotationStartedAt || new Date().toISOString(), error: null }, true);
  }

  prepareTwofaRotation(email, value) {
    const secret = normalizeSecret(value);
    const previous = this.twofa.get(email);
    if (!previous?.rotationStartedAt) throw new Error('尚未开始更换 2FA');
    if (previous.pendingSecret && previous.pendingSecret !== secret) throw new Error('已有待确认的新 2FA 密钥，不能覆盖');
    if (previous.secret === secret) throw new Error('官网返回的新 2FA 密钥与旧密钥相同，请核实');
    return this.recordTwofa(email, { pendingSecret: secret, pendingPreparedAt: new Date().toISOString(), error: null });
  }

  confirmTwofaRotation(email) {
    const previous = this.twofa.get(email);
    if (!previous?.pendingSecret || !previous.pendingSubmittedAt) throw new Error('没有已提交的待确认 2FA 密钥');
    const now = new Date().toISOString();
    return this._saveTwofaRecord(email, { ...previous, previousSecret: previous.secret,
      secret: previous.pendingSecret, preparedAt: previous.pendingPreparedAt, submittedAt: previous.pendingSubmittedAt,
      enabledAt: now, verifiedAt: now, error: null, pendingSecret: null, pendingPreparedAt: null,
      pendingSubmittedAt: null, pendingEnabledAt: null, rotationStartedAt: null, rotationDisabledAt: null }, true);
  }

  loginMethod(email) {
    const account = this.accounts.get(email);
    const hasTwofa = Boolean(this.getTwofaSecret(email, true) || this.getTwofaSecret(email) || this.importedTwofa.has(email));
    if (this.getPassword(email, true) || this.getPassword(email)) return hasTwofa ? 'password-totp' : 'password';
    if (account?.mailUrl || this.defaultMailUrl) return hasTwofa ? 'email-totp' : 'email';
    return fs.existsSync(this.profilePath(email)) ? 'session' : 'missing';
  }

  saveImportedTwofa(email) {
    const secret = this.importedTwofa.get(email);
    if (!secret || this.getTwofaSecret(email) === secret) return false;
    this.recordTwofa(email, { secret, importedAt: new Date().toISOString(), error: null });
    return true;
  }

  savePlan(email, plan) {
    const previous = this.plans.get(email);
    this.plans.set(email, plan);
    try { writeAtomic(this.plansFile, JSON.stringify(Object.fromEntries(this.plans), null, 2)); }
    catch (error) {
      if (previous) this.plans.set(email, previous); else this.plans.delete(email);
      throw error;
    }
    this.broadcast({ email, plan });
  }

  listAccounts() {
    return [...this.accounts.values()].map(a => ({
      ...a, password: this.passwordSummary(a.email), twofa: this.twofaSummary(a.email), loginMethod: this.loginMethod(a.email), plan: this.plans.get(a.email) || null, tokenExpires: this.infoExpires(a.info),
      status: a.status === 'ok' ? this.infoStatus(a.info) : a.status, logs: a.logs.slice(-LOG_CAP),
    }));
  }

  exportAccounts(emails) {
    if (!Array.isArray(emails) || !emails.length || emails.some(email => typeof email !== 'string')) {
      throw Object.assign(new Error('请选择至少一个要导出的账号'), { status: 400 });
    }
    const selected = [...new Set(emails.map(email => email.trim().toLowerCase()))];
    if (selected.some(email => !this.accounts.has(email))) {
      throw Object.assign(new Error('存在未导入的账号，请刷新列表后重试'), { status: 400 });
    }
    const content = selected.map((email, index) => {
      const fields = [email, this.getPassword(email), this.getTwofaSecret(email) || this.importedTwofa.get(email), this.accounts.get(email).mailUrl];
      return fields.map((value, field) => {
        if (value == null || value === '') return 'x';
        if (typeof value !== 'string' || /----|[\r\n\u0085\u2028\u2029]/.test(value)) {
          throw Object.assign(new Error(`第 ${index + 1} 个账号的${['邮箱', '密码', '2FA 密钥', '取件地址'][field]}含换行或分隔符，无法按四列格式导出`), { status: 409 });
        }
        return value;
      }).join('----');
    }).join('\n') + '\n';
    return { content, count: selected.length };
  }

  profilePath(email) {
    const safe = email.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(this.dir, 'profiles', `${safe}.json`);
  }

  saveProfile(email, state) {
    const file = this.profilePath(email);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, JSON.stringify(state));
  }
}

module.exports = Store;
