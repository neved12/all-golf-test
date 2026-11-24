'use strict';
/* ALL:GOLF 7단계 골프장 담당자 세션
   - 본사 관리자(6단계)와 같은 HMAC-SHA256 서명 방식을 쓰되 토큰 접두사/키를 분리해 충돌하지 않는다.
   - 토큰에는 accountId, courseId, sessionEpoch 를 담고, 매 요청마다 DB의 계정 상태와 대조한다.
     → 계정 비활성화·권한 변경 시 sessionEpoch 가 올라가 기존 토큰이 즉시 무효가 된다.
   - 로그아웃은 jti 폐기 목록으로 처리한다(프로세스 재시작 시 폐기 목록은 초기화되며,
     SESSION_SECRET 이 고정되어 있으면 만료 전까지 토큰이 다시 유효해질 수 있음 → 문서에 명시). */

const crypto = require('crypto');

const b64u = buffer => Buffer.from(buffer).toString('base64url');
const fromB64u = text => Buffer.from(String(text), 'base64url');

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

class PartnerAuth {
  constructor(options = {}) {
    this.secret = options.secret;
    this.ttlMs = Number(options.ttlMs) || 8 * 60 * 60 * 1000;
    this.revoked = new Map(); // jti -> exp(ms)
    this.failures = new Map(); // ip:email -> {count, firstAt}
    this.windowMs = 10 * 60 * 1000;
    this.maxFailures = 10;
  }

  throttle(key) {
    const now = Date.now();
    const record = this.failures.get(key);
    if (!record) return { allowed: true };
    if (now - record.firstAt > this.windowMs) {
      this.failures.delete(key);
      return { allowed: true };
    }
    if (record.count >= this.maxFailures) {
      return { allowed: false, retryAfter: Math.ceil((record.firstAt + this.windowMs - now) / 1000) };
    }
    return { allowed: true };
  }

  registerFailure(key) {
    const now = Date.now();
    const record = this.failures.get(key);
    if (!record || now - record.firstAt > this.windowMs) this.failures.set(key, { count: 1, firstAt: now });
    else record.count += 1;
  }

  clearFailures(key) {
    this.failures.delete(key);
  }

  issue(account) {
    const issuedAt = Date.now();
    const payload = {
      sub: 'partner',
      accountId: account.id,
      courseId: String(account.courseId),
      epoch: Number(account.sessionEpoch) || 1,
      role: account.role,
      iat: Math.floor(issuedAt / 1000),
      exp: Math.floor((issuedAt + this.ttlMs) / 1000),
      jti: crypto.randomBytes(12).toString('hex')
    };
    const body = b64u(JSON.stringify(payload));
    const signature = b64u(crypto.createHmac('sha256', this.secret).update(`partner.v1.${body}`).digest());
    return { token: `p1.${body}.${signature}`, expiresAt: new Date(issuedAt + this.ttlMs).toISOString(), payload };
  }

  verify(token) {
    if (!token) return { ok: false, code: 'missing_token', message: '골프장 담당자 로그인이 필요합니다.' };
    const parts = String(token).split('.');
    if (parts.length !== 3 || parts[0] !== 'p1') {
      return { ok: false, code: 'invalid_token', message: '세션이 올바르지 않습니다. 다시 로그인해주세요.' };
    }
    const [, body, signature] = parts;
    const expected = b64u(crypto.createHmac('sha256', this.secret).update(`partner.v1.${body}`).digest());
    if (!safeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return { ok: false, code: 'invalid_token', message: '세션이 올바르지 않습니다. 다시 로그인해주세요.' };
    }
    let payload;
    try { payload = JSON.parse(fromB64u(body).toString('utf8')); } catch {
      return { ok: false, code: 'invalid_token', message: '세션이 올바르지 않습니다. 다시 로그인해주세요.' };
    }
    if (!payload || payload.sub !== 'partner' || !payload.accountId) {
      return { ok: false, code: 'invalid_token', message: '세션이 올바르지 않습니다.' };
    }
    if (Number(payload.exp) * 1000 <= Date.now()) {
      return { ok: false, code: 'expired_token', message: '로그인 시간이 만료되었습니다. 다시 로그인해주세요.' };
    }
    if (this.revoked.has(payload.jti)) {
      return { ok: false, code: 'revoked_token', message: '로그아웃된 세션입니다. 다시 로그인해주세요.' };
    }
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

module.exports = { PartnerAuth, safeEqual };
