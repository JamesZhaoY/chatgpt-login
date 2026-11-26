// Loopback-only fixture. The clock and authenticator are the public RFC 6238
// SHA-1 test vector at 59 seconds (last six digits of 94287082).
const http = require('node:http');
const { randomUUID, scryptSync } = require('node:crypto');

const forms = {
  register: '<label>Email <input type="email" name="email" required></label>',
  profile: '<label>Display name <input name="displayName" required></label>',
  password: '<label>Password <input type="password" name="password" minlength="12" required></label>',
  authenticator: '<label>Authenticator code <input name="code" required></label>',
};

async function startFixture() {
  const sessions = new Map();
  const events = [];
  const server = http.createServer(async (req, res) => {
    const step = req.url.slice(1);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'");
    function fail(status) { res.writeHead(status); res.end(); }

    const id = req.headers.cookie?.match(/(?:^|; )fixture_session=([a-f0-9-]+)(?:;|$)/)?.[1];
    let session = sessions.get(id);
    if (!Object.hasOwn(forms, step) && step !== 'done') return fail(404);
    if (step !== 'register' && !session) return fail(401);
    if (session && step !== session.next) return fail(409);
    if (req.method === 'GET') {
      if (step === 'done') return res.end('<h1>Setup complete</h1>');
      return res.end('<form method="post">' + forms[step] + '<button>Continue</button></form>');
    }
    if (req.method !== 'POST' || step === 'done') return fail(405);
    if (req.headers.origin !== origin) return fail(403);
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2048) return fail(413);
    }
    const fields = new URLSearchParams(body);
    switch (step) {
      case 'register': {
        if (fields.get('email') !== 'single-session@example.test') return fail(400);
        const sessionId = randomUUID();
        session = { id: sessionId, next: 'profile', email: fields.get('email'), mfa: false };
        sessions.set(sessionId, session);
        res.setHeader('Set-Cookie', 'fixture_session=' + sessionId + '; HttpOnly; SameSite=Strict; Path=/');
        break;
      }
      case 'profile':
        if (!fields.get('displayName')?.trim()) return fail(400);
        session.displayName = fields.get('displayName');
        session.next = 'password';
        break;
      case 'password': {
        const password = fields.get('password');
        if (!password || password.length < 12) return fail(400);
        session.hash = scryptSync(password, session.id, 32);
        session.next = 'authenticator';
        break;
      }
      case 'authenticator':
        if (fields.get('code') !== '287082') return fail(422);
        session.mfa = true;
        session.next = 'done';
        break;
    }
    events.push({ step, id: session.id });
    res.writeHead(303, { Location: '/' + session.next });
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, events, sessions, close: () => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }) };
}

module.exports = { startFixture };
