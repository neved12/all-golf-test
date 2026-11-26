'use strict';
/* ALL:GOLF 9단계 — 본사 운영 통계·제휴 성과·수수료/정산 시뮬레이션·운영 알림 로그
   - 모든 계산은 서버 파일 DB(store) 안에서 읽은 값만 사용한다(시연용, 실제 PG/계좌 이체 없음).
   - 운영 통계의 기간(오늘/7일/30일/전체)은 "예약 접수일(reservation.createdAt)" 을 기준으로 한다.
     → 예약 서비스는 미래 라운드 예약이 대부분이므로, 접수일 기준이 오늘/7일/30일 실적을 보여주기에 맞다.
   - 정산서 계산의 기간은 "라운드일(reservation.date)" 을 기준으로 한다(정산 대상 라운드가 기간 안에 있는 예약).
   - 금액 기준: GMV = 취소되지 않은 예약(확정·이용완료·노쇼)의 예약 총액(totalEstimated) 합.
     취소 수수료(cancellationFee)는 "환불 후 골프장에 남는 수익"으로 보고 정산 기준액에 더한다.
     정산 기준액 = GMV + 취소 수수료, 플랫폼 수수료 = 정산 기준액 × 수수료율,
     정산 예정액 = 정산 기준액 − 플랫폼 수수료.
   - 정산서 상태: DRAFT(작성) → PENDING(확인 대기) → CONFIRMED(확정) → PAID(지급 완료).
   - 알림은 실제 문자·푸시·PG 이체가 아니라 DB 에 남기는 시연 기록(status: simulated)이다. */

const crypto = require('crypto');
const domain = require('./domain');
const operations = require('./operations');
const reservations = require('./reservations');

const DEFAULT_COMMISSION_PERCENT = 8;
const COMMISSION_MIN_PERCENT = 0;
const COMMISSION_MAX_PERCENT = 30;

const PERIODS = [
  { key: 'today', label: '오늘', days: 1 },
  { key: '7d', label: '최근 7일', days: 7 },
  { key: '30d', label: '최근 30일', days: 30 },
  { key: 'all', label: '전체', days: null }
];
const DEFAULT_PERIOD = '30d';

const SETTLEMENT_STATUSES = ['DRAFT', 'PENDING', 'CONFIRMED', 'PAID'];
const SETTLEMENT_STATUS_LABELS = {
  DRAFT: '작성 중',
  PENDING: '확인 대기',
  CONFIRMED: '확정',
  PAID: '지급 완료'
};
/* 되돌릴 수 없는 한 방향 전이만 허용한다(확정·지급 취소는 시연 범위 밖). */
const SETTLEMENT_TRANSITIONS = {
  DRAFT: ['PENDING'],
  PENDING: ['CONFIRMED'],
  CONFIRMED: ['PAID'],
  PAID: []
};

const NOTIFICATION_EVENTS = ['reservation.confirmed', 'reservation.cancelled', 'settlement.confirmed', 'settlement.paid'];
const NOTIFICATION_EVENT_LABELS = {
  'reservation.confirmed': '예약 확정 알림',
  'reservation.cancelled': '예약 취소·환불 알림',
  'settlement.confirmed': '정산 확정 알림',
  'settlement.paid': '정산 지급 알림'
};
const CHANNEL_LABELS = {
  simulated_sms: '문자(시연)',
  simulated_push: '앱 푸시(시연)',
  simulated_settlement: '정산 통지(시연)'
};

const SIMULATION_NOTE = '시연용 계산·기록입니다. 실제 카드 결제, 계좌 이체, 문자·푸시 발송은 이루어지지 않습니다.';

const nowIso = () => new Date().toISOString();
const round1 = value => Math.round(Number(value || 0) * 10) / 10;
const roundWon = value => Math.round(Number(value || 0));
const sum = (list, field) => list.reduce((total, item) => total + Number(item[field] || 0), 0);

function resolvePeriod(key, now = new Date()) {
  const found = PERIODS.find(item => item.key === String(key || '')) || PERIODS.find(item => item.key === DEFAULT_PERIOD);
  const today = operations.todayKst(now);
  if (!found.days) {
    return { key: found.key, label: found.label, from: null, to: null, days: null, basis: 'createdAt', basisLabel: '예약 접수일 기준 · 전체' };
  }
  const from = operations.addDaysIso(today, -(found.days - 1));
  return {
    key: found.key,
    label: found.label,
    from,
    to: today,
    days: found.days,
    basis: 'createdAt',
    basisLabel: `예약 접수일 ${from} ~ ${today}`
  };
}

function inPeriod(date, period) {
  const value = String(date || '');
  if (!value) return false;
  if (period.from && value < period.from) return false;
  if (period.to && value > period.to) return false;
  return true;
}

function inIsoPeriod(iso, period) {
  const value = String(iso || '').slice(0, 10);
  if (!value) return false;
  return inPeriod(value, period);
}

/* --- 수수료율 -------------------------------------------------------------- */
function commissionView(courseId) {
  return {
    courseId: String(courseId),
    ratePercent: DEFAULT_COMMISSION_PERCENT,
    source: 'default',
    defaultRatePercent: DEFAULT_COMMISSION_PERCENT,
    updatedAt: null,
    updatedBy: null,
    version: 0
  };
}

function commissionFor(db, courseId) {
  const base = commissionView(courseId);
  const stored = (db.commissionRates || {})[String(courseId)];
  if (!stored || !Number.isFinite(Number(stored.ratePercent))) return base;
  return {
    ...base,
    ratePercent: round1(stored.ratePercent),
    source: 'custom',
    updatedAt: stored.updatedAt || null,
    updatedBy: stored.updatedBy || null,
    version: Number(stored.version || 1)
  };
}

function validateCommission(input) {
  const source = input && typeof input === 'object' ? input : {};
  const raw = String(source.ratePercent == null ? '' : source.ratePercent).replace(/[%\s]/g, '');
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value)) {
    return { ok: false, message: '수수료율을 숫자로 입력해주세요.', errors: { ratePercent: '수수료율을 숫자로 입력해주세요.' } };
  }
  if (value < COMMISSION_MIN_PERCENT || value > COMMISSION_MAX_PERCENT) {
    return {
      ok: false,
      message: `수수료율은 ${COMMISSION_MIN_PERCENT}~${COMMISSION_MAX_PERCENT}% 사이로 입력해주세요.`,
      errors: { ratePercent: `수수료율은 ${COMMISSION_MIN_PERCENT}~${COMMISSION_MAX_PERCENT}% 사이로 입력해주세요.` }
    };
  }
  return { ok: true, value: { ratePercent: round1(value) } };
}

function commissionList(db) {
  return (db.approvedCourses || [])
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'))
    .map(course => {
      const commission = commissionFor(db, course.id);
      const sealed = (db.settlements || []).filter(item => String(item.courseId) === String(course.id)
        && ['DRAFT', 'PENDING', 'CONFIRMED'].includes(item.status)).length;
      return {
        courseId: String(course.id),
        courseName: course.name,
        region: course.region || null,
        city: course.city || null,
        ratePercent: commission.ratePercent,
        source: commission.source,
        defaultRatePercent: DEFAULT_COMMISSION_PERCENT,
        minPercent: COMMISSION_MIN_PERCENT,
        maxPercent: COMMISSION_MAX_PERCENT,
        updatedAt: commission.updatedAt,
        updatedBy: commission.updatedBy,
        version: commission.version,
        openSettlements: sealed
      };
    });
}

/* --- 기간별 운영 통계 ------------------------------------------------------ */
function sessionBucket(reservation) {
  if (reservation.session) return String(reservation.session);
  return operations.sessionForTime(reservation.time);
}

function courseMetrics(db, courseId, period, courseMeta) {
  /* 운영 통계 기간 기준은 "예약이 접수된 날(createdAt)" 이다.
     (미래 라운드 예약이 대부분인 예약 서비스에서도 오늘/7일/30일 실적이 바로 보이도록)
     정산서 계산은 정산 대상 라운드일(reservation.date) 을 기준으로 한다. */
  const items = (db.reservations || []).filter(item => String(item.courseId) === String(courseId) && inIsoPeriod(item.createdAt, period));
  const active = items.filter(item => ['confirmed', 'completed', 'no_show'].includes(item.status));
  const cancelled = items.filter(item => item.status === 'cancelled');
  const sessions = {};
  operations.SESSIONS.forEach(name => { sessions[name] = 0; });
  active.forEach(item => {
    const key = sessionBucket(item);
    sessions[key] = (sessions[key] || 0) + 1;
  });
  const gmv = roundWon(sum(active, 'totalEstimated'));
  const cancellationFee = roundWon(sum(cancelled, 'cancellationFee'));
  const commission = commissionFor(db, courseId);
  const basisAmount = gmv + cancellationFee;
  const platformFee = roundWon(basisAmount * commission.ratePercent / 100);
  return {
    courseId: String(courseId),
    courseName: courseMeta ? courseMeta.name : null,
    region: courseMeta ? courseMeta.region || null : null,
    commissionRatePercent: commission.ratePercent,
    commissionSource: commission.source,
    reservations: items.length,
    confirmed: items.filter(item => item.status === 'confirmed').length,
    completed: items.filter(item => item.status === 'completed').length,
    noShow: items.filter(item => item.status === 'no_show').length,
    cancelled: cancelled.length,
    activeReservations: active.length,
    people: active.reduce((total, item) => total + Number(item.people || 0), 0),
    gmv,
    depositPaid: roundWon(sum(active, 'paidDeposit')),
    refundAmount: roundWon(sum(cancelled, 'refundAmount')),
    cancellationFee,
    basisAmount,
    platformFee,
    payoutAmount: basisAmount - platformFee,
    noShowRate: active.length ? round1(items.filter(item => item.status === 'no_show').length * 100 / active.length) : 0,
    cancelRate: items.length ? round1(cancelled.length * 100 / items.length) : 0,
    averageTicket: active.length ? roundWon(gmv / active.length) : 0,
    sessions
  };
}

function emptyTotals() {
  const sessions = {};
  operations.SESSIONS.forEach(name => { sessions[name] = 0; });
  return {
    reservations: 0, confirmed: 0, completed: 0, noShow: 0, cancelled: 0, activeReservations: 0,
    people: 0, gmv: 0, depositPaid: 0, refundAmount: 0, cancellationFee: 0,
    basisAmount: 0, platformFee: 0, payoutAmount: 0, noShowRate: 0, cancelRate: 0, averageTicket: 0,
    sessions
  };
}

function addMetrics(totals, row) {
  ['reservations', 'confirmed', 'completed', 'noShow', 'cancelled', 'activeReservations', 'people',
    'gmv', 'depositPaid', 'refundAmount', 'cancellationFee', 'basisAmount', 'platformFee', 'payoutAmount']
    .forEach(key => { totals[key] += Number(row[key] || 0); });
  Object.keys(row.sessions || {}).forEach(key => { totals.sessions[key] = (totals.sessions[key] || 0) + Number(row.sessions[key] || 0); });
  return totals;
}

function finalizeRates(totals) {
  totals.noShowRate = totals.activeReservations ? round1(totals.noShow * 100 / totals.activeReservations) : 0;
  totals.cancelRate = totals.reservations ? round1(totals.cancelled * 100 / totals.reservations) : 0;
  totals.averageTicket = totals.activeReservations ? roundWon(totals.gmv / totals.activeReservations) : 0;
  return totals;
}

function applicationMetrics(db, period, courseFilter) {
  let items = (db.applications || []).slice();
  if (courseFilter) {
    items = items.filter(item => String(item.courseId || item.newCourseId || '') === String(courseFilter));
  }
  const inRange = items.filter(item => inIsoPeriod(item.createdAt, period));
  const approved = inRange.filter(item => item.status === 'approved').length;
  const rejected = inRange.filter(item => item.status === 'rejected').length;
  const pending = inRange.filter(item => item.status === 'pending').length;
  const decided = approved + rejected;
  const approvedInPeriod = items.filter(item => item.status === 'approved'
    && item.decision && inIsoPeriod(item.decision.at, period)).length;
  return {
    total: inRange.length,
    pending,
    approved,
    rejected,
    approvedInPeriod,
    conversionRate: decided ? round1(approved * 100 / decided) : 0,
    conversionBasis: '기간 내 승인 ÷ (승인 + 반려)'
  };
}

function analyticsFor(db, options = {}) {
  const period = resolvePeriod(options.period);
  const courseFilter = options.courseId ? String(options.courseId) : null;
  let courses = (db.approvedCourses || []).slice();
  if (courseFilter) courses = courses.filter(item => String(item.id) === courseFilter);
  const byCourse = courses
    .map(course => courseMetrics(db, course.id, period, course))
    .sort((a, b) => b.gmv - a.gmv || String(a.courseName || '').localeCompare(String(b.courseName || ''), 'ko'));
  const totals = byCourse.reduce(addMetrics, emptyTotals());
  finalizeRates(totals);
  return {
    ok: true,
    mode: 'server',
    dataMode: 'demo',
    simulated: true,
    period,
    filter: { courseId: courseFilter },
    totals,
    applications: applicationMetrics(db, period, courseFilter),
    byCourse,
    commission: {
      defaultRatePercent: DEFAULT_COMMISSION_PERCENT,
      minPercent: COMMISSION_MIN_PERCENT,
      maxPercent: COMMISSION_MAX_PERCENT
    },
    basis: {
      dateBasis: 'reservation.createdAt (예약 접수일) — 운영 통계',
      settlementDateBasis: 'reservation.date (라운드일) — 정산서',
      gmv: '취소되지 않은 예약(확정·이용완료·노쇼)의 예약 총액 합',
      settlement: '정산 기준액 = GMV + 취소 수수료 · 플랫폼 수수료 = 기준액 × 골프장별 수수료율 · 정산 예정액 = 기준액 − 수수료'
    },
    note: `${SIMULATION_NOTE} 기간은 예약 접수일 기준이며, 정산서는 라운드일 기준으로 계산합니다.`,
    generatedAt: nowIso()
  };
}

/* --- 정산 계산 ------------------------------------------------------------- */
function dateProblem(from, to) {
  if (!from || !to) return '정산 기간(시작일·종료일)을 입력해주세요.';
  if (!domain.isValidDate(from) || !domain.isValidDate(to)) return '날짜는 YYYY-MM-DD 형식이어야 합니다.';
  if (to < from) return '종료일은 시작일보다 빠를 수 없습니다.';
  const span = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
  if (span > 366) return '정산 기간은 최대 366일까지 지정할 수 있습니다.';
  return null;
}

function settlementCalculation(db, options = {}) {
  const courseId = String(options.courseId || '');
  const from = String(options.from || '');
  const to = String(options.to || '');
  const course = (db.approvedCourses || []).find(item => String(item.id) === courseId);
  const items = (db.reservations || []).filter(item => String(item.courseId) === courseId);
  const inRange = items.filter(item => item.date >= from && item.date <= to);
  const active = inRange.filter(item => ['confirmed', 'completed', 'no_show'].includes(item.status));
  const cancelled = inRange.filter(item => item.status === 'cancelled');
  const grossAmount = roundWon(sum(active, 'totalEstimated'));
  const cancellationFee = roundWon(sum(cancelled, 'cancellationFee'));
  const refundAmount = roundWon(sum(cancelled, 'refundAmount'));
  const basisAmount = grossAmount + cancellationFee;
  const commission = commissionFor(db, courseId);
  const platformFee = roundWon(basisAmount * commission.ratePercent / 100);
  const sessions = {};
  operations.SESSIONS.forEach(name => { sessions[name] = 0; });
  active.forEach(item => {
    const key = sessionBucket(item);
    sessions[key] = (sessions[key] || 0) + 1;
  });
  return {
    courseId,
    courseName: course ? course.name : null,
    from,
    to,
    commissionRatePercent: commission.ratePercent,
    commissionSource: commission.source,
    reservations: inRange.length,
    activeReservations: active.length,
    confirmed: inRange.filter(item => item.status === 'confirmed').length,
    completed: inRange.filter(item => item.status === 'completed').length,
    noShow: inRange.filter(item => item.status === 'no_show').length,
    cancelled: cancelled.length,
    people: active.reduce((total, item) => total + Number(item.people || 0), 0),
    grossAmount,
    cancellationFee,
    refundAmount,
    basisAmount,
    platformFee,
    payoutAmount: basisAmount - platformFee,
    sessions,
    formula: {
      grossAmount: '취소되지 않은 예약의 예약 총액 합',
      cancellationFee: '취소 예약의 환불 후 잔여 수수료 합',
      basisAmount: 'grossAmount + cancellationFee',
      platformFee: `round(basisAmount × ${commission.ratePercent}%)`,
      payoutAmount: 'basisAmount − platformFee'
    }
  };
}

function settlementId() {
  return `stl-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function settlementNumber(db, from) {
  const month = String(from || operations.todayKst()).slice(0, 7).replace('-', '');
  db.meta = db.meta || {};
  db.meta.sequences = db.meta.sequences || {};
  const key = `stl:${month}`;
  const next = (Number(db.meta.sequences[key]) || 0) + 1;
  db.meta.sequences[key] = next;
  return `ST-${month}-${String(next).padStart(4, '0')}`;
}

function settlementView(settlement) {
  return {
    ...settlement,
    statusLabel: SETTLEMENT_STATUS_LABELS[settlement.status] || settlement.status,
    nextStatuses: (SETTLEMENT_TRANSITIONS[settlement.status] || []).map(status => ({ status, label: SETTLEMENT_STATUS_LABELS[status] })),
    simulated: true,
    dataMode: 'demo'
  };
}

function createSettlement(db, options = {}) {
  const courseId = String(options.courseId || '');
  const from = String(options.from || '');
  const to = String(options.to || '');
  const problem = dateProblem(from, to);
  if (problem) return { ok: false, code: 'invalid_range', status: 400, message: problem };
  const course = (db.approvedCourses || []).find(item => String(item.id) === courseId);
  if (!course) return { ok: false, code: 'course_not_found', status: 404, message: '제휴 승인된 골프장을 찾을 수 없습니다.' };
  const duplicate = (db.settlements || []).find(item => String(item.courseId) === courseId && item.period && item.period.from === from && item.period.to === to);
  if (duplicate) {
    return {
      ok: false,
      code: 'duplicate_settlement',
      status: 409,
      message: `같은 기간의 정산서가 이미 있습니다. (${duplicate.number} · ${SETTLEMENT_STATUS_LABELS[duplicate.status] || duplicate.status})`,
      details: { settlementId: duplicate.id, number: duplicate.number, status: duplicate.status }
    };
  }
  /* 기간이 겹치는 정산서도 막는다(같은 라운드가 두 정산서에 중복 계산되지 않도록). */
  const overlapping = (db.settlements || []).find(item => String(item.courseId) === courseId && item.period
    && item.period.from <= to && item.period.to >= from);
  if (overlapping) {
    return {
      ok: false,
      code: 'overlapping_settlement',
      status: 409,
      message: `기간이 겹치는 정산서가 이미 있습니다. (${overlapping.number} · ${overlapping.period.from}~${overlapping.period.to})`,
      details: { settlementId: overlapping.id, number: overlapping.number, period: overlapping.period }
    };
  }
  const calculation = settlementCalculation(db, { courseId, from, to });
  const at = nowIso();
  const requested = String(options.status || 'DRAFT').toUpperCase();
  const status = requested === 'PENDING' ? 'PENDING' : 'DRAFT';
  const actor = options.actor || null;
  const settlement = {
    id: settlementId(),
    number: settlementNumber(db, from),
    courseId,
    courseName: course.name,
    period: { from, to },
    status,
    statusLabel: SETTLEMENT_STATUS_LABELS[status],
    calculation,
    commissionRatePercent: calculation.commissionRatePercent,
    basisAmount: calculation.basisAmount,
    platformFee: calculation.platformFee,
    payoutAmount: calculation.payoutAmount,
    grossAmount: calculation.grossAmount,
    cancellationFee: calculation.cancellationFee,
    refundAmount: calculation.refundAmount,
    reservations: calculation.reservations,
    confirmed: calculation.confirmed,
    completed: calculation.completed,
    noShow: calculation.noShow,
    cancelled: calculation.cancelled,
    people: calculation.people,
    createdAt: at,
    updatedAt: at,
    confirmedAt: null,
    paidAt: null,
    createdBy: actor,
    version: 1,
    history: [{ status, at, by: actor, note: options.note || '정산서 생성(시연)' }],
    simulated: true,
    dataMode: 'demo'
  };
  db.settlements = Array.isArray(db.settlements) ? db.settlements : [];
  db.settlements.push(settlement);
  return { ok: true, status: 201, settlement, calculation };
}

function transitionSettlement(settlement, nextStatusRaw, options = {}) {
  const nextStatus = String(nextStatusRaw || '').toUpperCase();
  if (!SETTLEMENT_STATUSES.includes(nextStatus)) {
    return { ok: false, code: 'invalid_status', status: 400, message: '변경할 수 없는 정산 상태입니다.' };
  }
  if (nextStatus === settlement.status) {
    return { ok: false, code: 'invalid_transition', status: 409, message: `이미 ${SETTLEMENT_STATUS_LABELS[nextStatus]} 상태입니다.` };
  }
  const allowed = SETTLEMENT_TRANSITIONS[settlement.status] || [];
  if (!allowed.includes(nextStatus)) {
    return {
      ok: false,
      code: 'invalid_transition',
      status: 409,
      message: `${SETTLEMENT_STATUS_LABELS[settlement.status] || settlement.status}에서 ${SETTLEMENT_STATUS_LABELS[nextStatus]}로 바꿀 수 없습니다.`,
      details: { from: settlement.status, to: nextStatus, allowed }
    };
  }
  const at = nowIso();
  settlement.status = nextStatus;
  settlement.statusLabel = SETTLEMENT_STATUS_LABELS[nextStatus];
  settlement.updatedAt = at;
  settlement.version = Number(settlement.version || 1) + 1;
  if (nextStatus === 'CONFIRMED') settlement.confirmedAt = at;
  if (nextStatus === 'PAID') settlement.paidAt = at;
  settlement.history = Array.isArray(settlement.history) ? settlement.history : [];
  settlement.history.push({ status: nextStatus, at, by: options.actor || null, note: options.note || '' });
  return { ok: true, settlement };
}

/* --- 운영 알림 시뮬레이션 로그 --------------------------------------------- */
function notificationId() {
  return `NT-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function recordNotification(db, entry) {
  const item = {
    id: notificationId(),
    at: nowIso(),
    status: 'simulated',
    simulated: true,
    externalSend: false,
    ...entry
  };
  db.notificationLogs = Array.isArray(db.notificationLogs) ? db.notificationLogs : [];
  db.notificationLogs.push(item);
  if (db.notificationLogs.length > 5000) db.notificationLogs.splice(0, db.notificationLogs.length - 5000);
  return item;
}

function notifyReservation(db, reservation, event) {
  const courseName = reservation.courseName || (db.approvedCourses || []).find(item => String(item.id) === String(reservation.courseId))?.name || '골프장';
  const base = {
    event,
    eventLabel: NOTIFICATION_EVENT_LABELS[event],
    courseId: String(reservation.courseId),
    courseName,
    reservationNumber: reservation.number,
    reservationId: reservation.id,
    date: reservation.date,
    time: reservation.time
  };
  const created = [];
  if (event === 'reservation.confirmed') {
    created.push(recordNotification(db, {
      ...base,
      channel: 'simulated_sms',
      recipient: { type: 'customer', name: reservation.booker, phone: reservations.maskPhone(reservation.phone) },
      subject: `[ALL:GOLF] ${courseName} 예약 확정`,
      summary: `${reservation.number} · ${reservation.date} ${reservation.time} · ${reservation.people}명 · 예약금 ${Number(reservation.paidDeposit || 0).toLocaleString('ko-KR')}원`
    }));
    created.push(recordNotification(db, {
      ...base,
      channel: 'simulated_push',
      recipient: { type: 'partner', name: courseName, courseId: String(reservation.courseId) },
      subject: `[ALL:GOLF] 새 예약 ${reservation.number}`,
      summary: `${reservation.date} ${reservation.time} · ${reservation.people}명 · ${reservation.booker}`
    }));
  } else {
    const cancellation = reservation.cancellation || {};
    created.push(recordNotification(db, {
      ...base,
      channel: 'simulated_sms',
      recipient: { type: 'customer', name: reservation.booker, phone: reservations.maskPhone(reservation.phone) },
      subject: `[ALL:GOLF] ${courseName} 예약 취소·환불 안내`,
      summary: `${reservation.number} · 환불률 ${Number(cancellation.refundRate || 0)}% · 환불 ${Number(cancellation.refundAmount || 0).toLocaleString('ko-KR')}원 (시연)`
    }));
    created.push(recordNotification(db, {
      ...base,
      channel: 'simulated_push',
      recipient: { type: 'partner', name: courseName, courseId: String(reservation.courseId) },
      subject: `[ALL:GOLF] 예약 취소 ${reservation.number}`,
      summary: `${reservation.date} ${reservation.time} · 취소 수수료 ${Number(cancellation.cancellationFee || 0).toLocaleString('ko-KR')}원`
    }));
  }
  return created;
}

function notifySettlement(db, settlement, status) {
  const event = status === 'PAID' ? 'settlement.paid' : 'settlement.confirmed';
  return [recordNotification(db, {
    event,
    eventLabel: NOTIFICATION_EVENT_LABELS[event],
    channel: 'simulated_settlement',
    courseId: String(settlement.courseId),
    courseName: settlement.courseName,
    settlementId: settlement.id,
    settlementNumber: settlement.number,
    recipient: { type: 'partner', name: settlement.courseName, courseId: String(settlement.courseId) },
    subject: status === 'PAID'
      ? `[ALL:GOLF] ${settlement.number} 정산 지급 완료(시연)`
      : `[ALL:GOLF] ${settlement.number} 정산 확정`,
    summary: `${settlement.period.from}~${settlement.period.to} · 정산 예정액 ${Number(settlement.payoutAmount || 0).toLocaleString('ko-KR')}원 · 수수료 ${Number(settlement.platformFee || 0).toLocaleString('ko-KR')}원(${settlement.commissionRatePercent}%)`
  })];
}

function notificationView(item) {
  return {
    ...item,
    eventLabel: item.eventLabel || NOTIFICATION_EVENT_LABELS[item.event] || item.event,
    channelLabel: CHANNEL_LABELS[item.channel] || item.channel,
    statusLabel: item.status === 'simulated' ? '시연 발송 기록' : item.status,
    simulated: true,
    dataMode: 'demo'
  };
}

function notificationsFor(db, options = {}) {
  const courseId = options.courseId ? String(options.courseId) : '';
  const event = String(options.event || '');
  const limit = Math.min(500, Math.max(1, Number(options.limit) || 100));
  let items = (db.notificationLogs || []).slice();
  if (courseId) items = items.filter(item => String(item.courseId || (item.recipient && item.recipient.courseId) || '') === courseId);
  if (event) items = items.filter(item => item.event === event);
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return {
    ok: true,
    mode: 'server',
    dataMode: 'demo',
    simulated: true,
    count: items.length,
    channels: Object.keys(CHANNEL_LABELS).map(key => ({ channel: key, label: CHANNEL_LABELS[key] })),
    events: NOTIFICATION_EVENTS.map(key => ({ event: key, label: NOTIFICATION_EVENT_LABELS[key] })),
    notifications: items.slice(0, limit).map(notificationView),
    note: '실제 문자·푸시·이체가 아닌 시연 로그입니다. 수신 대상·채널·제목·시각만 DB 에 기록합니다.'
  };
}

/* --- CSV ------------------------------------------------------------------- */
function csvCell(value) {
  let text = String(value == null ? '' : value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function analyticsCsv(payload) {
  const header = ['골프장', '골프장ID', '수수료율(%)', '예약건수', '확정', '이용완료', '노쇼', '취소', '인원',
    'GMV(원)', '예약금(원)', '취소수수료(원)', '환불액(원)', '정산기준액(원)', '플랫폼수수료(원)', '정산예정액(원)',
    '1부', '2부', '3부'];
  const rows = (payload.byCourse || []).map(row => [
    row.courseName || '', row.courseId, row.commissionRatePercent, row.reservations, row.confirmed, row.completed,
    row.noShow, row.cancelled, row.people, row.gmv, row.depositPaid, row.cancellationFee, row.refundAmount,
    row.basisAmount, row.platformFee, row.payoutAmount,
    row.sessions['1부'] || 0, row.sessions['2부'] || 0, row.sessions['3부'] || 0
  ]);
  const totals = payload.totals || {};
  rows.push(['합계', '', '', totals.reservations || 0, totals.confirmed || 0, totals.completed || 0, totals.noShow || 0,
    totals.cancelled || 0, totals.people || 0, totals.gmv || 0, totals.depositPaid || 0, totals.cancellationFee || 0,
    totals.refundAmount || 0, totals.basisAmount || 0, totals.platformFee || 0, totals.payoutAmount || 0,
    (totals.sessions && totals.sessions['1부']) || 0, (totals.sessions && totals.sessions['2부']) || 0,
    (totals.sessions && totals.sessions['3부']) || 0]);
  return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
}

function settlementsCsv(items) {
  const header = ['정산번호', '골프장', '골프장ID', '기간시작', '기간종료', '상태', '수수료율(%)', '예약건수',
    'GMV(원)', '취소수수료(원)', '환불액(원)', '정산기준액(원)', '플랫폼수수료(원)', '정산예정액(원)', '생성일'];
  const rows = (items || []).map(item => [
    item.number, item.courseName || '', item.courseId, item.period && item.period.from, item.period && item.period.to,
    SETTLEMENT_STATUS_LABELS[item.status] || item.status, item.commissionRatePercent, item.reservations,
    item.grossAmount, item.cancellationFee, item.refundAmount, item.basisAmount, item.platformFee, item.payoutAmount,
    String(item.createdAt || '').slice(0, 19)
  ]);
  return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
}

module.exports = {
  PERIODS,
  DEFAULT_PERIOD,
  DEFAULT_COMMISSION_PERCENT,
  COMMISSION_MIN_PERCENT,
  COMMISSION_MAX_PERCENT,
  SETTLEMENT_STATUSES,
  SETTLEMENT_STATUS_LABELS,
  SETTLEMENT_TRANSITIONS,
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_LABELS,
  SIMULATION_NOTE,
  resolvePeriod,
  inPeriod,
  commissionFor,
  commissionList,
  validateCommission,
  analyticsFor,
  settlementCalculation,
  settlementView,
  createSettlement,
  transitionSettlement,
  recordNotification,
  notifyReservation,
  notifySettlement,
  notificationView,
  notificationsFor,
  analyticsCsv,
  settlementsCsv
};
