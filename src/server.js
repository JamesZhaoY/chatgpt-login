const http = require('http');
const fs = require('fs');
const path = require('path');
const { generateTotp } = require('./totp');
const { normalizeProxy, proxySummary, testProxy } = require('./proxy');

const MAX_BODY_BYTES = 1024 * 1024;
const STATIC_FILES = {
  '/': ['index.html', 'text/html'],
  '/index.html': ['index.html', 'text/html'],
  '/app.mjs': ['app.mjs', 'text/javascript'],
  '/styles.css': ['styles.css', 'text/css'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
for (const name of ['state', 'ui', 'navigation', 'accounts', 'account-details', 'account-actions', 'filters', 'plans', 'editor', 'settings', 'tasks']) {
  STATIC_FILES[`/js/${name}.mjs`] = [`js/${name}.mjs`, 'text/javascript'];
}
for (const name of ['base', 'shell', 'accounts', 'forms', 'tasks', 'quick-editor']) {
  STATIC_FILES[`/css/${name}.css`] = [`css/${name}.css`, 'text/css'];
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求内容超过 1 MB'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        resolve(data);
      } catch { reject(Object.assign(new Error('请求必须是有效的 JSON 对象'), { status: 400 })); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('请求已断开')));
  });
}

function createServer({ store, worker, config, publicDir }) {
  config.proxy = store.proxy;
  let testingProxy = false;
  const sseClients = new Set();
  const unsubscribe = store.subscribe(evt => {
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of sseClients) {
      if (res.destroyed || res.writableLength > MAX_BODY_BYTES) {
        res.destroy();
        sseClients.delete(res);
      } else res.write(line);
    }
  });

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const json = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const method = allowed => {
      if (allowed.includes(req.method)) return true;
      res.setHeader('Allow', allowed.join(', '));
      json({ error: '此接口不支持该请求方法' }, 405);
      return false;
    };

    try {
      const hostname = new URL(`http://${req.headers.host || ''}`).hostname;
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return json({ error: '仅允许使用本机地址访问服务' }, 403);
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname.startsWith('/api/')) {
        let sameOrigin = true;
        if (req.headers.origin) {
          try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; }
          catch { sameOrigin = false; }
        }
        if (!sameOrigin || req.headers['sec-fetch-site'] === 'cross-site') return json({ error: '仅允许从本地面板访问接口' }, 403);
      }

      if (STATIC_FILES[u.pathname]) {
        if (!method(['GET', 'HEAD'])) return;
        const [file, mime] = STATIC_FILES[u.pathname];
        const content = fs.readFileSync(path.join(publicDir, file));
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }

      if (u.pathname === '/api/events') {
        if (!method(['GET'])) return;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`data: ${JSON.stringify({ type: 'snapshot', accounts: store.listAccounts(), worker: worker.getState(), headless: config.batch.headless, proxy: proxySummary(store.proxy) })}\n\n`);
        sseClients.add(res);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        res.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
        return;
      }

      if (u.pathname === '/api/accounts') {
        if (!method(['GET'])) return;
        return json(store.listAccounts());
      }

      if (u.pathname === '/api/accounts/export') {
        if (!method(['POST'])) return;
        const { emails } = await readBody(req);
        return json(store.exportAccounts(emails));
      }

      if (u.pathname === '/api/accounts/action') {
        if (!method(['POST'])) return;
        const { email: input, action, confirmed } = await readBody(req);
        const email = typeof input === 'string' ? input.trim().toLowerCase() : '';
        if (!['delete', 'disable', 'restore'].includes(action)) return json({ error: '未知账号操作' }, 400);
        if (confirmed !== true) return json({ error: '请先确认账号和操作' }, 400);
        if (!store.accounts.has(email)) return json({ error: '账号不存在，请刷新列表' }, 404);
        if (worker.inFlight?.has(email) || worker.queue?.includes(email)) return json({ error: '该账号正在执行或等待任务，请完成后再操作' }, 409);
        if (action === 'delete') store.removeAccount(email);
        else store.setAccountUnavailable(email, action === 'disable');
        return json({ ok: true, accounts: store.listAccounts() });
      }

      if (u.pathname === '/api/plans/refresh') {
        if (!method(['POST'])) return;
        const body = await readBody(req);
        const emails = body.emails === undefined ? [...store.accounts.keys()] : body.emails;
        if (!Array.isArray(emails) || !emails.length || emails.some(email => typeof email !== 'string')) return json({ error: '请选择至少一个账号' }, 400);
        const normalized = [...new Set(emails.map(email => email.trim().toLowerCase()))];
        if (normalized.some(email => !store.accounts.has(email))) return json({ error: '存在未导入的账号' }, 400);
        const queued = worker.enqueue(normalized, 'plan');
        return json({ queued: queued.length, emails: queued }, 202);
      }

      if (u.pathname === '/api/accounts/setup') {
        if (!method(['POST'])) return;
        const { emails, mode = 'all' } = await readBody(req);
        if (!['all', 'password', 'twofa'].includes(mode)) return json({ error: '未知初始化方式' }, 400);
        if (!Array.isArray(emails) || !emails.length || emails.some(email => typeof email !== 'string')) return json({ error: '请选择至少一个账号' }, 400);
        const normalized = [...new Set(emails.map(email => email.trim().toLowerCase()))];
        if (normalized.some(email => !store.accounts.has(email))) return json({ error: '存在未导入的账号' }, 400);
        const queued = worker.enqueue(normalized, mode === 'all' ? 'setup' : `setup-${mode}`);
        return json({ queued: queued.length, emails: queued, skipped: normalized.length - queued.length }, 202);
      }

      if (u.pathname === '/api/password/init' || u.pathname === '/api/password/change') {
        if (!method(['POST'])) return;
        const body = await readBody(req);
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!store.accounts.has(email)) return json({ error: '请选择已导入的账号' }, 400);
        if (store.passwordSummary(email).uncertain) return json({ error: '上次提交结果未确认，已保留待确认密码；请先确认账号状态' }, 409);
        const queued = worker.enqueue([email], 'password');
        return json({ queued: queued.length, emails: queued }, 202);
      }

      if (['/api/twofa/init', '/api/twofa/verify', '/api/twofa/replace'].includes(u.pathname)) {
        if (!method(['POST'])) return;
        const body = await readBody(req);
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!store.accounts.has(email)) return json({ error: '请选择已导入的账号' }, 400);
        if (!store.getPassword(email) && !store.getPassword(email, true) && !store.getAccount(email).mailUrl && !config.mail?.url) return json({ error: '请先填写当前密码或取件地址，再设置或验证 2FA' }, 400);
        const isVerify = u.pathname.endsWith('/verify');
        const isReplace = u.pathname.endsWith('/replace');
        const hasSecret = store.getTwofaSecret(email) || store.importedTwofa.has(email);
        if ((isVerify || isReplace) && !hasSecret) return json({ error: '该账号尚未保存 2FA 密钥' }, 400);
        if (!isVerify && !isReplace && hasSecret) return json({ error: '已有 2FA 密钥，请使用「验证 2FA 登录」或「修改 2FA」' }, 409);
        const queued = worker.enqueue([email], isReplace ? 'twofa-replace' : isVerify ? 'twofa-verify' : 'twofa');
        return json({ queued: queued.length, emails: queued }, 202);
      }

      if (u.pathname === '/api/twofa') {
        if (!method(['GET'])) return;
        const email = (u.searchParams.get('email') || '').trim().toLowerCase();
        if (!store.accounts.has(email)) return json({ error: '账号不存在' }, 404);
        const pending = u.searchParams.get('pending') === '1';
        const secret = store.getTwofaSecret(email, pending) || (!pending && store.importedTwofa.get(email));
        if (!secret) return json({ error: '该账号尚未保存 2FA 密钥' }, 404);
        return json({ secret, ...generateTotp(secret) });
      }

      if (u.pathname === '/api/password/verify') {
        if (!method(['POST'])) return;
        const body = await readBody(req);
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!store.accounts.has(email)) return json({ error: '请选择已导入的账号' }, 400);
        if (!store.getPassword(email, true) && !store.getPassword(email)) return json({ error: '没有可用于验证的密码记录' }, 400);
        const queued = worker.enqueue([email], 'password-verify');
        return json({ queued: queued.length, emails: queued }, 202);
      }

      if (u.pathname === '/api/password') {
        if (!method(['GET'])) return;
        const email = (u.searchParams.get('email') || '').trim().toLowerCase();
        if (!store.accounts.has(email)) return json({ error: '账号不存在' }, 404);
        const password = store.getPassword(email, u.searchParams.get('pending') === '1');
        if (!password) return json({ error: '该账号尚无对应的密码记录' }, 404);
        return json({ password });
      }

      if (u.pathname === '/api/login' || u.pathname === '/api/login-batch') {
        if (!method(['POST'])) return;
        const body = await readBody(req);
        const emails = u.pathname === '/api/login' ? [body.email] : body.emails;
        if (!Array.isArray(emails) || !emails.length || emails.some(email => typeof email !== 'string')) return json({ error: '请选择至少一个有效账号' }, 400);
        const normalized = [...new Set(emails.map(email => email.trim().toLowerCase()))];
        if (normalized.some(email => !store.accounts.has(email))) return json({ error: '存在未导入的账号，请先保存账号列表' }, 400);
        const queued = worker.enqueue(normalized);
        return json({ queued: queued.length, emails: queued }, 202);
      }

      if (u.pathname === '/api/queue/clear') {
        if (!method(['POST'])) return;
        return json({ cleared: worker.clearQueue() });
      }

      if (u.pathname === '/api/accounts/parse') {
        if (!method(['POST'])) return;
        const { content } = await readBody(req);
        try { return json({ accounts: store.parseAccounts(content) }); }
        catch (e) { return json({ error: e.message }, 400); }
      }

      if (u.pathname === '/api/accounts-file') {
        if (!method(['GET', 'POST'])) return;
        if (req.method === 'GET') return json({ content: fs.existsSync(store.accountsFile) ? fs.readFileSync(store.accountsFile, 'utf8') : '', accounts: store.parseAccountsFile() });
        const body = await readBody(req);
        if (Object.hasOwn(body, 'accounts') && Object.hasOwn(body, 'content')) return json({ error: '请只提交账号表单或导入文本中的一种' }, 400);
        if (Object.hasOwn(body, 'expectedContent')) {
          if (typeof body.expectedContent !== 'string') return json({ error: '账号版本信息格式不正确' }, 400);
          const currentContent = fs.existsSync(store.accountsFile) ? fs.readFileSync(store.accountsFile, 'utf8') : '';
          if (currentContent !== body.expectedContent) return json({ error: '账号资料已在其他页面更新，请重新打开编辑后再保存' }, 409);
        }
        if (worker.running || worker.queue.length || worker.inFlight.size) return json({ error: '登录队列正在运行，请等待当前任务完成后再保存账号列表' }, 409);
        let count;
        try { count = Object.hasOwn(body, 'accounts') ? store.writeAccountRows(body.accounts) : store.writeAccountsFile(body.content); }
        catch (e) {
          if (e.code) throw e;
          return json({ error: e.message }, 400);
        }
        return json({ ok: true, count });
      }

      if (u.pathname === '/api/worker') {
        if (!method(['GET'])) return;
        return json(worker.getState());
      }

      if (u.pathname === '/api/thread-pool') {
        if (!method(['POST'])) return;
        const { threadPoolSize } = await readBody(req);
        if (!Number.isInteger(threadPoolSize) || threadPoolSize < 1 || threadPoolSize > 10) return json({ error: '线程池数量必须是 1–10 的整数' }, 400);
        if (worker.running || worker.queue.length || worker.inFlight.size) return json({ error: '请等待当前任务队列完成后修改线程池数量' }, 409);
        const file = path.join(store.dir, 'config.json');
        const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
        const temp = `${file}.${process.pid}.tmp`;
        try {
          fs.writeFileSync(temp, JSON.stringify({ ...saved, batch: { ...saved.batch, threadPoolSize } }, null, 2), { mode: 0o600 });
          fs.renameSync(temp, file);
        } finally { fs.rmSync(temp, { force: true }); }
        config.batch.threadPoolSize = threadPoolSize;
        return json({ ok: true, threadPoolSize });
      }

      if (u.pathname === '/api/config') {
        if (!method(['GET'])) return;
        return json({ ...config, proxy: proxySummary(store.proxy) });
      }

      if (u.pathname === '/api/proxy') {
        if (!method(['GET', 'POST'])) return;
        if (req.method === 'GET') return json(proxySummary(store.proxy));
        const body = await readBody(req);
        try { config.proxy = store.saveProxy(body); }
        catch (error) {
          if (error.code) throw error;
          return json({ error: error.message }, 400);
        }
        return json({ ok: true, proxy: proxySummary(store.proxy), nextTask: worker.inFlight.size > 0 });
      }

      if (u.pathname === '/api/proxy/test') {
        if (!method(['POST'])) return;
        const body = await readBody(req);
        let proxy;
        try { proxy = normalizeProxy(body, store.proxy); }
        catch (error) { return json({ error: error.message }, 400); }
        if (!proxy.enabled) return json({ error: '请先勾选启用代理，再检测出口 IP' }, 400);
        if (testingProxy) return json({ error: '已有代理检测正在进行，请稍后重试' }, 409);
        testingProxy = true;
        try { return json(await testProxy(proxy)); }
        catch (error) { return json({ error: error.message }, 502); }
        finally { testingProxy = false; }
      }

      return json({ error: '页面或接口不存在' }, 404);
    } catch (e) {
      if (res.destroyed || res.writableEnded) return;
      if (!e.status) console.error('[server]', e.message);
      return json({ error: e.status ? e.message : '服务处理失败，请查看服务日志后重试' }, e.status || 500);
    }
  });

  // close() 时先断开长连接，否则 SSE 会阻止服务退出。
  server.on('close', unsubscribe);
  server.closeEvents = () => {
    for (const res of sseClients) res.end();
    sseClients.clear();
  };
  return server;
}

module.exports = { createServer };
