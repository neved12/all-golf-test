'use strict';
/* ALL:GOLF 6단계 API
   공개: 건강 확인, 제휴 신청 접수·본인 조회, 승인 골프장 목록
   관리자: 로그인, 신청 목록·상세, 승인·반려, 처리 이력 (모두 서버 세션 검증) */

const crypto = require('crypto');
const path = require('path');
const domain = require('../lib/domain');
const http = require('../lib/http');

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const nowIso = () => new Date().toISOString();
const auditId = () => `AL-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

function createApi(options) {
  const { store, auth, catalog, config } = options;
  const sseClients = new Set();
  const lookupGuard = new Map();

  function broadcast(event, data) {
    for (const client of sseClients) client.send(event, data);
  }

  function pushAudit(db, entry) {
    db.auditLogs.push({ id: auditId(), at: nowIso(), ...entry });
    if (db.auditLogs.length > 10000) db.auditLogs.splice(0, db.auditLogs.length - 10000);
  }

  function partnerIdSet(db) {
    const ids = new Set(catalog.defaultPartnerIdSet);
    db.approvedCourses.forEach(course => ids.add(String(course.id)));
    return ids;
  }

  function requireAdmin(req) {
    const token = http.bearerToken(req) || http.parseCookies(req.headers.cookie)['allgolf_admin'] || '';
    const checked = auth.verify(token);
    if (!checked.ok) throw new HttpError(401, checked.code || 'unauthorized', checked.message || '로그인이 필요합니다.');
    return { token, payload: checked.payload };
  }

  function lookupLimit(ip, id) {
    const key = `${ip}:${id}`;
    const now = Date.now();
    const record = lookupGuard.get(key);
    if (!record || now - record.firstAt > 10 * 60 * 1000) return { ok: true, key };
    if (record.count >= 30) return { ok: false, retryAfter: Math.ceil((record.firstAt + 10 * 60 * 1000 - now) / 1000) };
    return { ok: true, key };
  }
  function registerLookupFailure(key) {
    const now = Date.now();
    const record = lookupGuard.get(key);
    if (!record || now - record.firstAt > 10 * 60 * 1000) lookupGuard.set(key, { count: 1, firstAt: now });
    else record.count += 1;
  }

  function buildApprovedCourse(application, actorEmail) {
    const courseId = application.courseMode === 'new' ? application.newCourseId : application.courseId;
    const master = application.courseMode === 'existing' ? catalog.byId.get(courseId) : null;
    const submitted = application.course || {};
    const pick = (key, fallback) => {
      const value = master && master[key] != null && master[key] !== '' ? master[key] : submitted[key];
      return value == null ? (fallback == null ? null : fallback) : value;
    };
    const conditions = application.conditions || {};
    return {
      id: courseId,
      applicationId: application.id,
      name: application.courseMode === 'existing' ? domain.text(master && master.name) || domain.text(submitted.name) : domain.text(submitted.name),
      region: domain.text(pick('region')),
      city: domain.text(pick('city')),
      address: domain.text(pick('address')),
      operationType: domain.OPERATION_TYPES.includes(pick('operationType')) ? pick('operationType') : 'public',
      holes: Number(pick('holes')) || null,
      phone: domain.text(pick('phone')) || null,
      website: domain.text(pick('officialWebsite', pick('website'))) || null,
      source: application.courseMode === 'existing' ? 'existing' : 'new',
      greenFee: {
        weekday: conditions.weekdayGreenFee == null ? null : Number(conditions.weekdayGreenFee),
        weekend: conditions.weekendGreenFee == null ? null : Number(conditions.weekendGreenFee),
        cart: conditions.cartFee == null ? null : Number(conditions.cartFee),
        caddie: conditions.caddieFee == null ? null : Number(conditions.caddieFee),
        teeInterval: conditions.teeInterval == null ? null : Number(conditions.teeInterval)
      },
      approvedAt: nowIso(),
      approvedBy: actorEmail,
      createdAt: application.createdAt,
      updatedAt: nowIso()
    };
  }

  function publicCourseList(db) {
    return db.approvedCourses
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'))
      .map(domain.publicCourse);
  }

  /* --- 라우팅 ------------------------------------------------------------ */
  async function handle(req, res, url) {
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';
    const query = url.searchParams;

    if (pathname === '/api/health' && method === 'GET') {
      let db = { applications: [], approvedCourses: [], auditLogs: [], meta: { revision: 0 } };
      try { db = store.read(); } catch (error) {
        http.sendError(res, 500, error.code || 'db_error', error.message);
        return;
      }
      http.sendJson(res, 200, {
        ok: true,
        name: config.serverName,
        version: config.version,
        time: nowIso(),
        uptimeSec: Math.round(process.uptime()),
        auth: { configured: !config.usingDefaultPassword, mode: config.usingDefaultPassword ? 'demo-default-password' : 'env' },
        db: {
          persistent: true,
          file: (() => {
            const relative = path.relative(config.rootDir, config.dbPath);
            return relative.startsWith('..') ? config.dbPath : relative;
          })(),
          applications: db.applications.length,
          pending: db.applications.filter(item => item.status === 'pending').length,
          approvedCourses: db.approvedCourses.length,
          auditLogs: db.auditLogs.length,
          revision: db.meta.revision || 0,
          updatedAt: db.meta.updatedAt || null
        },
        features: { sse: true, polling: true, publicCourses: true, adminSessions: true },
        dataMode: 'demo'
      });
      return;
    }

    if (pathname === '/api/partner-courses' && method === 'GET') {
      const db = store.read();
      const courses = publicCourseList(db);
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        count: courses.length,
        updatedAt: db.meta.updatedAt,
        courses,
        dataMode: 'demo'
      });
      return;
    }

    const teeMatch = pathname.match(/^\/api\/partner-courses\/([^/]+)\/tee-times$/);
    if (teeMatch && method === 'GET') {
      const courseId = decodeURIComponent(teeMatch[1]);
      const date = String(query.get('date') || domain.kstStamp().date);
      if (!domain.isValidDate(date)) throw new HttpError(400, 'invalid_date', 'date 는 YYYY-MM-DD 형식이어야 합니다.');
      const db = store.read();
      const record = db.approvedCourses.find(course => String(course.id) === courseId);
      if (!record) throw new HttpError(404, 'course_not_found', '승인된 제휴 골프장을 찾을 수 없습니다.');
      const times = domain.teeTimesFor(record, date);
      http.sendJson(res, 200, { ok: true, mode: 'server', courseId, date, count: times.length, teeTimes: times, dataMode: 'demo' });
      return;
    }

    const courseMatch = pathname.match(/^\/api\/partner-courses\/([^/]+)$/);
    if (courseMatch && method === 'GET') {
      const courseId = decodeURIComponent(courseMatch[1]);
      const db = store.read();
      const record = db.approvedCourses.find(course => String(course.id) === courseId);
      if (!record) throw new HttpError(404, 'course_not_found', '승인된 제휴 골프장을 찾을 수 없습니다.');
      http.sendJson(res, 200, { ok: true, mode: 'server', course: domain.publicCourse(record), dataMode: 'demo' });
      return;
    }

    if (pathname === '/api/partner-applications' && method === 'POST') {
      const body = await http.readJson(req);
      const ip = http.clientIp(req);
      const db = store.read();
      const partnerIds = partnerIdSet(db);
      const masterCourseIds = new Set(catalog.courses.map(course => String(course.id)));
      /* 중복 신청은 입력 검증보다 먼저 409 로 알려 준다(같은 골프장을 두 번 접수하지 않도록). */
      const rawMode = body.courseMode === 'new' ? 'new' : 'existing';
      if (rawMode === 'existing') {
        const rawCourseId = domain.text(body.courseId);
        if (rawCourseId && partnerIds.has(rawCourseId)) {
          throw new HttpError(409, 'already_partner', '이미 ALL:GOLF 제휴 중인 골프장입니다.');
        }
        const duplicate = db.applications.find(item => item.status !== 'rejected' && item.courseMode === 'existing' && item.courseId === rawCourseId);
        if (duplicate) {
          throw new HttpError(409, 'duplicate_application', `이미 검토 중인 신청이 있습니다. (접수번호 ${duplicate.id})`, { applicationId: duplicate.id });
        }
      } else {
        const rawName = domain.normalizeName(body.courseName);
        if (rawName.length > 1) {
          const duplicate = db.applications.find(item => item.status !== 'rejected' && domain.normalizeName(item.course && item.course.name) === rawName);
          if (duplicate) {
            throw new HttpError(409, 'duplicate_application', duplicate.status === 'approved'
              ? '이미 승인된 골프장입니다.'
              : `이미 검토 중인 신청이 있습니다. (접수번호 ${duplicate.id})`, { applicationId: duplicate.id });
          }
        }
      }
      const checked = domain.validateApplication(body, {
        masterCourseIds,
        masterById: catalog.byId,
        regionCodes: catalog.regionCodes,
        isPartner: id => partnerIds.has(String(id)),
        applications: db.applications
      });
      if (!checked.ok) {
        throw new HttpError(400, 'validation_failed', checked.message, { errors: checked.errors });
      }
      const value = checked.value;
      const lookupCode = domain.createLookupCode();
      const { result: created } = await store.update(current => {
        /* 잠금 안에서 한 번 더 중복을 확인해 경쟁 상태를 막는다. */
        const duplicate = current.applications.find(item => item.status !== 'rejected' && (
          value.courseMode === 'existing'
            ? item.courseMode === 'existing' && item.courseId === value.courseId
            : domain.normalizeName(item.course && item.course.name) === domain.normalizeName(value.course.name)
        ));
        if (duplicate) {
          throw new HttpError(409, 'duplicate_application', duplicate.status === 'approved'
            ? '이미 승인된 골프장입니다.'
            : `이미 검토 중인 신청이 있습니다. (접수번호 ${duplicate.id})`, { applicationId: duplicate.id });
        }
        const now = nowIso();
        const application = {
          id: domain.nextApplicationId(current),
          status: 'pending',
          courseMode: value.courseMode,
          courseId: value.courseMode === 'existing' ? value.courseId : null,
          newCourseId: value.courseMode === 'new' ? domain.newCourseId(current) : null,
          course: value.course,
          manager: value.manager,
          conditions: value.conditions,
          lookupCodeHash: null,
          agreeAt: now,
          decision: null,
          createdAt: now,
          updatedAt: now,
          dataMode: 'demo'
        };
        application.lookupCodeHash = domain.hashLookupCode(lookupCode, application.id);
        current.applications.push(application);
        pushAudit(current, {
          action: 'application.created',
          applicationId: application.id,
          actor: { type: 'partner', email: value.manager.email, ip },
          fromStatus: null,
          toStatus: 'pending',
          courseId: value.courseId || application.newCourseId,
          courseName: value.course.name
        });
        return application;
      });
      broadcast('partner-courses.changed', { reason: 'application.created', at: nowIso() });
      http.sendJson(res, 201, {
        ok: true,
        application: domain.publicApplication(created),
        lookupCode,
        message: '제휴 신청이 접수되었습니다. 접수번호와 조회 코드를 보관해주세요.'
      });
      return;
    }

    const applicationMatch = pathname.match(/^\/api\/partner-applications\/([^/]+)$/);
    if (applicationMatch && method === 'GET') {
      const id = decodeURIComponent(applicationMatch[1]);
      const ip = http.clientIp(req);
      const guard = lookupLimit(ip, id);
      if (!guard.ok) throw new HttpError(429, 'rate_limited', `조회 시도가 너무 많습니다. ${guard.retryAfter}초 후 다시 시도해주세요.`);
      const db = store.read();
      const application = db.applications.find(item => String(item.id) === id);
      if (!application) {
        registerLookupFailure(guard.key);
        throw new HttpError(404, 'application_not_found', '해당 접수번호의 신청을 찾을 수 없습니다.');
      }
      const code = String(query.get('code') || '').trim();
      const phone = domain.digits(query.get('phone') || '');
      const codeOk = code ? domain.verifyLookupCode(code, application) : false;
      const phoneOk = phone.length >= 10 && phone === domain.digits(application.manager && application.manager.phone);
      if (!codeOk && !phoneOk) {
        registerLookupFailure(guard.key);
        throw new HttpError(403, 'lookup_failed', '조회 코드 또는 담당자 연락처가 일치하지 않습니다.');
      }
      http.sendJson(res, 200, { ok: true, application: domain.publicApplication(application), dataMode: 'demo' });
      return;
    }

    if (pathname === '/api/admin/login' && method === 'POST') {
      const body = await http.readJson(req);
      const result = auth.login(body, { ip: http.clientIp(req) });
      if (!result.ok) {
        const status = result.code === 'rate_limited' ? 429 : 401;
        http.sendError(res, status, result.code, result.message, result.retryAfter ? { retryAfter: result.retryAfter } : undefined,
          result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : undefined);
        return;
      }
      const secure = config.secureCookie || String(req.headers['x-forwarded-proto'] || '').includes('https');
      const cookie = `allgolf_admin=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}${secure ? '; Secure' : ''}`;
      try {
        await store.update(db => pushAudit(db, {
          action: 'admin.login',
          applicationId: null,
          actor: { type: 'admin', email: result.email, ip: http.clientIp(req) },
          fromStatus: null,
          toStatus: null
        }));
      } catch { /* 감사 로그 실패가 로그인을 막지 않는다 */ }
      http.sendJson(res, 200, { ok: true, token: result.token, expiresAt: result.expiresAt, admin: { email: result.email }, mode: 'server' }, { 'Set-Cookie': cookie });
      return;
    }

    if (pathname === '/api/admin/logout' && method === 'POST') {
      const token = http.bearerToken(req) || http.parseCookies(req.headers.cookie)['allgolf_admin'] || '';
      auth.revoke(token);
      http.sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'allgolf_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
      return;
    }

    if (pathname === '/api/admin/session' && method === 'GET') {
      const admin = requireAdmin(req);
      http.sendJson(res, 200, { ok: true, admin: { email: admin.payload.email }, expiresAt: new Date(Number(admin.payload.exp) * 1000).toISOString(), mode: 'server' });
      return;
    }

    if (pathname === '/api/admin/partner-applications' && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      const status = String(query.get('status') || '');
      const q = String(query.get('q') || '').trim().toLowerCase();
      const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 200));
      let items = db.applications.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      if (['pending', 'approved', 'rejected'].includes(status)) items = items.filter(item => item.status === status);
      if (q) items = items.filter(item => `${item.id} ${item.course && item.course.name} ${item.manager && item.manager.name}`.toLowerCase().includes(q));
      const stats = {
        total: db.applications.length,
        pending: db.applications.filter(item => item.status === 'pending').length,
        approved: db.applications.filter(item => item.status === 'approved').length,
        rejected: db.applications.filter(item => item.status === 'rejected').length
      };
      http.sendJson(res, 200, { ok: true, count: items.length, stats, applications: items.slice(0, limit).map(domain.adminApplication), mode: 'server' });
      return;
    }

    const adminApplicationMatch = pathname.match(/^\/api\/admin\/partner-applications\/([^/]+)$/);
    if (adminApplicationMatch && method === 'GET') {
      requireAdmin(req);
      const id = decodeURIComponent(adminApplicationMatch[1]);
      const db = store.read();
      const application = db.applications.find(item => String(item.id) === id);
      if (!application) throw new HttpError(404, 'application_not_found', '신청을 찾을 수 없습니다.');
      http.sendJson(res, 200, { ok: true, application: domain.adminApplication(application), mode: 'server' });
      return;
    }

    const decisionMatch = pathname.match(/^\/api\/admin\/partner-applications\/([^/]+)\/(approve|reject)$/);
    if (decisionMatch && method === 'POST') {
      const admin = requireAdmin(req);
      const id = decodeURIComponent(decisionMatch[1]);
      const action = decisionMatch[2];
      const body = await http.readJson(req);
      const memo = domain.text(body.memo).slice(0, 300);
      const reason = domain.text(body.reason).slice(0, 300);
      if (action === 'reject' && !reason) throw new HttpError(400, 'reason_required', '반려 사유를 입력해주세요.');
      const toStatus = action === 'approve' ? 'approved' : 'rejected';
      const { result: updated } = await store.update(db => {
        const application = db.applications.find(item => String(item.id) === id);
        if (!application) throw new HttpError(404, 'application_not_found', '신청을 찾을 수 없습니다.');
        if (application.status !== 'pending') {
          throw new HttpError(409, 'already_decided', `이미 ${domain.statusLabel(application.status)}된 신청입니다.`, { status: application.status });
        }
        const at = nowIso();
        application.status = toStatus;
        application.decision = { at, by: admin.payload.email, memo: action === 'approve' ? memo : '', reason: action === 'reject' ? reason : '' };
        application.updatedAt = at;
        if (toStatus === 'approved') {
          const record = buildApprovedCourse(application, admin.payload.email);
          db.approvedCourses = db.approvedCourses.filter(course => String(course.id) !== String(record.id));
          db.approvedCourses.push(record);
        }
        pushAudit(db, {
          action: `application.${toStatus}`,
          applicationId: application.id,
          actor: { type: 'admin', email: admin.payload.email, ip: http.clientIp(req) },
          fromStatus: 'pending',
          toStatus,
          courseId: application.courseId || application.newCourseId,
          courseName: application.course && application.course.name,
          memo: action === 'approve' ? memo : '',
          reason: action === 'reject' ? reason : ''
        });
        return application;
      });
      broadcast('partner-courses.changed', { reason: `application.${toStatus}`, at: nowIso() });
      broadcast('application.decided', { status: toStatus, at: nowIso() });
      http.sendJson(res, 200, { ok: true, application: domain.adminApplication(updated), mode: 'server' });
      return;
    }

    if (pathname === '/api/admin/audit-logs' && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      const applicationId = String(query.get('applicationId') || '');
      const action = String(query.get('action') || '');
      const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 100));
      let logs = db.auditLogs.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
      if (applicationId) logs = logs.filter(item => item.applicationId === applicationId);
      if (action) logs = logs.filter(item => item.action === action);
      http.sendJson(res, 200, { ok: true, count: logs.length, logs: logs.slice(0, limit), mode: 'server' });
      return;
    }

    if (pathname === '/api/admin/stats' && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      http.sendJson(res, 200, {
        ok: true,
        stats: {
          applications: db.applications.length,
          pending: db.applications.filter(item => item.status === 'pending').length,
          approved: db.approvedCourses.length,
          rejected: db.applications.filter(item => item.status === 'rejected').length,
          auditLogs: db.auditLogs.length,
          lastUpdated: db.meta.updatedAt
        },
        mode: 'server'
      });
      return;
    }

    if (pathname === '/api/events' && method === 'GET') {
      const client = http.openSse(res);
      sseClients.add(client);
      client.send('hello', { at: nowIso(), mode: 'server' });
      const ping = setInterval(() => client.ping(), 15000);
      if (ping.unref) ping.unref();
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(client);
      });
      return;
    }

    throw new HttpError(404, 'not_found', `API 경로를 찾을 수 없습니다: ${pathname}`);
  }

  async function dispatch(req, res, url) {
    try {
      await handle(req, res, url);
    } catch (error) {
      if (res.headersSent) { try { res.end(); } catch { /* noop */ } return; }
      if (error instanceof HttpError) {
        http.sendError(res, error.status, error.code, error.message, error.details);
        return;
      }
      if (error && error.status) {
        http.sendError(res, error.status, error.code || 'error', error.message);
        return;
      }
      console.error('[ALL:GOLF API] 처리 중 오류:', error);
      http.sendError(res, 500, 'internal_error', '서버에서 요청을 처리하지 못했습니다.');
    }
  }

  return { dispatch, broadcast, sseClientCount: () => sseClients.size };
}

module.exports = { createApi, HttpError };
