'use strict';
/* 본사 관리자 인증
   - 비밀번호는 환경변수(ADMIN_PASSWORD)에서만 읽고 파일·DB에 저장하지 않는다.
   - 로그인 성공 시 HMAC-SHA256 서명 토큰을 발급하고, 모든 관리자 API가 서명·만료·폐기를 검사한다.
   - 브라우저 localStorage 값만으로는 관리자 권한을 얻을 수 없다(서버가 매 요청 검증). */

const crypto = require('crypto');

const b64u = buffer => Buffer.from(buffer).toString('base64url');
const fromB64u = text => Buffer.from(String(text), 'base64url');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

class Auth {
  constructor(options) {
    this.password = String(options.password || '');
    this.email = String(options.email || '').toLowerCase();
    this.secret = options.secret;
    this.ttlMs = Number(options.ttlMs) || 8 * 60 * 60 * 1000;
    this.usingDefaultPassword = Boolean(options.usingDefaultPassword);
    this.revoked = new Map(); // jti -> exp(ms)
    this.failures = new Map(); // ip -> {count, firstAt}
  }

  /* 로그인 시도 제한: 같은 IP에서 10분에 8회 실패하면 잠시 막는다. */
  throttle(ip) {
    const now = Date.now();
    const record = this.failures.get(ip);
    if (!record) return { allowed: true };
    if (now - record.firstAt > 10 * 60 * 1000) {
      this.failures.delete(ip);
      return { allowed: true };
    }
    if (record.count >= 8) return { allowed: false, retryAfter: Math.ceil((record.firstAt + 10 * 60 * 1000 - now) / 1000) };
    return { allowed: true };
  }

  registerFailure(ip) {
    const now = Date.now();
    const record = this.failures.get(ip);
    if (!record || now - record.firstAt > 10 * 60 * 1000) this.failures.set(ip, { count: 1, firstAt: now });
    else record.count += 1;
  }

  login(input, meta = {}) {
    const ip = meta.ip || 'unknown';
    const limited = this.throttle(ip);
    if (!limited.allowed) {
      return { ok: false, code: 'rate_limited', message: `로그인 시도가 너무 많습니다. ${limited.retryAfter}초 후 다시 시도해주세요.`, retryAfter: limited.retryAfter };
    }
    const email = String((input && input.email) || '').trim().toLowerCase();
    const password = String((input && input.password) || '');
    const emailOk = !email || email === this.email;
    const passwordOk = safeEqual(sha256(password), sha256(this.password));
    if (!passwordOk || !emailOk) {
      this.registerFailure(ip);
      return { ok: false, code: 'invalid_credentials', message: '이메일 또는 비밀번호가 올바르지 않습니다.' };
    }
    this.failures.delete(ip);
    const issuedAt = Date.now();
    const payload = {
      sub: 'admin',
      email: this.email,
      iat: Math.floor(issuedAt / 1000),
      exp: Math.floor((issuedAt + this.ttlMs) / 1000),
      jti: crypto.randomBytes(12).toString('hex')
    };
    const body = b64u(JSON.stringify(payload));
    const signature = b64u(crypto.createHmac('sha256', this.secret).update(`v1.${body}`).digest());
    return { ok: true, token: `v1.${body}.${signature}`, expiresAt: new Date(issuedAt + this.ttlMs).toISOString(), email: this.email };
  }

  verify(token) {
    if (!token) return { ok: false, code: 'missing_token', message: '로그인이 필요합니다.' };
    const parts = String(token).split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, code: 'invalid_token', message: '세션이 올바르지 않습니다. 다시 로그인해주세요.' };
    const [, body, signature] = parts;
    const expected = b64u(crypto.createHmac('sha256', this.secret).update(`v1.${body}`).digest());
    if (!safeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return { ok: false, code: 'invalid_token', message: '세션이 올바르지 않습니다. 다시 로그인해주세요.' };
    }
    let payload;
    try { payload = JSON.parse(fromB64u(body).toString('utf8')); } catch {
      return { ok: false, code: 'invalid_token', message: '세션이 올바르지 않습니다. 다시 로그인해주세요.' };
    }
    if (!payload || payload.sub !== 'admin') return { ok: false, code: 'invalid_token', message: '세션이 올바르지 않습니다.' };
    if (Number(payload.exp) * 1000 <= Date.now()) return { ok: false, code: 'expired_token', message: '로그인 시간이 만료되었습니다. 다시 로그인해주세요.' };
    if (this.revoked.has(payload.jti)) return { ok: false, code: 'revoked_token', message: '로그아웃된 세션입니다. 다시 로그인해주세요.' };
    return { ok: true, payload };
  }

  revoke(token) {
    const checked = this.verify(token);
    if (!checked.ok) return false;
    this.revoked.set(checked.payload.jti, Number(checked.payload.exp) * 1000);
    this.cleanup();
    return true;
  }

  cleanup() {
    const now = Date.now();
    for (const [jti, exp] of this.revoked) if (exp <= now) this.revoked.delete(jti);
  }
}

module.exports = { Auth, sha256, safeEqual };
