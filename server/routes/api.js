'use strict';
/* ALL:GOLF API (8단계: 서버 예약·원자적 재고·취소/환불)
   공개: 건강 확인, 제휴 신청, 승인 골프장, 공개 카탈로그, 임시확보(Hold)·예약 확정·조회·취소
   본사 관리자: 로그인, 신청 승인·반려, 담당자 계정, 골프장 운영 현황, 전체 예약·취소·환불
   골프장 담당자: 로그인/로그아웃, 자기 골프장의 티타임·요금·특가·예약 (서버 세션의 courseId 로만 식별)
   - 예약 재고 검증·차감은 store.update(파일 잠금) 안에서 처리해 중복 예약(Overbooking)을 409 로 막는다.
   - 브라우저에서 courseId 를 바꿔도 다른 골프장 데이터에는 접근할 수 없다(서버가 403). */

const crypto = require('crypto');
const path = require('path');
const domain = require('../lib/domain');
const operations = require('../lib/operations');
const analytics = require('../lib/analytics');
const accounts = require('../lib/accounts');
const reservations = require('../lib/reservations');
const demoStage10 = require('../lib/demo-stage10');
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

  /* 8단계: 예약·재고 변경을 모든 화면(SSE)에 알린다. */
  function broadcastInventory(courseId, date, teeTimeId) {
    broadcast('inventory.changed', { courseId: String(courseId), date, teeTimeId: String(teeTimeId || ''), at: nowIso() });
  }
  function broadcastReservation(event, payload) {
    broadcast('reservations.changed', { event, ...(payload || {}), at: nowIso() });
  }

  /* 9단계: 예약·정산 이벤트를 시연용 알림 로그로 남긴다(실제 문자·푸시 아님). */
  function recordReservationNotice(db, reservation, event) {
    try {
      analytics.notifyReservation(db, reservation, event);
    } catch (error) {
      console.error('[ALL:GOLF] 알림 로그 기록 실패:', error && error.message);
    }
  }

  /* 예약 번호·연락처 조회와 취소 요청의 무차별 시도 제한(IP + 예약번호). */
  const reservationGuard = new Map();
  function reservationLookupLimit(ip, key) {
    const guardKey = `${ip}:${key}`;
    const now = Date.now();
    const record = reservationGuard.get(guardKey);
    if (!record || now - record.firstAt > 10 * 60 * 1000) {
      reservationGuard.set(guardKey, { count: 1, firstAt: now });
      return { ok: true };
    }
    record.count += 1;
    if (record.count > 20) return { ok: false, retryAfter: Math.ceil((record.firstAt + 10 * 60 * 1000 - now) / 1000) };
    return { ok: true };
  }

  function reservationStatsFor(db, options) {
    return reservations.statsFor(db, options || {});
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
      let db = { applications: [], approvedCourses: [], auditLogs: [], partnerAccounts: [], teeTimes: [], specialOffers: [], reservations: [], bookingHolds: [], meta: { revision: 0 } };
      try { db = store.read(); } catch (error) {
        http.sendError(res, 500, error.code || 'db_error', error.message);
        return;
      }
      http.sendJson(res, 200, {
        ok: true,
        name: config.serverName,
        version: config.version,
        stage: 10,
        stages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        time: nowIso(),
        uptimeSec: Math.round(process.uptime()),
        auth: { configured: !config.usingDefaultPassword, mode: config.usingDefaultPassword ? 'demo-default-password' : 'env', partnerAccounts: true },
        db: {
          persistent: true,
          schemaVersion: db.version || 3,
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
          reservations: (db.reservations || []).length,
          confirmedReservations: (db.reservations || []).filter(item => item.status === 'confirmed').length,
          activeHolds: (db.bookingHolds || []).filter(item => item.status === 'active').length,
          auditLogs: db.auditLogs.length,
          commissionRates: Object.keys(db.commissionRates || {}).length,
          settlements: (db.settlements || []).length,
          notificationLogs: (db.notificationLogs || []).length,
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
          publicCatalog: true,
          reservations: true,
          holds: true,
          inventoryLinked: true,
          idempotency: true,
          refunds: true,
          analytics: true,
          settlements: true,
          commissions: true,
          notifications: true,
          demoStage: true,
          demoReset: true
        },
        hold: { ttlSec: Math.round(config.holdTtlMs / 1000), maxPerSession: config.maxHoldsPerSession },
        settlement: {
          statuses: analytics.SETTLEMENT_STATUSES,
          defaultCommissionPercent: analytics.DEFAULT_COMMISSION_PERCENT,
          commissionRange: [analytics.COMMISSION_MIN_PERCENT, analytics.COMMISSION_MAX_PERCENT]
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
        const counts = operations.inventoryFor(db);
        const teeTimes = serverTimes
          .slice()
          .sort((a, b) => String(a.time).localeCompare(String(b.time)))
          .map(item => operations.publicTeeTime(db, item, rates, offers, counts));
        http.sendJson(res, 200, {
          ok: true, mode: 'server', source: 'server', courseId, date, count: teeTimes.length, teeTimes,
          inventoryLinked: true, dataMode: 'demo'
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

    /* --- 8단계: 공개 재고 · 임시확보(Hold) · 예약 -------------------------- */

    /* 날짜별 티타임 잔여 팀(서버 예약·Hold 기준). 다른 기기와 공유되는 실시간 재고. */
    if (pathname === '/api/public/inventory' && method === 'GET') {
      const date = String(query.get('date') || operations.todayKst());
      if (!domain.isValidDate(date)) throw new HttpError(400, 'invalid_date', 'date 는 YYYY-MM-DD 형식이어야 합니다.');
      const courseId = String(query.get('courseId') || '').trim();
      const db = store.read();
      const counts = operations.inventoryFor(db);
      const courses = [...new Set((db.teeTimes || [])
        .filter(item => item.date === date && (!courseId || String(item.courseId) === courseId))
        .map(item => String(item.courseId)))]
        .map(id => {
          const rates = operations.effectiveRates(db, id);
          const offers = (db.specialOffers || []).filter(offer => String(offer.courseId) === id && offer.roundDate === date && !offer.deletedAt);
          const teeTimes = (db.teeTimes || [])
            .filter(item => String(item.courseId) === id && item.date === date)
            .sort((a, b) => String(a.time).localeCompare(String(b.time)))
            .map(item => operations.publicTeeTime(db, item, rates, offers, counts));
          return { courseId: id, courseName: (db.approvedCourses.find(course => String(course.id) === id) || {}).name || null, teeTimes };
        });
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        date,
        inventoryLinked: true,
        activeHolds: (db.bookingHolds || []).filter(hold => hold.status === 'active').length,
        courses,
        serverTime: nowIso()
      });
      return;
    }

    /* 임시확보(Hold): 5분간 1팀을 잡아 둔다. 만료되면 자동으로 잔여 팀이 복구된다. */
    if (pathname === '/api/public/holds' && method === 'POST') {
      const body = await http.readJson(req);
      const ip = http.clientIp(req);
      const sessionId = String(body.sessionId || req.headers['x-booking-session'] || '').slice(0, 120);
      const { result } = await store.update(db => {
        const outcome = reservations.createHold(db, { ...body, sessionId }, {
          ttlMs: config.holdTtlMs,
          maxHoldsPerSession: config.maxHoldsPerSession,
          ip
        });
        if (!outcome.ok) {
          throw new HttpError(outcome.code === 'sold_out' ? 409 : 400, outcome.code, outcome.message);
        }
        const counts = operations.inventoryFor(db);
        return {
          reused: outcome.reused,
          hold: outcome.hold,
          tee: operations.teeTimeForPartner(outcome.tee, operations.effectiveRates(db, outcome.tee.courseId), counts)
        };
      });
      if (!result.reused) broadcastInventory(result.hold.courseId, result.hold.date, result.hold.teeTimeId);
      http.sendJson(res, result.reused ? 200 : 201, {
        ok: true,
        mode: 'server',
        reused: result.reused,
        hold: reservations.holdView(result.hold),
        tee: result.tee,
        inventoryLinked: true,
        dataMode: 'demo'
      });
      return;
    }

    const publicHoldMatch = pathname.match(/^\/api\/public\/holds\/([^/]+)$/);
    if (publicHoldMatch && (method === 'DELETE' || method === 'POST')) {
      const holdId = decodeURIComponent(publicHoldMatch[1]);
      const body = method === 'POST' ? await http.readJson(req).catch(() => ({})) : {};
      const sessionId = String(body.sessionId || query.get('sessionId') || req.headers['x-booking-session'] || '');
      const { result } = await store.update(db => {
        const outcome = reservations.releaseHold(db, holdId, sessionId);
        if (!outcome.ok) throw new HttpError(outcome.code === 'forbidden_hold' ? 403 : 404, outcome.code, outcome.message);
        return outcome.hold;
      });
      broadcastInventory(result.courseId, result.date, result.teeTimeId);
      http.sendJson(res, 200, { ok: true, mode: 'server', released: result.id, inventoryLinked: true });
      return;
    }

    /* 예약 확정: Hold 또는 즉석 예약. 재고 검증·차감은 Lock 안에서 원자적으로 처리. */
    if (pathname === '/api/public/reservations' && method === 'POST') {
      const body = await http.readJson(req);
      const ip = http.clientIp(req);
      const headerKey = req.headers['idempotency-key'];
      const idempotencyHash = reservations.hashIdempotencyKey(headerKey || body.idempotencyKey);
      const sessionId = String(body.sessionId || req.headers['x-booking-session'] || '').slice(0, 120);
      const { result } = await store.update(db => {
        reservations.sweepExpiredHolds(db);
        if (idempotencyHash) {
          const existing = reservations.findByIdempotency(db, idempotencyHash, sessionId);
          if (existing) return { idempotent: true, reservation: existing };
        }
        const outcome = reservations.createReservation(db, body, {
          sessionId,
          holdId: body.holdId || null,
          idempotencyHash,
          ip
        });
        if (!outcome.ok) {
          throw new HttpError(outcome.status || 400, outcome.code, outcome.message, outcome.errors ? { errors: outcome.errors } : undefined);
        }
        const reservation = outcome.reservation;
        pushAudit(db, {
          action: 'reservation.created',
          courseId: reservation.courseId,
          courseName: reservation.courseName,
          reservationNumber: reservation.number,
          teeTimeId: reservation.teeTimeId,
          date: reservation.date,
          time: reservation.time,
          actor: { type: 'customer', email: null, ip },
          memo: `${reservation.number} · ${reservation.people}명 · 예약금 ${reservation.paidDeposit}원`
        });
        recordReservationNotice(db, reservation, 'reservation.confirmed');
        return { idempotent: false, reservation };
      });
      const reservation = result.reservation;
      const fresh = store.read();
      const tee = operations.findTeeTime(fresh, reservation.teeTimeId);
      const counts = operations.inventoryFor(fresh);
      if (!result.idempotent) {
        broadcastReservation('created', { number: reservation.number, courseId: reservation.courseId, date: reservation.date });
        broadcastInventory(reservation.courseId, reservation.date, reservation.teeTimeId);
      }
      http.sendJson(res, result.idempotent ? 200 : 201, {
        ok: true,
        mode: 'server',
        idempotent: result.idempotent,
        reservation: reservations.publicReservation(reservation, { verified: true }),
        inventory: tee ? { teeTimeId: tee.id, remaining: operations.remainingTeams(tee, counts), capacityTeams: tee.capacityTeams } : null,
        inventoryLinked: true,
        dataMode: 'demo'
      });
      return;
    }

    /* 같은 연락처의 서버 예약 목록(여러 기기에서 동일하게 조회). */
    if (pathname === '/api/public/reservations' && method === 'GET') {
      const ip = http.clientIp(req);
      const phone = reservations.digits(query.get('phone'));
      if (phone.length < 10) throw new HttpError(400, 'phone_required', '예약자 휴대전화번호를 입력해주세요.');
      const guard = reservationLookupLimit(ip, `list:${phone}`);
      if (!guard.ok) throw new HttpError(429, 'rate_limited', `조회 시도가 너무 많습니다. ${guard.retryAfter}초 후 다시 시도해주세요.`, { retryAfter: guard.retryAfter });
      const db = store.read();
      const items = (db.reservations || [])
        .filter(item => reservations.ownsReservation(item, phone))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 50);
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        count: items.length,
        reservations: items.map(item => reservations.publicReservation(item, { verified: true })),
        inventoryLinked: true,
        dataMode: 'demo'
      });
      return;
    }

    /* 고객 예약 취소: 본인 연락처 확인 후 상태 전이·환불 계산·재고 복구 */
    const publicCancelMatch = pathname.match(/^\/api\/public\/reservations\/([^/]+)\/cancel$/);
    if (publicCancelMatch && method === 'POST') {
      const reference = decodeURIComponent(publicCancelMatch[1]);
      const body = await http.readJson(req);
      const ip = http.clientIp(req);
      const guard = reservationLookupLimit(ip, `cancel:${reference}`);
      if (!guard.ok) throw new HttpError(429, 'rate_limited', `요청이 너무 많습니다. ${guard.retryAfter}초 후 다시 시도해주세요.`, { retryAfter: guard.retryAfter });
      const phone = reservations.digits(body.phone || query.get('phone'));
      const reason = domain.text(body.reason).slice(0, 200) || '사용자 취소';
      const { result } = await store.update(db => {
        reservations.sweepExpiredHolds(db);
        const reservation = reservations.findReservation(db, reference);
        if (!reservation) throw new HttpError(404, 'reservation_not_found', '예약을 찾을 수 없습니다. 예약번호를 확인해주세요.');
        if (!reservations.ownsReservation(reservation, phone)) {
          throw new HttpError(403, 'lookup_failed', '예약자 연락처가 일치하지 않습니다.');
        }
        const outcome = reservations.cancelReservation(db, reservation, {
          by: { type: 'customer', email: null, ip },
          reason
        });
        if (!outcome.ok) {
          throw new HttpError(outcome.status || 409, outcome.code, outcome.message, outcome.refund ? { refund: outcome.refund } : undefined);
        }
        if (!outcome.alreadyCancelled) {
          pushAudit(db, {
            action: 'reservation.cancelled',
            courseId: reservation.courseId,
            courseName: reservation.courseName,
            reservationNumber: reservation.number,
            teeTimeId: reservation.teeTimeId,
            date: reservation.date,
            time: reservation.time,
            actor: { type: 'customer', email: null, ip },
            memo: `${reservation.number} · ${outcome.refund.refundRate}% 환불(수수료 ${outcome.refund.cancellationFee}원)`
          });
          recordReservationNotice(db, reservation, 'reservation.cancelled');
        }
        return outcome;
      });
      if (!result.alreadyCancelled) {
        broadcastReservation('cancelled', { number: result.reservation.number, courseId: result.reservation.courseId, date: result.reservation.date });
        broadcastInventory(result.reservation.courseId, result.reservation.date, result.reservation.teeTimeId);
      }
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        alreadyCancelled: Boolean(result.alreadyCancelled),
        reservation: reservations.publicReservation(result.reservation, { verified: true }),
        refund: result.refund || null,
        inventoryLinked: true
      });
      return;
    }

    /* 고객 예약 상세: 예약번호 + 연락처 */
    const publicReservationMatch = pathname.match(/^\/api\/public\/reservations\/([^/]+)$/);
    if (publicReservationMatch && method === 'GET') {
      const reference = decodeURIComponent(publicReservationMatch[1]);
      const ip = http.clientIp(req);
      const guard = reservationLookupLimit(ip, `view:${reference}`);
      if (!guard.ok) throw new HttpError(429, 'rate_limited', `조회 시도가 너무 많습니다. ${guard.retryAfter}초 후 다시 시도해주세요.`, { retryAfter: guard.retryAfter });
      const phone = reservations.digits(query.get('phone'));
      if (phone.length < 10) throw new HttpError(400, 'phone_required', '예약자 휴대전화번호를 입력해주세요.');
      const db = store.read();
      const reservation = reservations.findReservation(db, reference);
      if (!reservation) throw new HttpError(404, 'reservation_not_found', '예약을 찾을 수 없습니다. 예약번호를 확인해주세요.');
      if (!reservations.ownsReservation(reservation, phone)) {
        throw new HttpError(403, 'lookup_failed', '예약자 연락처가 일치하지 않습니다.');
      }
      const quote = reservations.cancellationQuote(reservation, operations.effectiveRates(db, reservation.courseId).cancellationPolicy);
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        reservation: reservations.publicReservation(reservation, { verified: true }),
        cancellationQuote: quote,
        inventoryLinked: true,
        dataMode: 'demo'
      });
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
        const courseReservations = (db.reservations || []).filter(item => String(item.courseId) === courseId);
        const dayReservations = courseReservations.filter(item => item.date === date && item.status === 'confirmed');
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
          reservations: {
            total: courseReservations.length,
            date: dayReservations.length,
            peopleOnDate: dayReservations.reduce((sum, item) => sum + Number(item.people || 0), 0),
            cancelled: courseReservations.filter(item => item.status === 'cancelled').length,
            refundAmount: courseReservations.reduce((sum, item) => sum + Number(item.refundAmount || 0), 0)
          },
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
          activeAccounts: (db.partnerAccounts || []).filter(item => item.status === 'active').length,
          reservations: (db.reservations || []).length,
          reservationsOnDate: (db.reservations || []).filter(item => item.date === date && item.status === 'confirmed').length,
          activeHolds: (db.bookingHolds || []).filter(item => item.status === 'active').length
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
      const counts = operations.inventoryFor(db);
      const items = (db.teeTimes || [])
        .filter(item => (!courseId || String(item.courseId) === courseId) && (!date || item.date === date))
        .sort((a, b) => `${a.date} ${a.courseId} ${a.time}`.localeCompare(`${b.date} ${b.courseId} ${b.time}`))
        .map(item => {
          if (!ratesCache.has(String(item.courseId))) ratesCache.set(String(item.courseId), operations.effectiveRates(db, item.courseId));
          return {
            ...operations.teeTimeForPartner(item, ratesCache.get(String(item.courseId)), counts),
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
          reservations: (db.reservations || []).length,
          confirmedReservations: (db.reservations || []).filter(item => item.status === 'confirmed').length,
          cancelledReservations: (db.reservations || []).filter(item => item.status === 'cancelled').length,
          activeHolds: (db.bookingHolds || []).filter(item => item.status === 'active').length,
          reservationStats: reservationStatsFor(db, {}),
          auditLogs: db.auditLogs.length,
          lastUpdated: db.meta.updatedAt
        },
        mode: 'server'
      });
      return;
    }

    /* --- 8단계: 본사 관리자의 전체 예약·취소·환불 -------------------------- */
    if (pathname === '/api/admin/reservations' && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      const courseId = String(query.get('courseId') || '');
      const date = String(query.get('date') || '');
      const from = String(query.get('from') || '');
      const to = String(query.get('to') || '');
      const status = String(query.get('status') || '');
      const q = String(query.get('q') || '').trim().toLowerCase();
      [date, from, to].filter(Boolean).forEach(value => {
        if (!domain.isValidDate(value)) throw new HttpError(400, 'invalid_date', '날짜는 YYYY-MM-DD 형식이어야 합니다.');
      });
      let items = (db.reservations || []).slice();
      if (courseId) items = items.filter(item => String(item.courseId) === courseId);
      if (date) items = items.filter(item => item.date === date);
      if (from) items = items.filter(item => item.date >= from);
      if (to) items = items.filter(item => item.date <= to);
      if (reservations.RESERVATION_STATUSES.includes(status)) items = items.filter(item => item.status === status);
      if (q) items = items.filter(item => `${item.number} ${item.booker} ${item.phone} ${item.courseName || ''} ${item.time}`.toLowerCase().includes(q));
      items = items.slice().sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        count: items.length,
        stats: reservationStatsFor(db, { courseId: courseId || null }),
        activeHolds: (db.bookingHolds || []).filter(hold => hold.status === 'active').length,
        reservations: items.map(item => reservations.partnerReservation(db, item)),
        inventoryLinked: true,
        dataMode: 'demo'
      });
      return;
    }

    const adminReservationMatch = pathname.match(/^\/api\/admin\/reservations\/([^/]+)$/);
    if (adminReservationMatch && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      const reservation = reservations.findReservation(db, decodeURIComponent(adminReservationMatch[1]));
      if (!reservation) throw new HttpError(404, 'reservation_not_found', '예약을 찾을 수 없습니다.');
      http.sendJson(res, 200, { ok: true, mode: 'server', reservation: reservations.partnerReservation(db, reservation), dataMode: 'demo' });
      return;
    }

    const adminReservationStatusMatch = pathname.match(/^\/api\/admin\/reservations\/([^/]+)\/status$/);
    if (adminReservationStatusMatch && method === 'POST') {
      const admin = requireAdmin(req);
      const id = decodeURIComponent(adminReservationStatusMatch[1]);
      const body = await http.readJson(req);
      const nextStatus = String(body.status || '');
      const reason = domain.text(body.reason).slice(0, 200);
      if (!['confirmed', 'completed', 'no_show', 'cancelled'].includes(nextStatus)) {
        throw new HttpError(400, 'invalid_status', '변경할 수 없는 예약 상태입니다.');
      }
      if (nextStatus === 'cancelled' && !reason) {
        throw new HttpError(400, 'reason_required', '취소 사유를 입력해주세요.');
      }
      const { result } = await store.update(db => {
        const reservation = reservations.findReservation(db, id);
        if (!reservation) throw new HttpError(404, 'reservation_not_found', '예약을 찾을 수 없습니다.');
        if (body.version != null && Number(body.version) !== Number(reservation.version)) {
          throw new HttpError(409, 'version_conflict', '다른 곳에서 먼저 변경했습니다. 새로고침 후 다시 시도해주세요.', {
            current: reservations.partnerReservation(db, reservation)
          });
        }
        const actor = adminActor(req, admin.payload);
        let outcome;
        if (nextStatus === 'cancelled') {
          outcome = reservations.cancelReservation(db, reservation, { by: actor, reason, force: true });
        } else {
          outcome = reservations.updateReservationStatus(db, reservation, nextStatus, { by: actor, reason });
        }
        if (!outcome.ok) {
          throw new HttpError(outcome.status || 409, outcome.code, outcome.message, outcome.refund ? { refund: outcome.refund } : undefined);
        }
        if (outcome.changed !== false && !outcome.alreadyCancelled) {
          pushAudit(db, {
            action: nextStatus === 'cancelled' ? 'reservation.cancelled' : 'reservation.status-updated',
            courseId: reservation.courseId,
            courseName: reservation.courseName,
            reservationNumber: reservation.number,
            teeTimeId: reservation.teeTimeId,
            date: reservation.date,
            time: reservation.time,
            actor,
            memo: `${reservation.number} · ${reservations.statusLabel(nextStatus)} · ${reason || '관리자 처리'}`
          });
          if (nextStatus === 'cancelled') recordReservationNotice(db, reservation, 'reservation.cancelled');
        }
        return outcome;
      });
      broadcastReservation('admin-updated', { number: result.reservation.number, courseId: result.reservation.courseId, date: result.reservation.date });
      broadcastInventory(result.reservation.courseId, result.reservation.date, result.reservation.teeTimeId);
      const db = store.read();
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        changed: result.changed !== false && !result.alreadyCancelled,
        reservation: reservations.partnerReservation(db, reservations.findReservation(db, id)),
        refund: result.refund || null,
        inventoryLinked: true,
        dataMode: 'demo'
      });
      return;
    }

    /* --- 9단계: 본사 운영 통계 · 제휴 성과 --------------------------------- */
    if (pathname === '/api/admin/analytics' && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      const period = String(query.get('period') || analytics.DEFAULT_PERIOD);
      const payload = analytics.analyticsFor(db, { period, courseId: String(query.get('courseId') || '') });
      if (String(query.get('format') || '').toLowerCase() === 'csv') {
        const csv = `\uFEFF${analytics.analyticsCsv(payload)}`;
        const stamp = new Date().toISOString().slice(0, 10);
        res.writeHead(200, http.baseHeaders({
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Length': Buffer.byteLength(csv),
          'Content-Disposition': `attachment; filename="allgolf-analytics-${payload.period.key}-${stamp}.csv"`,
          'Cache-Control': 'no-store'
        }));
        res.end(csv);
        return;
      }
      http.sendJson(res, 200, payload);
      return;
    }

    if (pathname === '/api/admin/commissions' && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      const courses = analytics.commissionList(db);
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        dataMode: 'demo',
        defaultRatePercent: analytics.DEFAULT_COMMISSION_PERCENT,
        minPercent: analytics.COMMISSION_MIN_PERCENT,
        maxPercent: analytics.COMMISSION_MAX_PERCENT,
        count: courses.length,
        courses,
        note: '수수료율은 골프장별로 0~30% 범위에서 설정합니다. 기본값은 8%이며 정산서 생성 시점의 수수료율이 정산서에 기록됩니다.'
      });
      return;
    }

    const commissionMatch = pathname.match(/^\/api\/admin\/commissions\/([^/]+)$/);
    if (commissionMatch && (method === 'PUT' || method === 'PATCH')) {
      const admin = requireAdmin(req);
      const courseId = decodeURIComponent(commissionMatch[1]);
      const body = await http.readJson(req);
      const { result } = await store.update(db => {
        const course = (db.approvedCourses || []).find(item => String(item.id) === String(courseId));
        if (!course) throw new HttpError(404, 'course_not_found', '제휴 승인된 골프장을 찾을 수 없습니다.');
        const current = analytics.commissionFor(db, courseId);
        if (body.version != null && Number(body.version) !== Number(current.version)) {
          throw new HttpError(409, 'version_conflict', '다른 곳에서 먼저 수수료율을 수정했습니다. 새로고침 후 다시 시도해주세요.', { current });
        }
        const checked = analytics.validateCommission(body);
        if (!checked.ok) throw new HttpError(400, 'validation_failed', checked.message, { errors: checked.errors });
        const at = nowIso();
        db.commissionRates = db.commissionRates && typeof db.commissionRates === 'object' ? db.commissionRates : {};
        db.commissionRates[String(courseId)] = {
          courseId: String(courseId),
          ratePercent: checked.value.ratePercent,
          version: Number(current.version || 0) + 1,
          updatedAt: at,
          updatedBy: { type: 'admin', email: admin.payload.email },
          dataMode: 'demo'
        };
        pushAudit(db, {
          action: 'commission.updated',
          actor: adminActor(req, admin.payload),
          courseId: String(courseId),
          courseName: course.name,
          memo: `수수료율 ${current.ratePercent}% → ${checked.value.ratePercent}%`
        });
        return analytics.commissionFor(db, courseId);
      });
      broadcast('commissions.changed', { courseId: String(courseId), ratePercent: result.ratePercent, at: nowIso() });
      http.sendJson(res, 200, { ok: true, mode: 'server', commission: result, dataMode: 'demo' });
      return;
    }

    /* --- 9단계: 정산서 생성·상태 전이 -------------------------------------- */
    if (pathname === '/api/admin/settlements' && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      const status = String(query.get('status') || '').toUpperCase();
      const courseId = String(query.get('courseId') || '');
      const from = String(query.get('from') || '');
      const to = String(query.get('to') || '');
      [from, to].filter(Boolean).forEach(value => {
        if (!domain.isValidDate(value)) throw new HttpError(400, 'invalid_date', '날짜는 YYYY-MM-DD 형식이어야 합니다.');
      });
      let items = (db.settlements || []).slice();
      if (status) items = items.filter(item => item.status === status);
      if (courseId) items = items.filter(item => String(item.courseId) === courseId);
      if (from) items = items.filter(item => item.period && item.period.to >= from);
      if (to) items = items.filter(item => item.period && item.period.from <= to);
      items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const byStatus = {};
      analytics.SETTLEMENT_STATUSES.forEach(key => { byStatus[key] = items.filter(item => item.status === key).length; });
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        dataMode: 'demo',
        count: items.length,
        byStatus,
        statuses: analytics.SETTLEMENT_STATUSES.map(key => ({ status: key, label: analytics.SETTLEMENT_STATUS_LABELS[key] })),
        totals: {
          basisAmount: items.reduce((total, item) => total + Number(item.basisAmount || 0), 0),
          platformFee: items.reduce((total, item) => total + Number(item.platformFee || 0), 0),
          payoutAmount: items.reduce((total, item) => total + Number(item.payoutAmount || 0), 0),
          paid: items.filter(item => item.status === 'PAID').reduce((total, item) => total + Number(item.payoutAmount || 0), 0)
        },
        settlements: items.map(item => analytics.settlementView(item)),
        note: analytics.SIMULATION_NOTE
      });
      return;
    }

    if (pathname === '/api/admin/settlements/export' && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      const courseId = String(query.get('courseId') || '');
      let items = (db.settlements || []).slice();
      if (courseId) items = items.filter(item => String(item.courseId) === courseId);
      items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const csv = `\uFEFF${analytics.settlementsCsv(items)}`;
      res.writeHead(200, http.baseHeaders({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Length': Buffer.byteLength(csv),
        'Content-Disposition': `attachment; filename="allgolf-settlements-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store'
      }));
      res.end(csv);
      return;
    }

    if (pathname === '/api/admin/settlements' && method === 'POST') {
      const admin = requireAdmin(req);
      const body = await http.readJson(req);
      const { result } = await store.update(db => {
        const outcome = analytics.createSettlement(db, {
          courseId: body.courseId,
          from: body.from,
          to: body.to,
          status: body.status,
          note: domain.text(body.note).slice(0, 200),
          actor: adminActor(req, admin.payload)
        });
        if (!outcome.ok) throw new HttpError(outcome.status || 400, outcome.code, outcome.message, outcome.details);
        pushAudit(db, {
          action: 'settlement.created',
          actor: adminActor(req, admin.payload),
          courseId: outcome.settlement.courseId,
          courseName: outcome.settlement.courseName,
          settlementId: outcome.settlement.id,
          settlementNumber: outcome.settlement.number,
          memo: `${outcome.settlement.number} · ${outcome.settlement.period.from}~${outcome.settlement.period.to} · 정산 예정 ${outcome.settlement.payoutAmount}원 · ${analytics.SETTLEMENT_STATUS_LABELS[outcome.settlement.status]}`
        });
        return outcome.settlement;
      });
      broadcast('settlements.changed', { event: 'created', settlementId: result.id, at: nowIso() });
      http.sendJson(res, 201, { ok: true, mode: 'server', settlement: analytics.settlementView(result), dataMode: 'demo', note: analytics.SIMULATION_NOTE });
      return;
    }

    const settlementTransitionMatch = pathname.match(/^\/api\/admin\/settlements\/([^/]+)\/transition$/);
    if (settlementTransitionMatch && method === 'POST') {
      const admin = requireAdmin(req);
      const id = decodeURIComponent(settlementTransitionMatch[1]);
      const body = await http.readJson(req);
      const { result } = await store.update(db => {
        const settlement = (db.settlements || []).find(item => String(item.id) === id || String(item.number) === id);
        if (!settlement) throw new HttpError(404, 'settlement_not_found', '정산서를 찾을 수 없습니다.');
        if (body.version != null && Number(body.version) !== Number(settlement.version)) {
          throw new HttpError(409, 'version_conflict', '다른 곳에서 먼저 변경했습니다. 새로고침 후 다시 시도해주세요.', { current: analytics.settlementView(settlement) });
        }
        const outcome = analytics.transitionSettlement(settlement, body.status, {
          actor: adminActor(req, admin.payload),
          note: domain.text(body.note).slice(0, 200)
        });
        if (!outcome.ok) throw new HttpError(outcome.status || 409, outcome.code, outcome.message, outcome.details);
        pushAudit(db, {
          action: `settlement.${settlement.status.toLowerCase()}`,
          actor: adminActor(req, admin.payload),
          courseId: settlement.courseId,
          courseName: settlement.courseName,
          settlementId: settlement.id,
          settlementNumber: settlement.number,
          memo: `${settlement.number} · ${analytics.SETTLEMENT_STATUS_LABELS[settlement.status]} · ${settlement.period.from}~${settlement.period.to} · ${settlement.payoutAmount}원`
        });
        if (settlement.status === 'CONFIRMED' || settlement.status === 'PAID') {
          try { analytics.notifySettlement(db, settlement, settlement.status); } catch (error) { console.error('[ALL:GOLF] 정산 알림 기록 실패:', error && error.message); }
        }
        return settlement;
      });
      broadcast('settlements.changed', { event: result.status.toLowerCase(), settlementId: result.id, at: nowIso() });
      http.sendJson(res, 200, { ok: true, mode: 'server', settlement: analytics.settlementView(result), dataMode: 'demo', note: analytics.SIMULATION_NOTE });
      return;
    }

    const adminSettlementMatch = pathname.match(/^\/api\/admin\/settlements\/([^/]+)$/);
    if (adminSettlementMatch && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      const id = decodeURIComponent(adminSettlementMatch[1]);
      const settlement = (db.settlements || []).find(item => String(item.id) === id || String(item.number) === id);
      if (!settlement) throw new HttpError(404, 'settlement_not_found', '정산서를 찾을 수 없습니다.');
      http.sendJson(res, 200, { ok: true, mode: 'server', settlement: analytics.settlementView(settlement), dataMode: 'demo', note: analytics.SIMULATION_NOTE });
      return;
    }

    /* --- 9단계: 운영 알림 시뮬레이션 로그(본사) ---------------------------- */
    if (pathname === '/api/admin/notifications' && method === 'GET') {
      requireAdmin(req);
      const db = store.read();
      http.sendJson(res, 200, analytics.notificationsFor(db, {
        courseId: String(query.get('courseId') || ''),
        event: String(query.get('event') || ''),
        limit: query.get('limit')
      }));
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
        reservations: (() => {
          const items = (db.reservations || []).filter(item => String(item.courseId) === courseId);
          const todayItems = items.filter(item => item.date === today && item.status === 'confirmed');
          return {
            source: 'server',
            linked: true,
            count: items.length,
            today: todayItems.length,
            upcoming: items.filter(item => item.date >= today && item.status === 'confirmed').length,
            cancelled: items.filter(item => item.status === 'cancelled').length,
            refundAmount: items.reduce((sum, item) => sum + Number(item.refundAmount || 0), 0),
            note: '서버 예약입니다. 잔여 팀은 확정 예약과 진행 중 임시확보를 함께 계산합니다(시연용).'
          };
        })(),
        inventory: {
          linked: true,
          activeHolds: (db.bookingHolds || []).filter(hold => String(hold.courseId) === courseId && hold.status === 'active').length
        },
        /* 9단계: 본인 골프장 정산·수수료 요약(조회 전용) */
        settlement: (() => {
          const items = (db.settlements || []).filter(item => String(item.courseId) === courseId);
          const commission = analytics.commissionFor(db, courseId);
          return {
            commissionRatePercent: commission.ratePercent,
            commissionSource: commission.source,
            count: items.length,
            confirmed: items.filter(item => item.status === 'CONFIRMED').length,
            paid: items.filter(item => item.status === 'PAID').length,
            payoutAmount: items.filter(item => ['CONFIRMED', 'PAID'].includes(item.status)).reduce((total, item) => total + Number(item.payoutAmount || 0), 0)
          };
        })(),
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
      const counts = operations.inventoryFor(session.db);
      const items = (session.db.teeTimes || [])
        .filter(item => String(item.courseId) === courseId
          && (!date || item.date === date)
          && (!from || item.date >= from)
          && (!to || item.date <= to))
        .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
        .map(item => operations.teeTimeForPartner(item, rates, counts));
      http.sendJson(res, 200, {
        ok: true, mode: 'server', courseId, date: date || null, count: items.length, teeTimes: items,
        inventoryLinked: true, updatedAt: session.db.meta.updatedAt, dataMode: 'demo'
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
        teeTime: operations.teeTimeForPartner(result, operations.effectiveRates(db, result.courseId), operations.inventoryFor(db)),
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
        teeTimes: result.created.map(item => operations.teeTimeForPartner(item, rates, operations.inventoryFor(db))),
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
            current: operations.teeTimeForPartner(tee, operations.effectiveRates(db, tee.courseId), operations.inventoryFor(db))
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
        teeTime: operations.teeTimeForPartner(result, operations.effectiveRates(db, result.courseId), operations.inventoryFor(db)),
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

    /* --- 8단계: 골프장 담당자의 서버 예약 조회·상태 처리 -------------------- */
    if (pathname === '/api/partner/reservations' && method === 'GET') {
      const session = partnerSession(req);
      assertOwnCourse(query.get('courseId'), session.account);
      const courseId = String(session.account.courseId);
      const date = String(query.get('date') || '');
      const from = String(query.get('from') || '');
      const to = String(query.get('to') || '');
      const status = String(query.get('status') || '');
      const q = String(query.get('q') || '').trim().toLowerCase();
      [date, from, to].filter(Boolean).forEach(value => {
        if (!domain.isValidDate(value)) throw new HttpError(400, 'invalid_date', '날짜는 YYYY-MM-DD 형식이어야 합니다.');
      });
      const db = session.db;
      let items = (db.reservations || []).filter(item => String(item.courseId) === courseId);
      if (date) items = items.filter(item => item.date === date);
      if (from) items = items.filter(item => item.date >= from);
      if (to) items = items.filter(item => item.date <= to);
      if (reservations.RESERVATION_STATUSES.includes(status)) items = items.filter(item => item.status === status);
      if (q) items = items.filter(item => `${item.number} ${item.booker} ${item.phone} ${item.time} ${item.courseName || ''}`.toLowerCase().includes(q));
      items = items.slice().sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        courseId,
        count: items.length,
        stats: reservationStatsFor(db, { date: date || null, courseId }),
        reservations: items.map(item => reservations.partnerReservation(db, item)),
        inventoryLinked: true,
        dataMode: 'demo'
      });
      return;
    }

    const partnerReservationMatch = pathname.match(/^\/api\/partner\/reservations\/([^/]+)$/);
    if (partnerReservationMatch && method === 'GET') {
      const session = partnerSession(req);
      const id = decodeURIComponent(partnerReservationMatch[1]);
      const reservation = reservations.findReservation(session.db, id);
      if (!reservation) throw new HttpError(404, 'reservation_not_found', '예약을 찾을 수 없습니다.');
      if (String(reservation.courseId) !== String(session.account.courseId)) {
        throw new HttpError(403, 'forbidden_course', '다른 골프장의 예약은 조회할 수 없습니다.');
      }
      http.sendJson(res, 200, { ok: true, mode: 'server', reservation: reservations.partnerReservation(session.db, reservation), dataMode: 'demo' });
      return;
    }

    const partnerReservationStatusMatch = pathname.match(/^\/api\/partner\/reservations\/([^/]+)\/status$/);
    if (partnerReservationStatusMatch && method === 'POST') {
      const id = decodeURIComponent(partnerReservationStatusMatch[1]);
      const body = await http.readJson(req);
      const nextStatus = String(body.status || '');
      const reason = domain.text(body.reason).slice(0, 200);
      const { result } = await store.update(db => {
        const session = partnerSession(req, { db, write: true });
        const reservation = reservations.findReservation(db, id);
        if (!reservation) throw new HttpError(404, 'reservation_not_found', '예약을 찾을 수 없습니다.');
        if (String(reservation.courseId) !== String(session.account.courseId)) {
          throw new HttpError(403, 'forbidden_course', '다른 골프장의 예약은 변경할 수 없습니다.');
        }
        if (body.version != null && Number(body.version) !== Number(reservation.version)) {
          throw new HttpError(409, 'version_conflict', '다른 곳에서 먼저 변경했습니다. 새로고침 후 다시 시도해주세요.', {
            current: reservations.partnerReservation(db, reservation)
          });
        }
        if (!['confirmed', 'completed', 'no_show', 'cancelled'].includes(nextStatus)) {
          throw new HttpError(400, 'invalid_status', '변경할 수 없는 예약 상태입니다.');
        }
        const actor = partnerActor(req, session);
        let outcome;
        if (nextStatus === 'cancelled') {
          /* 골프장이 취소하는 경우 고객 취소 기한 제한을 강제 적용하지 않는다(사유·환불 계산은 기록). */
          outcome = reservations.cancelReservation(db, reservation, {
            by: actor,
            reason: reason || '골프장 취소',
            force: true
          });
        } else {
          outcome = reservations.updateReservationStatus(db, reservation, nextStatus, { by: actor, reason });
        }
        if (!outcome.ok) {
          throw new HttpError(outcome.status || 409, outcome.code, outcome.message, outcome.refund ? { refund: outcome.refund } : undefined);
        }
        if (outcome.changed !== false && !outcome.alreadyCancelled) {
          pushAudit(db, {
            action: nextStatus === 'cancelled' ? 'reservation.cancelled' : 'reservation.status-updated',
            courseId: reservation.courseId,
            courseName: reservation.courseName,
            reservationNumber: reservation.number,
            teeTimeId: reservation.teeTimeId,
            date: reservation.date,
            time: reservation.time,
            actor,
            memo: `${reservation.number} · ${reservations.statusLabel(nextStatus)}${reason ? ` · ${reason}` : ''}`
          });
          if (nextStatus === 'cancelled') recordReservationNotice(db, reservation, 'reservation.cancelled');
        }
        return outcome;
      });
      broadcastReservation('partner-updated', { number: result.reservation.number, courseId: result.reservation.courseId, date: result.reservation.date });
      broadcastInventory(result.reservation.courseId, result.reservation.date, result.reservation.teeTimeId);
      const db = store.read();
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        changed: result.changed !== false && !result.alreadyCancelled,
        reservation: reservations.partnerReservation(db, reservations.findReservation(db, id)),
        refund: result.refund || null,
        inventoryLinked: true,
        dataMode: 'demo'
      });
      return;
    }

    /* --- 9단계: 골프장 담당자 정산·수수료·알림(본인 골프장만) --------------- */
    if (pathname === '/api/partner/settlements' && method === 'GET') {
      const session = partnerSession(req);
      assertOwnCourse(query.get('courseId'), session.account);
      const db = session.db;
      const courseId = String(session.account.courseId);
      const status = String(query.get('status') || '').toUpperCase();
      let items = (db.settlements || []).filter(item => String(item.courseId) === courseId);
      if (status) items = items.filter(item => item.status === status);
      items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const commission = analytics.commissionFor(db, courseId);
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        dataMode: 'demo',
        courseId,
        courseName: session.course.name,
        count: items.length,
        commission: {
          ratePercent: commission.ratePercent,
          source: commission.source,
          defaultRatePercent: analytics.DEFAULT_COMMISSION_PERCENT,
          updatedAt: commission.updatedAt,
          note: '본사가 설정한 골프장별 수수료율입니다. 정산 기준액 × 수수료율이 플랫폼 수수료입니다.'
        },
        totals: {
          basisAmount: items.reduce((total, item) => total + Number(item.basisAmount || 0), 0),
          platformFee: items.reduce((total, item) => total + Number(item.platformFee || 0), 0),
          payoutAmount: items.reduce((total, item) => total + Number(item.payoutAmount || 0), 0),
          paid: items.filter(item => item.status === 'PAID').reduce((total, item) => total + Number(item.payoutAmount || 0), 0)
        },
        settlements: items.map(item => analytics.settlementView(item)),
        note: '조회 전용입니다. 정산서 생성·확정·지급 처리는 본사 관리자만 할 수 있습니다. ' + analytics.SIMULATION_NOTE
      });
      return;
    }

    if (pathname === '/api/partner/settlements' && method === 'POST') {
      partnerSession(req);
      throw new HttpError(403, 'forbidden_role', '정산서 생성은 본사 관리자만 할 수 있습니다. 정산 내역은 조회만 가능합니다.');
    }

    const partnerSettlementTransitionMatch = pathname.match(/^\/api\/partner\/settlements\/([^/]+)\/transition$/);
    if (partnerSettlementTransitionMatch && method === 'POST') {
      partnerSession(req);
      throw new HttpError(403, 'forbidden_role', '정산서 상태 변경은 본사 관리자만 할 수 있습니다.');
    }

    const partnerSettlementMatch = pathname.match(/^\/api\/partner\/settlements\/([^/]+)$/);
    if (partnerSettlementMatch && method === 'GET') {
      const session = partnerSession(req);
      const id = decodeURIComponent(partnerSettlementMatch[1]);
      const settlement = (session.db.settlements || []).find(item => String(item.id) === id || String(item.number) === id);
      if (!settlement) throw new HttpError(404, 'settlement_not_found', '정산서를 찾을 수 없습니다.');
      if (String(settlement.courseId) !== String(session.account.courseId)) {
        throw new HttpError(403, 'forbidden_course', '다른 골프장의 정산서는 조회할 수 없습니다.');
      }
      http.sendJson(res, 200, { ok: true, mode: 'server', settlement: analytics.settlementView(settlement), dataMode: 'demo', note: analytics.SIMULATION_NOTE });
      return;
    }

    if (pathname === '/api/partner/commission' && method === 'GET') {
      const session = partnerSession(req);
      assertOwnCourse(query.get('courseId'), session.account);
      const commission = analytics.commissionFor(session.db, session.account.courseId);
      http.sendJson(res, 200, {
        ok: true,
        mode: 'server',
        commission,
        defaultRatePercent: analytics.DEFAULT_COMMISSION_PERCENT,
        dataMode: 'demo'
      });
      return;
    }

    if (pathname === '/api/partner/notifications' && method === 'GET') {
      const session = partnerSession(req);
      assertOwnCourse(query.get('courseId'), session.account);
      const payload = analytics.notificationsFor(session.db, {
        courseId: String(session.account.courseId),
        event: String(query.get('event') || ''),
        limit: query.get('limit')
      });
      http.sendJson(res, 200, { ...payload, courseId: String(session.account.courseId) });
      return;
    }

    if (pathname === '/api/demo/stage10' && method === 'GET') {
      /* 시연 허브 상태: 개인정보 없이 개수·배치 정보만 공개한다. 초기화/준비는 관리자 인증이 필요하다. */
      const db = store.read();
      http.sendJson(res, 200, {
        ...demoStage10.demoStatus(db),
        guide: demoStage10.flowGuide(),
        confirmPhrases: {
          stage: demoStage10.CONFIRM_STAGE,
          reset: demoStage10.CONFIRM_RESET
        },
        flows: { investorCourses: 68, infoOnlyCourses: Math.max(0, catalog.courses.length - catalog.baselinePartnerIds.length), totalCourses: catalog.courses.length }
      });
      return;
    }

    if (pathname === '/api/demo/stage10/stage' && method === 'POST') {
      const { payload } = requireAdmin(req);
      const body = await http.readJson(req);
      const confirmation = String(body.confirm || '');
      if (confirmation !== demoStage10.CONFIRM_STAGE) {
        throw new HttpError(400, 'confirm_required', `확인 문구가 필요합니다. "${demoStage10.CONFIRM_STAGE}" 를 정확히 입력해야 시연 데이터를 준비합니다.`, { expected: demoStage10.CONFIRM_STAGE });
      }
      const actor = adminActor(req, payload, { note: 'demo-stage10' });
      const { result } = await store.update(db => demoStage10.stageDemo(db, { confirm: confirmation, catalog, actor, now: new Date() }));
      broadcast('demo.stage10', { action: 'staged', batch: result.batch, at: nowIso() });
      broadcast('inventory.changed', { reason: 'demo-staged', at: nowIso() });
      broadcast('catalog.changed', { kind: 'demo-stage10', at: nowIso() });
      http.sendJson(res, 201, { ...result, ok: true });
      return;
    }

    if (pathname === '/api/demo/stage10/reset' && method === 'POST') {
      const { payload } = requireAdmin(req);
      const body = await http.readJson(req);
      const confirmation = String(body.confirm || '');
      if (confirmation !== demoStage10.CONFIRM_RESET) {
        throw new HttpError(400, 'confirm_required', `확인 문구가 필요합니다. "${demoStage10.CONFIRM_RESET}" 를 정확히 입력해야 시연 데이터를 초기화합니다.`, { expected: demoStage10.CONFIRM_RESET });
      }
      const actor = adminActor(req, payload, { note: 'demo-stage10-reset' });
      const before = store.read();
      const preview = demoStage10.demoStatus(before);
      const { result } = await store.update(db => demoStage10.resetDemo(db, { confirm: confirmation, actor }));
      broadcast('demo.stage10', { action: 'reset', at: nowIso() });
      broadcast('inventory.changed', { reason: 'demo-reset', at: nowIso() });
      broadcast('catalog.changed', { kind: 'demo-stage10', at: nowIso() });
      http.sendJson(res, 200, { ...result, before: preview.demo, preservedBefore: preview.protectedRecords });
      return;
    }

    if (pathname === '/api/events' && method === 'GET') {
      const client = http.openSse(res);
      sseClients.add(client);
      client.send('hello', { at: nowIso(), mode: 'server', stage: 10 });
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
