const { createHmac } = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function normalizeSecret(value) {
  if (typeof value !== 'string') throw new Error('2FA 密钥必须是 Base32 文本');
  const secret = value.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (secret.length < 16 || !/^[A-Z2-7]+$/.test(secret) || ![0, 2, 4, 5, 7].includes(secret.length % 8)) {
    throw new Error('2FA 密钥不是有效的 Base32 格式');
  }
  return secret;
}

function decodeSecret(value) {
  const secret = normalizeSecret(value);
  let bits = 0;
  let buffer = 0;
  const bytes = [];
  for (const char of secret) {
    buffer = (buffer << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) throw new Error('2FA 密钥尾部编码不正确');
  return Buffer.from(bytes);
}

function generateTotp(secret, { now = Date.now(), digits = 6, period = 30 } = {}) {
  if (!Number.isFinite(now) || now < 0 || ![6, 8].includes(digits) || period !== 30) throw new Error('不支持的 TOTP 参数');
  const step = Math.floor(now / (period * 1000));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', decodeSecret(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = digest.readUInt32BE(offset) & 0x7fffffff;
  const expiresAt = (step + 1) * period * 1000;
  return { code: String(number % (10 ** digits)).padStart(digits, '0'), expiresAt, remaining: Math.ceil((expiresAt - now) / 1000) };
}

async function freshTotp(secret, page, signal) {
  signal?.throwIfAborted();
  let value = generateTotp(secret);
  if (value.remaining < 6) {
    await page.waitForTimeout(value.expiresAt - Date.now() + 200);
    signal?.throwIfAborted();
    value = generateTotp(secret);
  }
  return value.code;
}

module.exports = { normalizeSecret, generateTotp, freshTotp };
