'use strict';
/* ALL:GOLF 8단계 예약 엔진: 임시확보(Hold) · 예약(Reservation) · 취소·환불
   - 재고 검증과 차감은 반드시 store.update(파일 잠금) 안에서 호출한다.
     라우터가 store.update 콜백 안에서 이 모듈의 함수를 쓰기 때문에 동시 요청은 직렬화되고,
     마지막 1팀에 대한 경쟁에서도 정확히 한 건만 성공한다.
   - 재고 = capacityTeams - (티타임에 저장된 bookedTeams + 확정 예약 수) - (TTL 이 살아 있는 Hold 수)
     · bookedTeams/heldTeams 필드는 7단계 이전 데이터·수동 보정용으로 남겨 두고, 예약·Hold 는
       reservations/bookingHolds 컬렉션에서 계산한다(이중 차감 방지).
   - 만료된 Hold 는 조회·예약·취소 시점과 주기 정리(sweepExpiredHolds)에서 status=expired 로 바뀌고
     재고 계산에서 빠지므로 자동으로 잔여 팀이 복구된다.
   - 예약번호는 한국 시간 기준 AG-YYMMDD-NNNNN (일자별 순번은 meta.sequences 에 보존).
   - 실제 결제 승인·외부 골프장 연동·정산은 범위가 아니다(9단계). */

const crypto = require('crypto');
const domain = require('./domain');
const operations = require('./operations');

const RESERVATION_STATUSES = ['confirmed', 'cancelled', 'completed', 'no_show'];
const RESERVATION_STATUS_LABELS = {
  confirmed: '예약 확정',
  cancelled: '취소',
  completed: '이용 완료',
  no_show: '노쇼'
};
const ACTIVE_RESERVATION_STATUSES = ['confirmed', 'completed', 'no_show'];
const HOLD_STATUS_LABELS = { active: '확보 중', consumed: '예약 확정', expired: '만료', released: '해제' };
const DEFAULT_HOLD_TTL_MS = 5 * 60 * 1000;
const MIN_PEOPLE = 2;
const MAX_PEOPLE = 4;
const DEFAULT_CANCELLATION_POLICY = {
  sevenPlus: 100,
  fourToSix: 70,
  twoToThree: 50,
  oneDay: 0,
  sameDay: 0,
  cutoffHoursBefore: null
};

const statusLabel = status => RESERVATION_STATUS_LABELS[status] || status;
const holdStatusLabel = status => HOLD_STATUS_LABELS[status] || status;

function nowIso() {
  return new Date().toISOString();
}

function parseTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function digits(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

function maskPhone(value) {
  const text = digits(value);
  if (text.length < 7) return text ? '****' : '';
  if (text.length === 10) return `${text.slice(0, 3)}-****-${text.slice(6)}`;
  return `${text.slice(0, 3)}-****-${text.slice(7)}`;
}

function isPhone(value) {
  return /^01[016789]\d{7,8}$/.test(digits(value));
}

function activeHold(hold, now = Date.now()) {
  return Boolean(hold) && hold.status === 'active' && parseTime(hold.expiresAt) > now;
}

function holdTtlMs(config) {
  const fromConfig = config && Number(config.holdTtlMs);
  if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
  return DEFAULT_HOLD_TTL_MS;
}

/* --- 재고 ------------------------------------------------------------------ */
/* operations.inventoryFor 와 같은 계산을 쓰되, 만료 Hold 정리 결과를 함께 돌려준다. */
function inventoryFor(db, now = Date.now()) {
  return operations.inventoryFor(db, now);
}

function remainingFor(db, tee, now = Date.now()) {
  return operations.remainingTeams(tee, inventoryFor(db, now));
}

/* 만료 Hold 를 expired 로 바꾸고 오래된 기록을 정리한다(쓰기 트랜잭션 안에서 호출). */
function sweepExpiredHolds(db, now = Date.now()) {
  if (!Array.isArray(db.bookingHolds)) db.bookingHolds = [];
  let expired = 0;
  db.bookingHolds.forEach(hold => {
    if (hold.status === 'active' && parseTime(hold.expiresAt) <= now) {
      hold.status = 'expired';
      hold.expiredAt = new Date(now).toISOString();
      expired += 1;
    }
  });
  const keepFrom = now - 2 * 86400000;
  db.bookingHolds = db.bookingHolds.filter(hold => activeHold(hold, now) || parseTime(hold.expiresAt || hold.createdAt) > keepFrom);
  return expired;
}

function activeHoldsFor(db, teeTimeId, now = Date.now()) {
  return (db.bookingHolds || []).filter(hold => activeHold(hold, now) && String(hold.teeTimeId) === String(teeTimeId));
}

function holdView(hold) {
  return {
    id: hold.id,
    courseId: hold.courseId,
    teeTimeId: hold.teeTimeId,
    date: hold.date,
    time: hold.time,
    session: hold.session || null,
    people: hold.people == null ? null : Number(hold.people),
    status: hold.status,
    statusLabel: holdStatusLabel(hold.status),
    createdAt: hold.createdAt,
    expiresAt: hold.expiresAt,
    demo: true
  };
}

function findHold(db, holdId, now = Date.now()) {
  return (db.bookingHolds || []).find(hold => String(hold.id) === String(holdId) && (!now || activeHold(hold, now))) || null;
}

/* --- Hold 생성 ------------------------------------------------------------- */
/* options: { courseId, date, teeTimeId, people, sessionId, ip, ttlMs, maxHoldsPerSession } */
function createHold(db, input, options = {}) {
  const now = options.now || Date.now();
  sweepExpiredHolds(db, now);
  const courseId = String(input.courseId || '').trim();
  const date = String(input.date || '').trim();
  const teeTimeId = String(input.teeTimeId || '').trim();
  const sessionId = String(input.sessionId || '').trim().slice(0, 120);
  const ttlMs = options.ttlMs || DEFAULT_HOLD_TTL_MS;

  if (!courseId) return { ok: false, code: 'course_required', message: '골프장을 선택해주세요.' };
  if (!domain.isValidDate(date)) return { ok: false, code: 'invalid_date', message: '라운드 날짜가 올바르지 않습니다.' };
  if (!teeTimeId) return { ok: false, code: 'tee_time_required', message: '티타임을 선택해주세요.' };
  if (!sessionId) return { ok: false, code: 'session_required', message: '예약 세션 정보가 없습니다. 화면을 새로고침해주세요.' };

  const tee = operations.findTeeTime(db, teeTimeId);
  if (!tee) return { ok: false, code: 'tee_time_not_found', message: '티타임을 찾을 수 없습니다.' };
  if (String(tee.courseId) !== courseId) return { ok: false, code: 'tee_time_mismatch', message: '티타임과 골프장 정보가 일치하지 않습니다.' };
  if (tee.date !== date) return { ok: false, code: 'tee_time_mismatch', message: '티타임 날짜가 요청한 날짜와 다릅니다.' };
  const people = input.people == null ? Number(tee.maxPlayers) : Number(input.people);
  if (!Number.isInteger(people) || people < MIN_PEOPLE || people > Number(tee.maxPlayers || MAX_PEOPLE)) {
    return { ok: false, code: 'invalid_people', message: `예약 인원은 2~${Number(tee.maxPlayers) || MAX_PEOPLE}명이어야 합니다.` };
  }
  if (tee.status !== 'open') return { ok: false, code: 'sold_out', message: '현재 판매 중이 아닌 티타임입니다.' };

  /* 같은 세션의 기존 Hold 는 재사용(연장)한다. 마지막 1팀을 잡고 있어도 다시 부를 수 있어야 한다. */
  const mine = activeHoldsFor(db, tee.id, now).filter(hold => hold.sessionId === sessionId);
  if (mine.length) {
    const existing = mine[0];
    existing.expiresAt = new Date(now + ttlMs).toISOString();
    existing.people = people;
    existing.updatedAt = nowIso();
    return { ok: true, reused: true, hold: existing, tee };
  }

  const counts = inventoryFor(db, now);
  const remaining = operations.remainingTeams(tee, counts);
  if (remaining < 1) return { ok: false, code: 'sold_out', message: '잔여 팀이 없습니다. 다른 시간을 선택해주세요.' };

  const maxHolds = Number(options.maxHoldsPerSession) || 3;
  const sessionHolds = (db.bookingHolds || []).filter(hold => activeHold(hold, now) && hold.sessionId === sessionId);
  if (sessionHolds.length >= maxHolds) {
    return { ok: false, code: 'hold_limit', message: '임시 확보는 동시에 3건까지만 가능합니다. 진행 중인 예약을 먼저 마무리해주세요.' };
  }

  const hold = {
    id: `hold-${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    courseId,
    teeTimeId: String(tee.id),
    date: tee.date,
    time: tee.time,
    session: tee.session || null,
    people,
    sessionId,
    status: 'active',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    createdBy: { type: 'customer', ip: options.ip || null },
    demo: true
  };
  db.bookingHolds.push(hold);
  return { ok: true, reused: false, hold, tee };
}

function releaseHold(db, holdId, sessionId, options = {}) {
  sweepExpiredHolds(db, options.now);
  const hold = (db.bookingHolds || []).find(item => String(item.id) === String(holdId));
  if (!hold) return { ok: false, code: 'hold_not_found', message: '임시 확보를 찾을 수 없습니다.' };
  if (sessionId && hold.sessionId !== String(sessionId)) {
    return { ok: false, code: 'forbidden_hold', message: '다른 예약 세션의 임시 확보는 해제할 수 없습니다.' };
  }
  if (hold.status === 'active') {
    hold.status = 'released';
    hold.releasedAt = nowIso();
    hold.updatedAt = hold.releasedAt;
  }
  return { ok: true, hold };
}

/* --- 예약번호 -------------------------------------------------------------- */
function nextReservationNumber(db, now = new Date()) {
  const { yymmdd } = domain.kstStamp(now);
  const key = `rsv:${yymmdd}`;
  if (!db.meta) db.meta = {};
  if (!db.meta.sequences) db.meta.sequences = {};
  const used = new Set((db.reservations || []).map(item => String(item.number || '')));
  let sequence = Number(db.meta.sequences[key] || 0);
  let number = '';
  do {
    sequence += 1;
    number = `AG-${yymmdd}-${String(sequence).padStart(5, '0')}`;
  } while (used.has(number));
  db.meta.sequences[key] = sequence;
  return number;
}

/* --- 입력 검증 ------------------------------------------------------------- */
function validateReservationInput(input, options = {}) {
  const tee = options.tee || null;
  const source = input && typeof input === 'object' ? input : {};
  const errors = {};
  const booker = domain.text(source.booker).slice(0, 30);
  const phone = digits(source.phone);
  const request = domain.text(source.request).slice(0, 200);
  const people = Number(source.people);
  const companions = Array.isArray(source.companions)
    ? source.companions.map(name => domain.text(name).slice(0, 20)).filter(Boolean)
    : [];

  if (booker.length < 1) errors.booker = '예약자 이름을 입력해주세요.';
  else if (booker.length > 30) errors.booker = '예약자 이름은 30자 이하로 입력해주세요.';
  if (!isPhone(phone)) errors.phone = '휴대전화번호 형식을 확인해주세요. (예: 010-1234-5678)';
  if (!Number.isInteger(people) || people < MIN_PEOPLE || people > (tee ? Number(tee.maxPlayers) : MAX_PEOPLE)) {
    errors.people = `예약 인원은 2~${tee ? Number(tee.maxPlayers) || MAX_PEOPLE : MAX_PEOPLE}명이어야 합니다.`;
  }
  if (companions.length > Math.max(0, (Number.isInteger(people) ? people : MAX_PEOPLE) - 1)) {
    errors.companions = '동반자 수가 예약 인원을 넘을 수 없습니다.';
  }

  const keys = Object.keys(errors);
  return {
    ok: keys.length === 0,
    errors,
    message: keys.length ? errors[keys[0]] : '',
    value: {
      booker,
      phone,
      request,
      people,
      companions,
      agreedTerms: source.terms === true,
      agreedRefund: source.refund === true
    }
  };
}

/* --- 가격 계산 ------------------------------------------------------------- */
function activeOfferFor(db, tee, now = new Date()) {
  const offers = (db.specialOffers || []).filter(offer => String(offer.teeTimeId) === String(tee.id) && !offer.deletedAt);
  const active = offers.find(offer => {
    const sold = operations.soldTeamsFor(db, offer.id);
    return operations.offerStatus(offer, now, sold) === 'active' && offer.visible !== false;
  });
  return active || null;
}

function pricingFor(db, tee, people, options = {}) {
  const rates = operations.effectiveRates(db, tee.courseId);
  const offer = options.offer === undefined ? activeOfferFor(db, tee, options.now ? new Date(options.now) : new Date()) : options.offer;
  const p4 = operations.priceForPeople(rates, tee.date, tee.greenFee, 4);
  const p2 = operations.priceForPeople(rates, tee.date, tee.greenFee, 2);
  const p3 = operations.priceForPeople(rates, tee.date, tee.greenFee, 3);
  const surcharge2 = Math.max(0, p2 - p4);
  const surcharge3 = Math.max(0, p3 - p4);
  const playerSurcharge = Number(people) === 2 ? surcharge2 : Number(people) === 3 ? surcharge3 : 0;
  const baseRegular = offer ? Number(offer.regularPrice) : p4;
  const baseApplied = offer ? Number(offer.specialPrice) : p4;
  const regularPerPerson = baseRegular + playerSurcharge;
  const appliedPerPerson = baseApplied + playerSurcharge;
  const greenTotal = appliedPerPerson * Number(people);
  const regularGreenTotal = regularPerPerson * Number(people);
  const cart = Number(rates.cartFee || 0);
  const caddie = Number(rates.caddieFee || 0);
  const totalEstimated = greenTotal + cart + caddie;
  const paidDeposit = operations.depositFor(rates, totalEstimated, people);
  return {
    rates,
    offer,
    baseAppliedGreenFee: baseApplied,
    baseRegularGreenFee: baseRegular,
    playerSurcharge,
    twoPlayerSurcharge: surcharge2,
    threePlayerSurcharge: surcharge3,
    appliedGreenFee: appliedPerPerson,
    regularGreenFee: regularPerPerson,
    greenFee: appliedPerPerson,
    greenTotal,
    regularGreenTotal,
    discountPerPerson: Math.max(0, baseRegular - baseApplied),
    discountTotal: Math.max(0, (baseRegular - baseApplied) * Number(people)),
    cart,
    caddie,
    totalEstimated,
    paidDeposit,
    online: paidDeposit,
    onsite: Math.max(0, totalEstimated - paidDeposit),
    cancellationPolicy: { ...DEFAULT_CANCELLATION_POLICY, ...(rates.cancellationPolicy || {}) }
  };
}

/* --- 예약 생성 ------------------------------------------------------------- */
/* options: { sessionId, holdId, idempotencyHash, actor, ip, now }
   호출 전에 라우터가 sweepExpiredHolds 를 실행한 상태(store.update 안)여야 한다. */
function createReservation(db, input, options = {}) {
  const now = options.now || Date.now();
  const nowDate = new Date(now);
  const courseId = String(input.courseId || '').trim();
  const date = String(input.date || '').trim();
  const teeTimeId = String(input.teeTimeId || '').trim();

  const tee = operations.findTeeTime(db, teeTimeId);
  if (!tee) return { ok: false, status: 404, code: 'tee_time_not_found', message: '티타임을 찾을 수 없습니다.' };
  if (String(tee.courseId) !== courseId) return { ok: false, status: 400, code: 'tee_time_mismatch', message: '티타임과 골프장 정보가 일치하지 않습니다.' };
  if (tee.date !== date) return { ok: false, status: 400, code: 'tee_time_mismatch', message: '티타임 날짜가 요청한 날짜와 다릅니다.' };
  if (tee.status !== 'open') return { ok: false, status: 409, code: 'sold_out', message: '현재 판매 중이 아닌 티타임입니다.' };

  const checked = validateReservationInput(input, { tee });
  if (!checked.ok) return { ok: false, status: 400, code: 'validation_failed', message: checked.message, errors: checked.errors };
  const value = checked.value;

  const hold = options.holdId ? findHold(db, options.holdId, now) : null;
  if (options.holdId && !hold) {
    return { ok: false, status: 409, code: 'hold_expired', message: '임시 확보 시간이 끝났습니다. 다시 선택해주세요.' };
  }
  if (hold) {
    if (String(hold.teeTimeId) !== String(tee.id) || hold.sessionId !== String(options.sessionId || hold.sessionId)) {
      return { ok: false, status: 409, code: 'hold_mismatch', message: '임시 확보 정보가 선택한 티타임과 다릅니다.' };
    }
  }

  /* 재고는 Lock 안에서 다시 계산한다. 내 Hold 는 이미 held 로 잡혀 있어 remaining 에서 빠져 있으므로,
     Hold 로 확정하는 경우에는 그 1팀을 되돌려 계산한다(마지막 1팀도 확정 가능). */
  const counts = inventoryFor(db, now);
  const remaining = operations.remainingTeams(tee, counts);
  if (remaining < 1 && !hold) {
    return { ok: false, status: 409, code: 'sold_out', message: '방금 마감된 티타임입니다. 다른 시간을 선택해주세요.' };
  }

  const pricing = pricingFor(db, tee, value.people, { now });
  const at = new Date(now).toISOString();
  const reservation = {
    id: `rsv-${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    number: nextReservationNumber(db, nowDate),
    courseId: String(tee.courseId),
    courseName: (db.approvedCourses || []).find(course => String(course.id) === String(tee.courseId))?.name || tee.courseName || null,
    teeTimeId: String(tee.id),
    date: tee.date,
    dateISO: tee.date,
    time: tee.time,
    session: tee.session || null,
    people: value.people,
    booker: value.booker,
    phone: value.phone,
    companions: value.companions,
    request: value.request,
    status: 'confirmed',
    version: 1,
    paymentStatus: 'demo_paid',
    pricing: {
      baseAppliedGreenFee: pricing.baseAppliedGreenFee,
      baseRegularGreenFee: pricing.baseRegularGreenFee,
      playerSurcharge: pricing.playerSurcharge,
      greenTotal: pricing.greenTotal,
      regularGreenTotal: pricing.regularGreenTotal,
      discountTotal: pricing.discountTotal,
      cart: pricing.cart,
      caddie: pricing.caddie,
      totalEstimated: pricing.totalEstimated,
      paidDeposit: pricing.paidDeposit,
      onsite: pricing.onsite
    },
    baseGreenFee: pricing.baseAppliedGreenFee,
    appliedGreenFee: pricing.appliedGreenFee,
    regularGreenFee: pricing.regularGreenFee,
    greenFee: pricing.greenFee,
    playerSurcharge: pricing.playerSurcharge,
    greenTotal: pricing.greenTotal,
    discountAmount: pricing.discountTotal,
    cart: pricing.cart,
    caddie: pricing.caddie,
    totalEstimated: pricing.totalEstimated,
    paidDeposit: pricing.paidDeposit,
    online: pricing.paidDeposit,
    onsite: pricing.onsite,
    specialOfferId: pricing.offer ? pricing.offer.id : null,
    specialOfferName: pricing.offer ? pricing.offer.name : null,
    specialOfferSnapshot: pricing.offer ? {
      id: pricing.offer.id,
      name: pricing.offer.name,
      regularPrice: Number(pricing.offer.regularPrice),
      specialPrice: Number(pricing.offer.specialPrice),
      discountRate: Number(pricing.offer.discountRate || 0),
      roundDate: pricing.offer.roundDate,
      time: pricing.offer.time
    } : null,
    cancellationPolicySnapshot: pricing.cancellationPolicy,
    holdId: hold ? hold.id : null,
    sessionId: options.sessionId ? String(options.sessionId).slice(0, 120) : null,
    idempotencyHash: options.idempotencyHash || null,
    source: 'server',
    createdBy: options.actor || { type: 'customer', ip: options.ip || null },
    createdAt: at,
    updatedAt: at,
    confirmedAt: at,
    cancelledAt: null,
    cancel: null,
    dataMode: 'demo',
    demo: true
  };

  if (hold) {
    hold.status = 'consumed';
    hold.consumedAt = at;
    hold.reservationId = reservation.id;
    hold.updatedAt = at;
  }

  db.reservations = Array.isArray(db.reservations) ? db.reservations : [];
  db.reservations.push(reservation);
  return { ok: true, status: 201, reservation, tee, pricing };
}

/* 멱등 키로 이미 만든 예약 찾기(같은 세션·같은 요청만). */
function findByIdempotency(db, hash, sessionId) {
  if (!hash) return null;
  return (db.reservations || []).find(item => item.idempotencyHash === hash
    && (!sessionId || String(item.sessionId || '') === String(sessionId))) || null;
}

function hashIdempotencyKey(key) {
  const text = String(key || '').trim();
  if (!text) return null;
  return crypto.createHash('sha256').update(text).digest('hex');
}

/* --- 조회 ------------------------------------------------------------------ */
function findReservation(db, reference) {
  const target = String(reference || '').trim();
  if (!target) return null;
  return (db.reservations || []).find(item => String(item.number) === target || String(item.id) === target) || null;
}

function ownsReservation(reservation, phone) {
  return Boolean(reservation) && digits(phone).length >= 10 && digits(reservation.phone) === digits(phone);
}

/* --- 취소·환불 ------------------------------------------------------------- */
function cancellationQuote(reservation, policy, now = new Date()) {
  const merged = { ...DEFAULT_CANCELLATION_POLICY, ...(policy || reservation.cancellationPolicySnapshot || {}) };
  const paidDeposit = Number(reservation.paidDeposit ?? reservation.online ?? 0);
  const roundDate = reservation.date || reservation.dateISO ? new Date(`${reservation.date || reservation.dateISO}T00:00:00`) : null;
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  const daysBefore = roundDate && Number.isFinite(roundDate.getTime())
    ? Math.ceil((roundDate.getTime() - base.getTime()) / 86400000)
    : 0;
  const refundRate = daysBefore >= 7 ? Number(merged.sevenPlus)
    : daysBefore >= 4 ? Number(merged.fourToSix)
      : daysBefore >= 2 ? Number(merged.twoToThree)
        : daysBefore === 1 ? Number(merged.oneDay)
          : Number(merged.sameDay);
  const rate = Number.isFinite(refundRate) ? Math.max(0, Math.min(100, refundRate)) : 0;
  const refundAmount = Math.max(0, Math.round(paidDeposit * rate / 100));
  const cutoff = merged.cutoffHoursBefore == null || merged.cutoffHoursBefore === ''
    ? null
    : Number(merged.cutoffHoursBefore);
  const roundAt = reservation.date || reservation.dateISO
    ? new Date(`${reservation.date || reservation.dateISO}T${reservation.time || '00:00'}:00`)
    : null;
  const deadlineAt = roundAt && cutoff != null && Number.isFinite(cutoff)
    ? new Date(roundAt.getTime() - cutoff * 3600000)
    : null;
  return {
    paidDeposit,
    daysBefore,
    refundRate: rate,
    refundAmount,
    cancellationFee: Math.max(0, paidDeposit - refundAmount),
    policy: merged,
    deadlineAt: deadlineAt ? deadlineAt.toISOString() : null,
    canCancel: !deadlineAt || now.getTime() <= deadlineAt.getTime()
  };
}

/* 예약 취소: 상태 전이 + 환불 계산 + 재고 복구. Lock 안에서 호출한다. */
function cancelReservation(db, reservation, options = {}) {
  const now = options.now || Date.now();
  const at = new Date(now).toISOString();
  if (reservation.status === 'cancelled') {
    return { ok: true, alreadyCancelled: true, inventoryRestored: false, reservation, refund: reservation.cancel ? { ...reservation.cancel } : null };
  }
  if (!['confirmed', 'completed', 'no_show'].includes(reservation.status)) {
    return { ok: false, status: 409, code: 'invalid_status', message: '취소할 수 없는 예약 상태입니다.' };
  }
  const rates = operations.effectiveRates(db, reservation.courseId);
  const refund = cancellationQuote(reservation, rates.cancellationPolicy, new Date(now));
  /* 관리자·골프장이 취소하는 경우에도 정책 계산 결과는 남기되, 고객 취소 기한 초과는 막는다.
     (강제 취소는 options.force 로 기한을 넘길 수 있다 — 본사 관리자 전용) */
  if (!refund.canCancel && !options.force) {
    return { ok: false, status: 409, code: 'cancel_deadline_passed', message: '취소 가능 기한이 지났습니다. 골프장에 문의해주세요.', refund };
  }
  reservation.status = 'cancelled';
  reservation.cancelledAt = at;
  reservation.updatedAt = at;
  reservation.version = Number(reservation.version || 1) + 1;
  reservation.cancelledBy = options.by || { type: 'customer' };
  reservation.cancelReason = options.reason || '사용자 취소';
  reservation.refundStatus = 'demo_refunded';
  reservation.cancellation = {
    at,
    by: options.by || { type: 'customer' },
    reason: reservation.cancelReason,
    paidDeposit: refund.paidDeposit,
    daysBefore: refund.daysBefore,
    refundRate: refund.refundRate,
    refundAmount: refund.refundAmount,
    cancellationFee: refund.cancellationFee,
    refundStatus: 'demo_refunded',
    policy: refund.policy
  };
  reservation.cancel = { ...reservation.cancellation };
  reservation.cancellationFee = refund.cancellationFee;
  reservation.refundAmount = refund.refundAmount;
  reservation.inventoryRestoredAt = at;
  return { ok: true, alreadyCancelled: false, inventoryRestored: true, reservation, refund };
}

/* 골프장·본사가 상태만 바꾸는 처리(취소는 cancelReservation 사용). */
function updateReservationStatus(db, reservation, nextStatus, options = {}) {
  const allowed = ['confirmed', 'completed', 'no_show'];
  if (!allowed.includes(nextStatus)) {
    return { ok: false, status: 400, code: 'invalid_status', message: '변경할 수 없는 예약 상태입니다.' };
  }
  if (reservation.status === nextStatus) {
    return { ok: true, changed: false, reservation };
  }
  if (reservation.status === 'cancelled') {
    return { ok: false, status: 409, code: 'already_cancelled', message: '취소된 예약의 상태는 변경할 수 없습니다.' };
  }
  const at = nowIso();
  reservation.status = nextStatus;
  reservation.updatedAt = at;
  reservation.version = Number(reservation.version || 1) + 1;
  reservation.statusUpdatedBy = options.by || null;
  reservation.statusReason = options.reason || '';
  if (nextStatus === 'completed') reservation.completedAt = at;
  if (nextStatus === 'no_show') reservation.noShowAt = at;
  return { ok: true, changed: true, reservation };
}

/* --- 화면·API 응답 --------------------------------------------------------- */
function publicReservation(reservation, options = {}) {
  const verified = options.verified === true;
  return {
    id: reservation.id,
    number: reservation.number,
    courseId: reservation.courseId,
    courseName: reservation.courseName,
    teeTimeId: reservation.teeTimeId,
    date: reservation.date,
    dateISO: reservation.dateISO || reservation.date,
    time: reservation.time,
    session: reservation.session,
    people: Number(reservation.people),
    booker: reservation.booker,
    phone: verified ? reservation.phone : maskPhone(reservation.phone),
    phoneVerified: verified,
    companions: Array.isArray(reservation.companions) ? reservation.companions.slice() : [],
    request: reservation.request || '',
    status: reservation.status,
    statusLabel: statusLabel(reservation.status),
    paymentStatus: reservation.paymentStatus,
    appliedGreenFee: reservation.appliedGreenFee,
    regularGreenFee: reservation.regularGreenFee,
    greenFee: reservation.greenFee,
    playerSurcharge: reservation.playerSurcharge,
    greenTotal: reservation.greenTotal,
    discountAmount: reservation.discountAmount,
    cart: reservation.cart,
    caddie: reservation.caddie,
    totalEstimated: reservation.totalEstimated,
    paidDeposit: reservation.paidDeposit,
    onsite: reservation.onsite,
    specialOfferId: reservation.specialOfferId || null,
    specialOfferName: reservation.specialOfferName || null,
    specialOfferSnapshot: reservation.specialOfferSnapshot || null,
    cancellationPolicySnapshot: reservation.cancellationPolicySnapshot || null,
    createdAt: reservation.createdAt,
    updatedAt: reservation.updatedAt,
    cancelledAt: reservation.cancelledAt || null,
    cancelReason: reservation.cancelReason || null,
    cancellationFee: reservation.cancellationFee == null ? null : reservation.cancellationFee,
    refundAmount: reservation.refundAmount == null ? null : reservation.refundAmount,
    refundStatus: reservation.refundStatus || null,
    cancellation: reservation.cancellation ? { ...reservation.cancellation } : null,
    source: 'server',
    demo: true,
    dataMode: 'demo'
  };
}

function partnerReservation(db, reservation, options = {}) {
  return {
    ...publicReservation(reservation, { verified: true }),
    courseName: reservation.courseName || (db.approvedCourses || []).find(course => String(course.id) === String(reservation.courseId))?.name || null,
    version: reservation.version,
    createdBy: reservation.createdBy || null,
    cancelledBy: reservation.cancelledBy || null,
    statusUpdatedBy: reservation.statusUpdatedBy || null,
    statusReason: reservation.statusReason || '',
    quote: cancellationQuote(reservation, operations.effectiveRates(db, reservation.courseId).cancellationPolicy)
  };
}

/* --- 정리 ------------------------------------------------------------------ */
function statsFor(db, options = {}) {
  const date = options.date || null;
  const courseId = options.courseId ? String(options.courseId) : null;
  const items = (db.reservations || []).filter(item => (!courseId || String(item.courseId) === courseId) && (!date || item.date === date));
  const byStatus = {};
  RESERVATION_STATUSES.forEach(status => { byStatus[status] = 0; });
  items.forEach(item => { byStatus[item.status] = (byStatus[item.status] || 0) + 1; });
  const confirmed = items.filter(item => item.status === 'confirmed');
  return {
    total: items.length,
    confirmed: byStatus.confirmed || 0,
    cancelled: byStatus.cancelled || 0,
    completed: byStatus.completed || 0,
    noShow: byStatus.no_show || 0,
    people: confirmed.reduce((sum, item) => sum + Number(item.people || 0), 0),
    paidDeposit: confirmed.reduce((sum, item) => sum + Number(item.paidDeposit || 0), 0),
    refundAmount: items.filter(item => item.status === 'cancelled').reduce((sum, item) => sum + Number(item.refundAmount || 0), 0)
  };
}

module.exports = {
  RESERVATION_STATUSES,
  RESERVATION_STATUS_LABELS,
  ACTIVE_RESERVATION_STATUSES,
  HOLD_STATUS_LABELS,
  DEFAULT_HOLD_TTL_MS,
  DEFAULT_CANCELLATION_POLICY,
  MIN_PEOPLE,
  MAX_PEOPLE,
  statusLabel,
  holdStatusLabel,
  digits,
  maskPhone,
  isPhone,
  activeHold,
  holdTtlMs,
  inventoryFor,
  remainingFor,
  sweepExpiredHolds,
  activeHoldsFor,
  holdView,
  findHold,
  createHold,
  releaseHold,
  nextReservationNumber,
  validateReservationInput,
  activeOfferFor,
  pricingFor,
  createReservation,
  findByIdempotency,
  hashIdempotencyKey,
  findReservation,
  ownsReservation,
  cancellationQuote,
  cancelReservation,
  updateReservationStatus,
  publicReservation,
  partnerReservation,
  statsFor
};
