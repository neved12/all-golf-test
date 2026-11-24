'use strict';
/* ALL:GOLF API (6단계 제휴 + 7단계 골프장별 계정·운영)
   공개: 건강 확인, 제휴 신청 접수·본인 조회, 승인 골프장 목록, 공개 카탈로그(티타임·특가)
   본사 관리자: 로그인, 신청 승인·반려, 처리 이력, 골프장 담당자 계정 관리, 골프장별 운영 현황
   골프장 담당자: 로그인/로그아웃, 자기 골프장의 티타임·요금·특가 CRUD (서버 세션의 courseId 로만 식별)
   - 브라우저에서 courseId 를 바꿔도 다른 골프장 데이터에는 접근할 수 없다(서버가 403). */

const crypto = require('crypto');
const path = require('path');
const domain = require('../lib/domain');
const operations = require('../lib/operations');
const accounts = require('../lib/accounts');
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
  const { store, auth, partnerAuth, catalog, config } = options;
  const sseClients = new Set();
  const lookupGuard = new Map();

  function broadcast(event, data) {
    for (const client of sseClients) client.send(event, data);
  }

  function pushAudit(db, entry) {
    db.auditLogs.push({ id: auditId(), at: nowIso(), ...entry });
    if (db.auditLogs.length > 10000) db.auditLogs.splice(0, db.auditLogs.length - 10000);
  }

  function courseNameOf(db, courseId) {
    const course = (db.approvedCourses || []).find(item => String(item.id) === String(courseId));
    return course ? course.name : null;
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

  /* 골프장 담당자 세션 검증. 매 요청마다 DB의 계정 상태·sessionEpoch 를 대조한다. */
  function partnerSession(req, opts = {}) {
    const token = http.bearerToken(req) || http.parseCookies(req.headers.cookie)['allgolf_partner'] || '';
    const checked = partnerAuth.verify(token);
    if (!checked.ok) throw new HttpError(401, checked.code || 'unauthorized', checked.message || '골프장 담당자 로그인이 필요합니다.');
    const db = opts.db || store.read();
    const account = (db.partnerAccounts || []).find(item => String(item.id) === String(checked.payload.accountId));
    if (!account) throw new HttpError(401, 'account_not_found', '골프장 계정을 찾을 수 없습니다. 다시 로그인해주세요.');
    if (account.status !== 'active') {
      throw new HttpError(401, 'account_disabled', '사용이 중지된 계정입니다. 본사 관리자에게 문의해주세요.');
    }
    if (Number(account.sessionEpoch) !== Number(checked.payload.epoch)) {
      throw new HttpError(401, 'session_invalidated', '계정 권한이 변경되어 세션이 만료되었습니다. 다시 로그인해주세요.');
    }
    const course = (db.approvedCourses || []).find(item => String(item.id) === String(account.courseId));
    if (!course) throw new HttpError(403, 'course_not_approved', '제휴 승인이 해제된 골프장입니다. 본사 관리자에게 문의해주세요.');
    if (opts.write && account.role === 'viewer') {
      throw new HttpError(403, 'forbidden_role', '조회 전용 계정은 운영 데이터를 변경할 수 없습니다.');
    }
    return { token, payload: checked.payload, account, course, db };
  }

  function assertOwnCourse(courseId, account) {
    if (courseId == null || String(courseId) === '') return;
    if (String(courseId) !== String(account.courseId)) {
      throw new HttpError(403, 'forbidden_course', '다른 골프장의 데이터는 조회·변경할 수 없습니다.');
    }
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

  function partnerAccountView(db, account) {
    const view = accounts.publicAccount(account);
    view.courseName = courseNameOf(db, account.courseId) || view.courseName;
    return view;
  }

  function adminActor(req, payload, extra) {
    return { type: 'admin', email: (payload && payload.email) || config.adminEmail, ip: http.clientIp(req), ...(extra || {}) };
  }

  function partnerActor(req, session, extra) {
    return {
      type: 'partner',
      email: session.account.email,
      accountId: session.account.id,
      ip: http.clientIp(req),
      ...(extra || {})
    };
  }

  function teeTimeAuditFields(tee, session) {
    return {
      courseId: String(tee.courseId),
      courseName: courseNameOf(session.db, tee.courseId) || session.course.name,
      teeTimeId: tee.id,
      date: tee.date,
      time: tee.time
    };
  }

  /* --- 라우팅 ------------------------------------------------------------ */
  async function handle(req, res, url) {
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';
    const query = url.searchParams;

    if (pathname === '/api/health' && method === 'GET') {
      let db = { applications: [], approvedCourses: [], auditLogs: [], partnerAccounts: [], teeTimes: [], specialOffers: [], meta: { revision: 0 } };
      try { db = store.read(); } catch (error) {
        http.sendError(res, 500, error.code || 'db_error', error.message);
        return;
      }
      http.sendJson(res, 200, {
        ok: true,
        name: config.serverName,
        version: config.version,
        stage: 7,
        time: nowIso(),
        uptimeSec: Math.round(process.uptime()),
        auth: { configured: !config.usingDefaultPassword, mode: config.usingDefaultPassword ? 'demo-default-password' : 'env', partnerAccounts: true },
        db: {
          persistent: true,
          file: (() => {
            const relative = path.relative(config.rootDir, config.dbPath);
            return relative.startsWith('..') ? config.dbPath : relative;
          })(),
          applications: db.applications.length,
          pending: db.applications.filter(item => item.status === 'pending').length,
          approvedCourses: db.approvedCourses.length,
          partnerAccounts: (db.partnerAccounts || []).length,
          teeTimes: (db.teeTimes || []).length,
          specialOffers: (db.specialOffers || []).filter(item => !item.deletedAt).length,
          auditLogs: db.auditLogs.length,
          revision: db.meta.revision || 0,
          updatedAt: db.meta.updatedAt || null
        },
        features: {
          sse: true,
          polling: true,
          publicCourses: true,
          adminSessions: true,
          partnerAccounts: true,
          teeTimes: true,
          rates: true,
          specialOffers: true,
          publicCatalog: true
        },
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

    /* 공개 카탈로그: 골프장이 서버에 등록한 티타임·요금·특가 (고객 앱 동기화용) */
    if (pathname === '/api/public/catalog' && method === 'GET') {
      const date = String(query.get('date') || operations.todayKst());
      if (!domain.isValidDate(date)) throw new HttpError(400, 'invalid_date', 'date 는 YYYY-MM-DD 형식이어야 합니다.');
      const courseId = String(query.get('courseId') || '').trim();
      const db = store.read();
      const payload = operations.publicCatalog(db, { date, courseId: courseId || null });
      http.sendJson(res, 200, { ...payload, serverTime: nowIso(), updatedAt: db.meta.updatedAt });
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
      /* 7단계: 골프장이 서버에 등록한 티타임이 있으면 그것을 우선 제공하고, 없으면 기존 시연 규칙을 쓴다. */
      const serverTimes = (db.teeTimes || []).filter(item => String(item.courseId) === courseId && item.date === date);
      if (serverTimes.length) {
        const rates = operations.effectiveRates(db, courseId);
        const offers = (db.specialOffers || []).filter(item => String(item.courseId) === courseId && item.roundDate === date && !item.deletedAt);
        const teeTimes = serverTimes
          .slice()
          .sort((a, b) => String(a.time).localeCompare(String(b.time)))
          .map(item => operations.publicTeeTime(db, item, rates, offers));
        http.sendJson(res, 200, {
          ok: true, mode: 'server', source: 'server', courseId, date, count: teeTimes.length, teeTimes,
          inventoryLinked: false, dataMode: 'demo'
        });
        return;
      }
      const times = domain.teeTimesFor(record, date);
      http.sendJson(res, 200, { ok: true, mode: 'server', source: 'demo', courseId, date, count: times.length, teeTimes: times, inventoryLinked: false, dataMode: 'demo' });
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
          actor: adminActor(req, { email: result.email }),
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
          actor: adminActor(req, admin.payload),
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

    /* --- 7단계: 본사 관리자의 골프장 담당자 계정 관리 ---------------------- */
    if (pathname === '/api/admin/partner-accounts' && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      const courseId = String(query.get('courseId') || '');
      const status = String(query.get('status') || '');
      const q = String(query.get('q') || '').trim().toLowerCase();
      let items = (db.partnerAccounts || []).slice();
      if (courseId) items = items.filter(item => String(item.courseId) === courseId);
      if (accounts.STATUSES.includes(status)) items = items.filter(item => item.status === status);
      if (q) items = items.filter(item => `${item.email} ${item.name}`.toLowerCase().includes(q));
      items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        count: items.length,
        stats: {
          total: (db.partnerAccounts || []).length,
          active: (db.partnerAccounts || []).filter(item => item.status === 'active').length,
          disabled: (db.partnerAccounts || []).filter(item => item.status === 'disabled').length,
          courses: new Set((db.partnerAccounts || []).map(item => String(item.courseId))).size
        },
        accounts: items.map(item => partnerAccountView(db, item))
      });
      return;
    }

    if (pathname === '/api/admin/partner-accounts' && method === 'POST') {
      const admin = requireAdmin(req);
      const body = await http.readJson(req);
      const generated = body.password == null || String(body.password).trim() === '';
      const candidate = {
        ...body,
        password: generated ? accounts.randomPassword(12) : String(body.password)
      };
      const { result: created } = await store.update(db => {
        const courseIds = new Set((db.approvedCourses || []).map(item => String(item.id)));
        const checked = accounts.validateAccountInput(candidate, { courseIds, accounts: db.partnerAccounts || [] });
        if (!checked.ok) throw new HttpError(400, 'validation_failed', checked.message, { errors: checked.errors });
        const account = accounts.buildAccount(db, checked.value, {
          createdBy: { type: 'admin', email: admin.payload.email }
        });
        account.courseName = courseNameOf(db, account.courseId);
        db.partnerAccounts.push(account);
        pushAudit(db, {
          action: 'partner-account.created',
          actor: adminActor(req, admin.payload),
          courseId: account.courseId,
          courseName: account.courseName,
          accountId: account.id,
          memo: `${account.email} · ${accounts.roleLabel(account.role)}`
        });
        return { account, password: checked.value.password };
      });
      http.sendJson(res, 201, {
        ok: true,
        mode: 'server',
        account: partnerAccountView(store.read(), created.account),
        initialPassword: created.password,
        passwordGenerated: generated,
        message: '골프장 담당자 계정이 생성되었습니다. 초기 비밀번호는 이 화면에서 한 번만 표시됩니다.'
      });
      return;
    }

    const adminAccountMatch = pathname.match(/^\/api\/admin\/partner-accounts\/([^/]+)$/);
    if (adminAccountMatch && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      const account = (db.partnerAccounts || []).find(item => String(item.id) === decodeURIComponent(adminAccountMatch[1]));
      if (!account) throw new HttpError(404, 'account_not_found', '골프장 계정을 찾을 수 없습니다.');
      http.sendJson(res, 200, { ok: true, mode: 'server', account: partnerAccountView(db, account) });
      return;
    }

    if (adminAccountMatch && method === 'PATCH') {
      const admin = requireAdmin(req);
      const id = decodeURIComponent(adminAccountMatch[1]);
      const body = await http.readJson(req);
      const { result: updated } = await store.update(db => {
        const account = (db.partnerAccounts || []).find(item => String(item.id) === id);
        if (!account) throw new HttpError(404, 'account_not_found', '골프장 계정을 찾을 수 없습니다.');
        if (body.version != null && Number(body.version) !== Number(account.version)) {
          throw new HttpError(409, 'version_conflict', '다른 곳에서 먼저 수정했습니다. 새로고침 후 다시 시도해주세요.', { current: partnerAccountView(db, account) });
        }
        const nextStatus = body.status == null ? account.status : String(body.status);
        if (!accounts.STATUSES.includes(nextStatus)) throw new HttpError(400, 'invalid_status', '계정 상태가 올바르지 않습니다.');
        const nextRole = body.role == null ? account.role : String(body.role);
        if (!accounts.ROLES.includes(nextRole)) throw new HttpError(400, 'invalid_role', '권한이 올바르지 않습니다.');
        const nextName = body.name == null ? account.name : domain.text(body.name);
        if (nextName.length < 2 || nextName.length > 20) throw new HttpError(400, 'invalid_name', '담당자명을 2~20자로 입력해주세요.');
        const nextCourseId = body.courseId == null ? account.courseId : domain.text(body.courseId);
        if (!(db.approvedCourses || []).some(item => String(item.id) === String(nextCourseId))) {
          throw new HttpError(400, 'course_not_approved', '제휴 승인된 골프장으로만 연결할 수 있습니다.');
        }
        const permissionChanged = nextStatus !== account.status || nextRole !== account.role || String(nextCourseId) !== String(account.courseId);
        account.status = nextStatus;
        account.role = nextRole;
        account.name = nextName;
        account.courseId = String(nextCourseId);
        account.updatedAt = nowIso();
        account.version = Number(account.version || 1) + 1;
        if (permissionChanged) account.sessionEpoch = Number(account.sessionEpoch || 1) + 1;
        pushAudit(db, {
          action: 'partner-account.updated',
          actor: adminActor(req, admin.payload),
          courseId: account.courseId,
          courseName: courseNameOf(db, account.courseId),
          accountId: account.id,
          memo: `${account.email} · ${accounts.statusLabel(account.status)} · ${accounts.roleLabel(account.role)}${permissionChanged ? ' · 세션 무효화' : ''}`
        });
        return account;
      });
      broadcast('partner-accounts.changed', { accountId: id, at: nowIso() });
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        account: partnerAccountView(store.read(), updated),
        sessionsInvalidated: true
      });
      return;
    }

    const resetMatch = pathname.match(/^\/api\/admin\/partner-accounts\/([^/]+)\/reset-password$/);
    if (resetMatch && method === 'POST') {
      const admin = requireAdmin(req);
      const id = decodeURIComponent(resetMatch[1]);
      const body = await http.readJson(req);
      const newPassword = body.password == null || String(body.password).trim() === ''
        ? accounts.randomPassword(12)
        : String(body.password);
      const problem = accounts.passwordProblem(newPassword);
      if (problem) throw new HttpError(400, 'invalid_password', problem, { errors: { password: problem } });
      const { result: updated } = await store.update(db => {
        const account = (db.partnerAccounts || []).find(item => String(item.id) === id);
        if (!account) throw new HttpError(404, 'account_not_found', '골프장 계정을 찾을 수 없습니다.');
        Object.assign(account, accounts.hashPassword(newPassword));
        account.passwordUpdatedAt = nowIso();
        account.updatedAt = nowIso();
        account.version = Number(account.version || 1) + 1;
        account.sessionEpoch = Number(account.sessionEpoch || 1) + 1;
        pushAudit(db, {
          action: 'partner-account.password-reset',
          actor: adminActor(req, admin.payload),
          courseId: account.courseId,
          courseName: courseNameOf(db, account.courseId),
          accountId: account.id,
          memo: `${account.email} · 비밀번호 재설정 · 기존 세션 무효화`
        });
        return account;
      });
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        account: partnerAccountView(store.read(), updated),
        initialPassword: newPassword,
        message: '비밀번호가 재설정되었습니다. 새 비밀번호는 이 화면에서 한 번만 표시되며 기존 세션은 모두 만료됩니다.'
      });
      return;
    }

    /* --- 7단계: 골프장별 운영 현황(본사) ---------------------------------- */
    if (pathname === '/api/admin/operations' && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      const date = String(query.get('date') || operations.todayKst());
      if (!domain.isValidDate(date)) throw new HttpError(400, 'invalid_date', 'date 는 YYYY-MM-DD 형식이어야 합니다.');
      const courses = (db.approvedCourses || []).map(course => {
        const courseId = String(course.id);
        const times = (db.teeTimes || []).filter(item => String(item.courseId) === courseId);
        const dayTimes = times.filter(item => item.date === date);
        const offers = (db.specialOffers || []).filter(item => String(item.courseId) === courseId && !item.deletedAt);
        const offerStates = offers.map(item => operations.offerStatus(item, new Date(), operations.soldTeamsFor(db, item.id)));
        const rate = (db.rates || {})[courseId] || null;
        const courseAccounts = (db.partnerAccounts || []).filter(item => String(item.courseId) === courseId);
        const recent = (db.auditLogs || [])
          .filter(item => String(item.courseId) === courseId && item.action !== 'application.created')
          .sort((a, b) => String(b.at).localeCompare(String(a.at)))
          .slice(0, 5);
        const stamps = [...times.map(item => item.updatedAt), rate && rate.updatedAt, ...offers.map(item => item.updatedAt), ...courseAccounts.map(item => item.updatedAt)].filter(Boolean).sort();
        return {
          courseId,
          courseName: course.name,
          region: course.region,
          city: course.city,
          teeTimes: {
            total: times.length,
            date: dayTimes.length,
            open: times.filter(item => operations.teeTimeStatus(item) === 'open').length,
            closed: times.filter(item => operations.teeTimeStatus(item) !== 'open').length
          },
          offers: {
            total: offers.length,
            active: offerStates.filter(item => item === 'active').length,
            scheduled: offerStates.filter(item => item === 'scheduled').length,
            ended: offerStates.filter(item => item === 'ended').length,
            paused: offerStates.filter(item => item === 'paused').length
          },
          rates: rate ? { baseGreenFee: rate.baseGreenFee, version: rate.version, updatedAt: rate.updatedAt } : null,
          accounts: { total: courseAccounts.length, active: courseAccounts.filter(item => item.status === 'active').length },
          lastUpdated: stamps.length ? stamps[stamps.length - 1] : null,
          recent
        };
      }).sort((a, b) => String(b.lastUpdated || '').localeCompare(String(a.lastUpdated || '')) || String(a.courseName).localeCompare(String(b.courseName), 'ko'));
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        date,
        count: courses.length,
        totals: {
          courses: courses.length,
          teeTimes: (db.teeTimes || []).length,
          teeTimesOnDate: (db.teeTimes || []).filter(item => item.date === date).length,
          offers: (db.specialOffers || []).filter(item => !item.deletedAt).length,
          accounts: (db.partnerAccounts || []).length,
          activeAccounts: (db.partnerAccounts || []).filter(item => item.status === 'active').length
        },
        courses,
        dataMode: 'demo'
      });
      return;
    }

    if (pathname === '/api/admin/tee-times' && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      const courseId = String(query.get('courseId') || '');
      const date = String(query.get('date') || '');
      if (date && !domain.isValidDate(date)) throw new HttpError(400, 'invalid_date', 'date 는 YYYY-MM-DD 형식이어야 합니다.');
      const ratesCache = new Map();
      const items = (db.teeTimes || [])
        .filter(item => (!courseId || String(item.courseId) === courseId) && (!date || item.date === date))
        .sort((a, b) => `${a.date} ${a.courseId} ${a.time}`.localeCompare(`${b.date} ${b.courseId} ${b.time}`))
        .map(item => {
          if (!ratesCache.has(String(item.courseId))) ratesCache.set(String(item.courseId), operations.effectiveRates(db, item.courseId));
          return {
            ...operations.teeTimeForPartner(item, ratesCache.get(String(item.courseId))),
            courseName: courseNameOf(db, item.courseId)
          };
        });
      http.sendJson(res, 200, { ok: true, mode: 'server', count: items.length, teeTimes: items, dataMode: 'demo' });
      return;
    }

    if (pathname === '/api/admin/special-offers' && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      const courseId = String(query.get('courseId') || '');
      const date = String(query.get('date') || '');
      if (date && !domain.isValidDate(date)) throw new HttpError(400, 'invalid_date', 'date 는 YYYY-MM-DD 형식이어야 합니다.');
      const items = (db.specialOffers || [])
        .filter(item => !item.deletedAt && (!courseId || String(item.courseId) === courseId) && (!date || item.roundDate === date))
        .sort((a, b) => `${a.roundDate} ${a.time}`.localeCompare(`${b.roundDate} ${b.time}`))
        .map(item => ({ ...operations.offerForPartner(db, item), courseName: courseNameOf(db, item.courseId) }));
      http.sendJson(res, 200, { ok: true, mode: 'server', count: items.length, offers: items, dataMode: 'demo' });
      return;
    }

    if (pathname === '/api/admin/audit-logs' && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      const applicationId = String(query.get('applicationId') || '');
      const action = String(query.get('action') || '');
      const courseId = String(query.get('courseId') || '');
      const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 100));
      let logs = db.auditLogs.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
      if (applicationId) logs = logs.filter(item => item.applicationId === applicationId);
      if (action) logs = logs.filter(item => item.action === action);
      if (courseId) logs = logs.filter(item => String(item.courseId) === courseId);
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
          partnerAccounts: (db.partnerAccounts || []).length,
          teeTimes: (db.teeTimes || []).length,
          specialOffers: (db.specialOffers || []).filter(item => !item.deletedAt).length,
          auditLogs: db.auditLogs.length,
          lastUpdated: db.meta.updatedAt
        },
        mode: 'server'
      });
      return;
    }

    /* --- 7단계: 골프장 담당자 인증 ---------------------------------------- */
    if (pathname === '/api/partner/login' && method === 'POST') {
      const body = await http.readJson(req);
      const ip = http.clientIp(req);
      const email = accounts.normalizeEmail(body.email);
      const password = String(body.password == null ? '' : body.password);
      const throttleKey = `${ip}:${email}`;
      const limited = partnerAuth.throttle(throttleKey);
      if (!limited.allowed) {
        http.sendError(res, 429, 'rate_limited', `로그인 시도가 너무 많습니다. ${limited.retryAfter}초 후 다시 시도해주세요.`,
          { retryAfter: limited.retryAfter }, { 'Retry-After': String(limited.retryAfter) });
        return;
      }
      const db = store.read();
      const account = (db.partnerAccounts || []).find(item => accounts.normalizeEmail(item.email) === email);
      /* 계정 존재 여부를 노출하지 않도록 형식 오류와 동일한 401 을 돌려준다. */
      if (!account || !accounts.verifyPassword(password, account)) {
        partnerAuth.registerFailure(throttleKey);
        throw new HttpError(401, 'invalid_credentials', '이메일 또는 비밀번호가 올바르지 않습니다.');
      }
      if (account.status !== 'active') {
        throw new HttpError(403, 'account_disabled', '사용이 중지된 계정입니다. 본사 관리자에게 문의해주세요.');
      }
      const course = (db.approvedCourses || []).find(item => String(item.id) === String(account.courseId));
      if (!course) throw new HttpError(403, 'course_not_approved', '제휴 승인이 해제된 골프장입니다. 본사 관리자에게 문의해주세요.');
      partnerAuth.clearFailures(throttleKey);
      const session = partnerAuth.issue(account);
      const at = nowIso();
      try {
        await store.update(current => {
          const target = (current.partnerAccounts || []).find(item => String(item.id) === String(account.id));
          if (target) {
            target.lastLoginAt = at;
            target.updatedAt = target.updatedAt;
          }
          pushAudit(current, {
            action: 'partner.login',
            actor: { type: 'partner', email: account.email, accountId: account.id, ip },
            courseId: account.courseId,
            courseName: course.name,
            accountId: account.id
          });
        });
      } catch { /* 로그 기록 실패가 로그인을 막지 않는다 */ }
      const secure = config.secureCookie || String(req.headers['x-forwarded-proto'] || '').includes('https');
      const cookie = `allgolf_partner=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(config.partnerSessionTtlMs / 1000)}${secure ? '; Secure' : ''}`;
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        token: session.token,
        expiresAt: session.expiresAt,
        account: partnerAccountView(db, { ...account, courseName: course.name }),
        course: { id: course.id, name: course.name, region: course.region, city: course.city, operationType: course.operationType, phone: course.phone || null }
      }, { 'Set-Cookie': cookie });
      return;
    }

    if (pathname === '/api/partner/logout' && method === 'POST') {
      const token = http.bearerToken(req) || http.parseCookies(req.headers.cookie)['allgolf_partner'] || '';
      partnerAuth.revoke(token);
      http.sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'allgolf_partner=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
      return;
    }

    if (pathname === '/api/partner/session' && method === 'GET') {
      const session = partnerSession(req);
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        account: partnerAccountView(session.db, session.account),
        course: {
          id: session.course.id, name: session.course.name, region: session.course.region,
          city: session.course.city, operationType: session.course.operationType, phone: session.course.phone || null
        },
        expiresAt: new Date(Number(session.payload.exp) * 1000).toISOString()
      });
      return;
    }

    if (pathname === '/api/partner/dashboard' && method === 'GET') {
      const session = partnerSession(req);
      const db = session.db;
      const courseId = String(session.account.courseId);
      const times = (db.teeTimes || []).filter(item => String(item.courseId) === courseId);
      const offers = (db.specialOffers || []).filter(item => String(item.courseId) === courseId && !item.deletedAt);
      const today = operations.todayKst();
      const accountCount = (db.partnerAccounts || []).filter(item => String(item.courseId) === courseId);
      const stamps = [...times.map(item => item.updatedAt), ...offers.map(item => item.updatedAt), session.account.updatedAt].filter(Boolean).sort();
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        course: {
          id: session.course.id, name: session.course.name, region: session.course.region, city: session.course.city,
          address: session.course.address || null, operationType: session.course.operationType,
          holes: session.course.holes || null, phone: session.course.phone || null, approvedAt: session.course.approvedAt || null
        },
        account: partnerAccountView(db, session.account),
        rates: operations.effectiveRates(db, courseId),
        teeTimes: {
          total: times.length,
          today: times.filter(item => item.date === today).length,
          upcoming: times.filter(item => item.date >= today).length,
          open: times.filter(item => operations.teeTimeStatus(item) === 'open').length
        },
        offers: {
          total: offers.length,
          active: offers.filter(item => operations.offerStatus(item, new Date(), operations.soldTeamsFor(db, item.id)) === 'active').length,
          scheduled: offers.filter(item => operations.offerStatus(item, new Date(), operations.soldTeamsFor(db, item.id)) === 'scheduled').length
        },
        accounts: { total: accountCount.length, active: accountCount.filter(item => item.status === 'active').length },
        reservations: {
          source: 'demo-local',
          linked: false,
          count: null,
          note: '예약은 아직 서버로 이전되지 않았습니다(8단계). 예약 관리 화면은 이 브라우저의 시연 예약만 표시합니다.'
        },
        lastUpdated: stamps.length ? stamps[stamps.length - 1] : null,
        serverTime: nowIso(),
        dataMode: 'demo'
      });
      return;
    }

    if (pathname === '/api/partner/tee-times' && method === 'GET') {
      const session = partnerSession(req);
      const courseId = String(session.account.courseId);
      assertOwnCourse(query.get('courseId'), session.account);
      const date = String(query.get('date') || '');
      const from = String(query.get('from') || '');
      const to = String(query.get('to') || '');
      if (date && !domain.isValidDate(date)) throw new HttpError(400, 'invalid_date', 'date 는 YYYY-MM-DD 형식이어야 합니다.');
      if (from && !domain.isValidDate(from)) throw new HttpError(400, 'invalid_date', 'from 은 YYYY-MM-DD 형식이어야 합니다.');
      if (to && !domain.isValidDate(to)) throw new HttpError(400, 'invalid_date', 'to 는 YYYY-MM-DD 형식이어야 합니다.');
      const rates = operations.effectiveRates(session.db, courseId);
      const items = (session.db.teeTimes || [])
        .filter(item => String(item.courseId) === courseId
          && (!date || item.date === date)
          && (!from || item.date >= from)
          && (!to || item.date <= to))
        .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
        .map(item => operations.teeTimeForPartner(item, rates));
      http.sendJson(res, 200, {
        ok: true, mode: 'server', courseId, date: date || null, count: items.length, teeTimes: items,
        inventoryLinked: false, updatedAt: session.db.meta.updatedAt, dataMode: 'demo'
      });
      return;
    }

    if (pathname === '/api/partner/tee-times' && method === 'POST') {
      const body = await http.readJson(req);
      const { result } = await store.update(db => {
        const session = partnerSession(req, { db, write: true });
        assertOwnCourse(body.courseId, session.account);
        const courseId = String(session.account.courseId);
        const checked = operations.validateTeeTime(body);
        if (!checked.ok) throw new HttpError(400, 'validation_failed', checked.message, { errors: checked.errors });
        const value = { ...checked.value, courseId };
        const duplicate = operations.findDuplicateTeeTime(db, value);
        if (duplicate) {
          throw new HttpError(409, 'duplicate_tee_time', '같은 날짜·시간·코스의 티타임이 이미 있습니다.', { teeTimeId: duplicate.id });
        }
        const at = nowIso();
        const tee = {
          id: operations.nextId('tt'),
          courseId,
          courseName: session.course.name,
          ...value,
          bookedTeams: 0,
          heldTeams: 0,
          version: 1,
          createdAt: at,
          updatedAt: at,
          createdBy: { type: 'partner', email: session.account.email, accountId: session.account.id },
          updatedBy: { type: 'partner', email: session.account.email, accountId: session.account.id },
          dataMode: 'demo'
        };
        db.teeTimes.push(tee);
        pushAudit(db, {
          action: 'tee-time.created',
          actor: partnerActor(req, session),
          courseId,
          courseName: session.course.name,
          teeTimeId: tee.id,
          memo: `${tee.date} ${tee.time} ${tee.course} · ${tee.capacityTeams}팀 · ${tee.greenFee}원`
        });
        return tee;
      });
      broadcast('catalog.changed', { kind: 'tee-times', courseId: String(result.courseId), date: result.date, at: nowIso() });
      broadcast('tee-times.changed', { courseId: String(result.courseId), date: result.date, at: nowIso() });
      const db = store.read();
      http.sendJson(res, 201, {
        ok: true, mode: 'server',
        teeTime: operations.teeTimeForPartner(result, operations.effectiveRates(db, result.courseId)),
        dataMode: 'demo'
      });
      return;
    }

    if (pathname === '/api/partner/tee-times/recurring' && method === 'POST') {
      const body = await http.readJson(req);
      const { result } = await store.update(db => {
        const session = partnerSession(req, { db, write: true });
        assertOwnCourse(body.courseId, session.account);
        const courseId = String(session.account.courseId);
        const startDate = String(body.startDate || '').trim();
        const endDate = String(body.endDate || '').trim();
        if (!domain.isValidDate(startDate) || !domain.isValidDate(endDate)) {
          throw new HttpError(400, 'invalid_range', '시작일과 종료일을 YYYY-MM-DD 형식으로 입력해주세요.');
        }
        if (endDate < startDate) throw new HttpError(400, 'invalid_range', '종료일은 시작일보다 빠를 수 없습니다.');
        const span = Math.round((new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`)) / 86400000);
        if (span > 89) throw new HttpError(400, 'invalid_range', '날짜 반복은 최대 90일 범위까지 등록할 수 있습니다.');
        const weekdays = Array.isArray(body.weekdays) ? body.weekdays.map(Number) : [];
        if (!weekdays.length || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
          throw new HttpError(400, 'invalid_weekdays', '반복 요일을 하나 이상 선택해주세요.');
        }
        const base = {
          course: body.course,
          time: body.time,
          session: body.session,
          capacityTeams: body.capacityTeams,
          maxPlayers: body.maxPlayers,
          greenFee: body.greenFee,
          status: body.status,
          note: body.note
        };
        const created = [];
        const skipped = [];
        for (let offset = 0; offset <= span; offset += 1) {
          const date = operations.addDaysIso(startDate, offset);
          const weekday = new Date(`${date}T00:00:00`).getDay();
          if (!weekdays.includes(weekday)) continue;
          const candidate = { ...base, date };
          if (date < operations.todayKst()) { skipped.push({ date, reason: 'past' }); continue; }
          const duplicate = operations.findDuplicateTeeTime(db, { ...candidate, course: candidate.course || '전체', courseId });
          if (duplicate) { skipped.push({ date, reason: 'duplicate' }); continue; }
          const checked = operations.validateTeeTime(candidate);
          if (!checked.ok) { skipped.push({ date, reason: 'invalid', message: checked.message }); continue; }
          const at = nowIso();
          const tee = {
            id: operations.nextId('tt'), courseId, courseName: session.course.name,
            ...checked.value, bookedTeams: 0, heldTeams: 0, version: 1,
            createdAt: at, updatedAt: at,
            createdBy: { type: 'partner', email: session.account.email, accountId: session.account.id },
            updatedBy: { type: 'partner', email: session.account.email, accountId: session.account.id },
            dataMode: 'demo'
          };
          db.teeTimes.push(tee);
          created.push(tee);
        }
        if (created.length) {
          pushAudit(db, {
            action: 'tee-time.recurring',
            actor: partnerActor(req, session),
            courseId,
            courseName: session.course.name,
            memo: `반복 등록 ${created.length}건 · 건너뜀 ${skipped.length}건 · ${startDate}~${endDate}`
          });
        }
        if (!created.length && !skipped.length) throw new HttpError(400, 'no_dates', '선택한 기간에 해당 요일이 없습니다.');
        return { created, skipped };
      });
      if (result.created.length) {
        broadcast('catalog.changed', { kind: 'tee-times', courseId: String(result.created[0].courseId), at: nowIso() });
      }
      const db = store.read();
      const rates = operations.effectiveRates(db, result.created[0] ? result.created[0].courseId : '');
      http.sendJson(res, 200, {
        ok: true, mode: 'server',
        created: result.created.length,
        skipped: result.skipped.length,
        skippedDates: result.skipped,
        teeTimes: result.created.map(item => operations.teeTimeForPartner(item, rates)),
        dataMode: 'demo'
      });
      return;
    }

    const partnerTeeMatch = pathname.match(/^\/api\/partner\/tee-times\/([^/]+)$/);
    if (partnerTeeMatch && method === 'PATCH') {
      const id = decodeURIComponent(partnerTeeMatch[1]);
      const body = await http.readJson(req);
      const { result } = await store.update(db => {
        const session = partnerSession(req, { db, write: true });
        const tee = operations.findTeeTime(db, id);
        if (!tee) throw new HttpError(404, 'tee_time_not_found', '티타임을 찾을 수 없습니다.');
        if (String(tee.courseId) !== String(session.account.courseId)) {
          throw new HttpError(403, 'forbidden_course', '다른 골프장의 티타임은 수정할 수 없습니다.');
        }
        if (body.version == null) throw new HttpError(400, 'version_required', '수정 충돌 방지를 위해 version 값이 필요합니다.');
        if (Number(body.version) !== Number(tee.version)) {
          throw new HttpError(409, 'version_conflict', '다른 곳에서 먼저 수정했습니다. 최신 내용을 확인한 뒤 다시 저장해주세요.', {
            current: operations.teeTimeForPartner(tee, operations.effectiveRates(db, tee.courseId))
          });
        }
        const checked = operations.validateTeeTime(body, { partial: true, existing: tee });
        if (!checked.ok) throw new HttpError(400, 'validation_failed', checked.message, { errors: checked.errors });
        const duplicate = operations.findDuplicateTeeTime(db, { ...checked.value, courseId: tee.courseId }, tee.id);
        if (duplicate) {
          throw new HttpError(409, 'duplicate_tee_time', '같은 날짜·시간·코스의 티타임이 이미 있습니다.', { teeTimeId: duplicate.id });
        }
        Object.assign(tee, checked.value, {
          version: Number(tee.version) + 1,
          updatedAt: nowIso(),
          updatedBy: { type: 'partner', email: session.account.email, accountId: session.account.id }
        });
        pushAudit(db, {
          action: 'tee-time.updated',
          actor: partnerActor(req, session),
          ...teeTimeAuditFields(tee, session),
          memo: `${tee.date} ${tee.time} · ${tee.capacityTeams}팀 · ${tee.greenFee}원 · ${operations.teeStatusLabel(tee.status)}`
        });
        return tee;
      });
      broadcast('catalog.changed', { kind: 'tee-times', courseId: String(result.courseId), date: result.date, at: nowIso() });
      broadcast('tee-times.changed', { courseId: String(result.courseId), date: result.date, at: nowIso() });
      const db = store.read();
      http.sendJson(res, 200, {
        ok: true, mode: 'server',
        teeTime: operations.teeTimeForPartner(result, operations.effectiveRates(db, result.courseId)),
        dataMode: 'demo'
      });
      return;
    }

    if (partnerTeeMatch && method === 'DELETE') {
      const id = decodeURIComponent(partnerTeeMatch[1]);
      const version = query.get('version');
      const { result } = await store.update(db => {
        const session = partnerSession(req, { db, write: true });
        const tee = operations.findTeeTime(db, id);
        if (!tee) throw new HttpError(404, 'tee_time_not_found', '티타임을 찾을 수 없습니다.');
        if (String(tee.courseId) !== String(session.account.courseId)) {
          throw new HttpError(403, 'forbidden_course', '다른 골프장의 티타임은 삭제할 수 없습니다.');
        }
        if (version != null && Number(version) !== Number(tee.version)) {
          throw new HttpError(409, 'version_conflict', '다른 곳에서 먼저 수정했습니다. 새로고침 후 다시 시도해주세요.');
        }
        const usage = operations.teeTimeUsage(db, tee);
        if (usage.inUse) {
          throw new HttpError(409, 'tee_time_in_use', '예약·임시확보가 연결된 티타임은 삭제할 수 없습니다. 삭제 대신 판매 중지나 마감을 사용해주세요.', { usage });
        }
        if (usage.offers > 0) {
          throw new HttpError(409, 'offer_linked', '특가가 연결된 티타임은 삭제할 수 없습니다. 특가를 먼저 삭제해주세요.', { offers: usage.offers });
        }
        db.teeTimes = db.teeTimes.filter(item => String(item.id) !== String(tee.id));
        pushAudit(db, {
          action: 'tee-time.deleted',
          actor: partnerActor(req, session),
          ...teeTimeAuditFields(tee, session),
          memo: `${tee.date} ${tee.time} 삭제`
        });
        return tee;
      });
      broadcast('catalog.changed', { kind: 'tee-times', courseId: String(result.courseId), date: result.date, at: nowIso() });
      broadcast('tee-times.changed', { courseId: String(result.courseId), date: result.date, at: nowIso() });
      http.sendJson(res, 200, { ok: true, mode: 'server', deleted: result.id, dataMode: 'demo' });
      return;
    }

    if (pathname === '/api/partner/rates' && method === 'GET') {
      const session = partnerSession(req);
      assertOwnCourse(query.get('courseId'), session.account);
      http.sendJson(res, 200, {
        ok: true, mode: 'server',
        rates: operations.effectiveRates(session.db, session.account.courseId),
        dataMode: 'demo'
      });
      return;
    }

    if (pathname === '/api/partner/rates' && method === 'PUT') {
      const body = await http.readJson(req);
      const { result } = await store.update(db => {
        const session = partnerSession(req, { db, write: true });
        assertOwnCourse(body.courseId, session.account);
        const courseId = String(session.account.courseId);
        const existing = operations.effectiveRates(db, courseId);
        if (body.version != null && Number(body.version) !== Number(existing.version)) {
          throw new HttpError(409, 'version_conflict', '다른 곳에서 먼저 요금을 수정했습니다. 새로고침 후 다시 시도해주세요.', { current: existing });
        }
        const checked = operations.validateRates(body);
        if (!checked.ok) throw new HttpError(400, 'validation_failed', checked.message, { errors: checked.errors });
        const at = nowIso();
        db.rates[courseId] = {
          ...existing,
          ...checked.value,
          courseId,
          version: Number(existing.version || 0) + 1,
          updatedAt: at,
          updatedBy: { type: 'partner', email: session.account.email, accountId: session.account.id },
          source: 'server',
          dataMode: 'demo'
        };
        pushAudit(db, {
          action: 'rates.updated',
          actor: partnerActor(req, session),
          courseId,
          courseName: session.course.name,
          memo: `기본 ${checked.value.baseGreenFee}원 · 3인 ${checked.value.threePlayerGreenFee == null ? `+${checked.value.threePlayerSurcharge}` : checked.value.threePlayerGreenFee} · 4인 ${checked.value.fourPlayerGreenFee == null ? '기본' : checked.value.fourPlayerGreenFee}`
        });
        return db.rates[courseId];
      });
      broadcast('catalog.changed', { kind: 'rates', courseId: String(result.courseId), at: nowIso() });
      http.sendJson(res, 200, { ok: true, mode: 'server', rates: result, dataMode: 'demo' });
      return;
    }

    if (pathname === '/api/partner/special-offers' && method === 'GET') {
      const session = partnerSession(req);
      assertOwnCourse(query.get('courseId'), session.account);
      const status = String(query.get('status') || '');
      const date = String(query.get('date') || '');
      if (date && !domain.isValidDate(date)) throw new HttpError(400, 'invalid_date', 'date 는 YYYY-MM-DD 형식이어야 합니다.');
      let items = (session.db.specialOffers || []).filter(item => String(item.courseId) === String(session.account.courseId) && !item.deletedAt);
      if (date) items = items.filter(item => item.roundDate === date);
      let views = items.map(item => operations.offerForPartner(session.db, item));
      if (status) views = views.filter(item => item.status === status);
      views.sort((a, b) => `${a.roundDate} ${a.time}`.localeCompare(`${b.roundDate} ${b.time}`));
      http.sendJson(res, 200, { ok: true, mode: 'server', count: views.length, offers: views, dataMode: 'demo' });
      return;
    }

    if (pathname === '/api/partner/special-offers' && method === 'POST') {
      const body = await http.readJson(req);
      const { result } = await store.update(db => {
        const session = partnerSession(req, { db, write: true });
        assertOwnCourse(body.courseId, session.account);
        const courseId = String(session.account.courseId);
        const tee = operations.findTeeTime(db, body.teeTimeId);
        if (!tee) throw new HttpError(400, 'tee_time_not_found', '특가를 연결할 티타임을 찾을 수 없습니다.', { errors: { teeTimeId: '특가를 연결할 티타임을 찾을 수 없습니다.' } });
        if (String(tee.courseId) !== courseId) throw new HttpError(403, 'forbidden_course', '다른 골프장의 티타임에는 특가를 등록할 수 없습니다.');
        const checked = operations.validateSpecialOffer(body, {
          tee,
          offers: db.specialOffers.filter(item => String(item.courseId) === courseId)
        });
        if (!checked.ok) {
          throw new HttpError(checked.code === 'offer_overlap' ? 409 : 400, checked.code, checked.message, { errors: checked.errors });
        }
        const at = nowIso();
        const value = checked.value;
        const discountAmount = Math.round(value.regularPrice) - Math.round(value.specialPrice);
        const offer = {
          id: operations.nextId('so'),
          courseId,
          courseName: session.course.name,
          ...value,
          discountAmount,
          discountRate: Math.round(discountAmount * 100 / Math.round(value.regularPrice)),
          deletedAt: null,
          version: 1,
          createdAt: at,
          updatedAt: at,
          createdBy: { type: 'partner', email: session.account.email, accountId: session.account.id },
          updatedBy: { type: 'partner', email: session.account.email, accountId: session.account.id },
          dataMode: 'demo'
        };
        db.specialOffers.push(offer);
        pushAudit(db, {
          action: 'special-offer.created',
          actor: partnerActor(req, session),
          courseId,
          courseName: session.course.name,
          teeTimeId: tee.id,
          offerId: offer.id,
          date: offer.roundDate,
          time: offer.time,
          memo: `${offer.name} · ${offer.specialPrice}원(${offer.discountRate}%) · ${offer.teamLimit}팀`
        });
        return offer;
      });
      broadcast('catalog.changed', { kind: 'special-offers', courseId: String(result.courseId), date: result.roundDate, at: nowIso() });
      const db = store.read();
      http.sendJson(res, 201, {
        ok: true, mode: 'server',
        offer: operations.offerForPartner(db, result),
        dataMode: 'demo'
      });
      return;
    }

    const partnerOfferMatch = pathname.match(/^\/api\/partner\/special-offers\/([^/]+)$/);
    if (partnerOfferMatch && method === 'PATCH') {
      const id = decodeURIComponent(partnerOfferMatch[1]);
      const body = await http.readJson(req);
      const { result } = await store.update(db => {
        const session = partnerSession(req, { db, write: true });
        const offer = (db.specialOffers || []).find(item => String(item.id) === id);
        if (!offer || offer.deletedAt) throw new HttpError(404, 'offer_not_found', '특가를 찾을 수 없습니다.');
        if (String(offer.courseId) !== String(session.account.courseId)) {
          throw new HttpError(403, 'forbidden_course', '다른 골프장의 특가는 수정할 수 없습니다.');
        }
        if (body.version == null) throw new HttpError(400, 'version_required', '수정 충돌 방지를 위해 version 값이 필요합니다.');
        if (Number(body.version) !== Number(offer.version)) {
          throw new HttpError(409, 'version_conflict', '다른 곳에서 먼저 수정했습니다. 최신 내용을 확인한 뒤 다시 저장해주세요.', {
            current: operations.offerForPartner(db, offer)
          });
        }
        const tee = operations.findTeeTime(db, offer.teeTimeId);
        if (!tee) throw new HttpError(409, 'tee_time_missing', '연결된 티타임이 삭제되었습니다. 특가를 새로 등록해주세요.');
        const checked = operations.validateSpecialOffer(body, {
          partial: true,
          existing: offer,
          tee,
          offers: db.specialOffers.filter(item => String(item.courseId) === String(offer.courseId) && String(item.id) !== String(offer.id))
        });
        if (!checked.ok) {
          throw new HttpError(checked.code === 'offer_overlap' ? 409 : 400, checked.code, checked.message, { errors: checked.errors });
        }
        const value = checked.value;
        const discountAmount = Math.round(value.regularPrice) - Math.round(value.specialPrice);
        Object.assign(offer, value, {
          discountAmount,
          discountRate: Math.round(discountAmount * 100 / Math.round(value.regularPrice)),
          version: Number(offer.version) + 1,
          updatedAt: nowIso(),
          updatedBy: { type: 'partner', email: session.account.email, accountId: session.account.id }
        });
        pushAudit(db, {
          action: 'special-offer.updated',
          actor: partnerActor(req, session),
          courseId: offer.courseId,
          courseName: session.course.name,
          teeTimeId: offer.teeTimeId,
          offerId: offer.id,
          date: offer.roundDate,
          time: offer.time,
          memo: `${offer.name} · ${offer.specialPrice}원(${offer.discountRate}%) · ${offer.paused ? '판매 중지' : '판매 중'}`
        });
        return offer;
      });
      broadcast('catalog.changed', { kind: 'special-offers', courseId: String(result.courseId), date: result.roundDate, at: nowIso() });
      const db = store.read();
      http.sendJson(res, 200, { ok: true, mode: 'server', offer: operations.offerForPartner(db, result), dataMode: 'demo' });
      return;
    }

    if (partnerOfferMatch && method === 'DELETE') {
      const id = decodeURIComponent(partnerOfferMatch[1]);
      const { result } = await store.update(db => {
        const session = partnerSession(req, { db, write: true });
        const offer = (db.specialOffers || []).find(item => String(item.id) === id);
        if (!offer || offer.deletedAt) throw new HttpError(404, 'offer_not_found', '특가를 찾을 수 없습니다.');
        if (String(offer.courseId) !== String(session.account.courseId)) {
          throw new HttpError(403, 'forbidden_course', '다른 골프장의 특가는 삭제할 수 없습니다.');
        }
        offer.deletedAt = nowIso();
        offer.paused = true;
        offer.visible = false;
        offer.updatedAt = offer.deletedAt;
        offer.version = Number(offer.version) + 1;
        pushAudit(db, {
          action: 'special-offer.deleted',
          actor: partnerActor(req, session),
          courseId: offer.courseId,
          courseName: session.course.name,
          teeTimeId: offer.teeTimeId,
          offerId: offer.id,
          date: offer.roundDate,
          time: offer.time,
          memo: `${offer.name} 삭제(기록 보존)`
        });
        return offer;
      });
      broadcast('catalog.changed', { kind: 'special-offers', courseId: String(result.courseId), date: result.roundDate, at: nowIso() });
      http.sendJson(res, 200, { ok: true, mode: 'server', deleted: result.id, softDeleted: true, dataMode: 'demo' });
      return;
    }

    if (pathname === '/api/events' && method === 'GET') {
      const client = http.openSse(res);
      sseClients.add(client);
      client.send('hello', { at: nowIso(), mode: 'server', stage: 7 });
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
