const { test } = require('node:test');
const assert = require('node:assert/strict');
const { snapshotMailIds, fetchCode } = require('../src/mailer');

const url = 'https://pickup.example.test/api/pickup/example-secret?days=2';
const sent = Math.floor(Date.now() / 1000) * 1000 - 10000;
const opts = { url, toEmail: 'alice+1@icloud.com', freshAfterMs: sent, pageLoadWaitMs: 0, pollIntervalMs: 1, maxWaitMs: 100, snapshotBaseline: false };
const mail = (id, time, code, to = 'alice+1@icloud.com') => ({ id, from: 'OpenAI <noreply@openai.com>', to,
  subject: 'Your temporary ChatGPT login code', date: new Date(time).toISOString(), preview: `Your code: ${code}` });
function inbox(rounds) {
  let round = 0;
  return { newPage: async () => ({
    goto: async target => {
      const u = new URL(target);
      assert.equal(u.searchParams.get('days'), '2');
      assert.equal(u.searchParams.get('format'), 'json');
      assert.equal(u.searchParams.get('body'), '1');
      assert.equal(u.searchParams.get('limit'), '30');
      const result = rounds[Math.min(round++, rounds.length - 1)];
      return { ok: () => true, json: async () => result };
    },
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 1))),
    close: async () => {}, isClosed: () => false,
  }) };
}
const response = messages => ({ success: true, data: { messages } });

test('JSON 取件读取正文并按历史 ID、时间和收件人选择本次验证码', async () => {
  const old = mail('old', sent - 1000, '111111');
  const baseline = await snapshotMailIds(inbox([response([old])]), opts);
  const logs = [];
  const messages = [old, mail('other', sent + 1000, '222222', 'alice+2@icloud.com'), mail('new', sent + 2000, '333333')];
  assert.equal(await fetchCode(inbox([response(messages)]), { ...opts, seenIds: baseline, log: x => logs.push(x) }), '333333');
  assert.equal(baseline.has('new'), true);
  assert.ok(!logs.join('\n').includes('333333'));
});

test('JSON 取件处理空列表并拒绝缺失 ID、时间或无效响应', async () => {
  assert.equal((await snapshotMailIds(inbox([response([])]), opts)).size, 0);
  for (const invalid of [response([{ ...mail('x', sent, '111111'), id: '' }]), response([{ ...mail('x', sent, '111111'), date: '' }]), { success: false }]) {
    await assert.rejects(snapshotMailIds(inbox([invalid]), opts), /格式|稳定 ID/);
  }
});
