'use strict';
/* ALL:GOLF 7단계 운영 도메인: 티타임·요금·특가
   - 골프장별 데이터는 courseId 로만 구분하고, 권한 검사는 라우터에서 세션 기준으로 한다.
   - 가격 계산은 고객 앱(data/shared-store.js)과 같은 기준을 쓴다.
     4인 기준 1인 그린피(price) + 인원별 추가금(2·3인) 구조.
   - 특가·요금 변경은 고객 앱 공개 카탈로그에 반영된다. */

const crypto = require('crypto');
const domain = require('./domain');

const TEE_STATUSES = ['open', 'stopped', 'closed'];
const TEE_STATUS_LABELS = { open: '판매 중', stopped: '판매 중지', closed: '마감' };
const SESSIONS = ['1부', '2부', '3부'];
const MAX_TEAMS = 20;
const MAX_PEOPLE = 4;
const MIN_PEOPLE = 2;
const MAX_PRICE = 10000000;
const DEPOSIT_TYPES = ['none', 'team', 'person', 'percent'];
const OFFER_STATUS_LABELS = {
  scheduled: '예정', active: '진행 중', ended: '종료', paused: '중지', soldout: '매진', deleted: '삭제'
};

const teeStatusLabel = status => TEE_STATUS_LABELS[status] || status;
const offerStatusLabel = status => OFFER_STATUS_LABELS[status] || status;

const isMoney = value => Number.isInteger(value) && value >= 0 && value <= MAX_PRICE;
const isTime = value => /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || ''));
const isIsoDateTime = value => {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.test(text)) return false;
  return Number.isFinite(new Date(text).getTime());
};
const toIso = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const timeToDate = (date, time) => new Date(`${date}T${time}:00`);

function sessionForTime(time) {
  const hour = Number(String(time || '00').slice(0, 2));
  if (hour < 10) return '1부';
  if (hour < 14) return '2부';
  return '3부';
}

function todayKst() {
  return domain.kstStamp().date;
}

function addDaysIso(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function nextId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

/* --- 요금 ------------------------------------------------------------------ */
function defaultRates(course, courseId) {
  const green = (course && course.greenFee) || {};
  const weekday = Number(green.weekday);
  const base = Number.isFinite(weekday) && weekday > 0 ? Math.round(weekday) : 150000;
  const cart = Number(green.cart);
  const caddie = Number(green.caddie);
  return {
    courseId: String(courseId),
    baseGreenFee: base,
    weekdayGreenFee: null,
    weekendGreenFee: null,
    threePlayerGreenFee: null,
    threePlayerSurcharge: 10000,
    fourPlayerGreenFee: null,
    twoPlayerSurcharge: 0,
    cartFee: Number.isFinite(cart) && cart >= 0 ? cart : 100000,
    caddieFee: Number.isFinite(caddie) && caddie >= 0 ? caddie : 150000,
    depositType: 'person',
    depositValue: 30000,
    version: 0,
    updatedAt: null,
    updatedBy: null,
    source: 'server',
    dataMode: 'demo'
  };
}

function effectiveRates(db, courseId) {
  const course = (db.approvedCourses || []).find(item => String(item.id) === String(courseId));
  const base = defaultRates(course, courseId);
  const stored = (db.rates && db.rates[String(courseId)]) || null;
  if (!stored) return base;
  return { ...base, ...stored, courseId: String(courseId) };
}

function validateRates(input) {
  const source = input && typeof input === 'object' ? input : {};
  const errors = {};
  const numberOrNull = (field, label, { required = false, max = MAX_PRICE } = {}) => {
    const raw = source[field];
    if (raw === '' || raw == null) {
      if (required) { errors[field] = `${label}을(를) 입력해주세요.`; return null; }
      return null;
    }
    const value = Number(String(raw).replace(/[,\s원]/g, ''));
    if (!Number.isInteger(value) || value < 0 || value > max) {
      errors[field] = `${label}은(는) 0원 이상 ${max.toLocaleString('ko-KR')}원 이하 숫자로 입력해주세요.`;
      return null;
    }
    return value;
  };
  const baseGreenFee = numberOrNull('baseGreenFee', '기본 그린피(1인)', { required: true });
  const weekdayGreenFee = numberOrNull('weekdayGreenFee', '평일 그린피');
  const weekendGreenFee = numberOrNull('weekendGreenFee', '주말 그린피');
  const threePlayerGreenFee = numberOrNull('threePlayerGreenFee', '3인 1인 그린피');
  const fourPlayerGreenFee = numberOrNull('fourPlayerGreenFee', '4인 1인 그린피');
  const threePlayerSurcharge = numberOrNull('threePlayerSurcharge', '3인 추가금', { max: 1000000 }) || 0;
  const twoPlayerSurcharge = numberOrNull('twoPlayerSurcharge', '2인 추가금', { max: 1000000 }) || 0;
  const cartFee = numberOrNull('cartFee', '카트비');
  const caddieFee = numberOrNull('caddieFee', '캐디피');
  const depositType = DEPOSIT_TYPES.includes(source.depositType) ? source.depositType : 'person';
  if (source.depositType != null && source.depositType !== '' && !DEPOSIT_TYPES.includes(source.depositType)) {
    errors.depositType = '예약금 방식이 올바르지 않습니다.';
  }
  let depositValue = 0;
  if (depositType !== 'none') {
    depositValue = numberOrNull('depositValue', '예약금') || 0;
    if (depositType === 'percent' && depositValue > 100) errors.depositValue = '비율 예약금은 100%를 넘을 수 없습니다.';
    if (depositType !== 'percent' && source.depositValue === '') errors.depositValue = '예약금 금액을 입력해주세요.';
  }
  const keys = Object.keys(errors);
  return {
    ok: keys.length === 0,
    errors,
    message: keys.length ? errors[keys[0]] : '',
    value: {
      baseGreenFee,
      weekdayGreenFee,
      weekendGreenFee,
      threePlayerGreenFee,
      fourPlayerGreenFee,
      threePlayerSurcharge,
      twoPlayerSurcharge,
      cartFee,
      caddieFee,
      depositType,
      depositValue
    }
  };
}

function rateForDate(rates, date) {
  const weekend = [0, 6].includes(new Date(`${date}T00:00:00`).getDay());
  const configured = weekend ? rates.weekendGreenFee : rates.weekdayGreenFee;
  if (configured != null && Number(configured) >= 0) return Number(configured);
  return Number(rates.baseGreenFee) || 0;
}

/* 4인 기준 1인 그린피(price)와 인원별 1인 그린피. 앱은 price + 추가금 구조를 쓴다. */
function priceForPeople(rates, date, teeGreenFee, people) {
  const base = teeGreenFee != null && Number.isFinite(Number(teeGreenFee))
    ? Number(teeGreenFee)
    : rateForDate(rates, date);
  if (Number(people) === MIN_PEOPLE) return base + Number(rates.twoPlayerSurcharge || 0);
  if (Number(people) === 3) {
    return rates.threePlayerGreenFee != null ? Number(rates.threePlayerGreenFee) : base + Number(rates.threePlayerSurcharge || 0);
  }
  return rates.fourPlayerGreenFee != null ? Number(rates.fourPlayerGreenFee) : base;
}

function quote(rates, date, teeGreenFee) {
  const list = [2, 3, 4].map(people => ({ people, perPerson: priceForPeople(rates, date, teeGreenFee, people) }));
  const price = priceForPeople(rates, date, teeGreenFee, 4);
  return { price, list };
}

/* 고객 앱에 동기화할 요금(앱 계산식과 같은 의미로 변환). */
function clientRates(rates, date, teeGreenFee) {
  const price = priceForPeople(rates, date, teeGreenFee, 4);
  return {
    weekdayGreenFee: null,
    weekendGreenFee: null,
    baseGreenFee: price,
    twoPlayerSurcharge: Math.max(0, priceForPeople(rates, date, teeGreenFee, 2) - price),
    threePlayerSurcharge: Math.max(0, priceForPeople(rates, date, teeGreenFee, 3) - price),
    cartFee: rates.cartFee,
    caddieFee: rates.caddieFee,
    depositType: rates.depositType,
    depositValue: rates.depositValue,
    source: 'server',
    dataMode: 'demo'
  };
}

function depositFor(rates, totalEstimated, people) {
  const type = rates.depositType || 'person';
  const value = Number(rates.depositValue || 0);
  if (type === 'none') return 0;
  if (type === 'team') return Math.max(0, value);
  if (type === 'percent') return Math.max(0, Math.round(Number(totalEstimated || 0) * value / 100));
  return Math.max(0, value * Number(people || 0));
}

/* --- 티타임 ---------------------------------------------------------------- */
const TEE_TIME_FIELDS = ['course', 'date', 'time', 'session', 'capacityTeams', 'maxPlayers', 'greenFee', 'status', 'note'];

function validateTeeTime(input, options = {}) {
  const { partial = false, existing = null, today = todayKst() } = options;
  const source = input && typeof input === 'object' ? input : {};
  const errors = {};
  const pick = field => (partial && source[field] === undefined ? existing && existing[field] : source[field]);

  const courseName = domain.text(pick('course')) || '전체';
  const date = String(pick('date') || '').trim();
  const time = String(pick('time') || '').trim();
  const statusValue = TEE_STATUSES.includes(pick('status')) ? pick('status') : (partial && existing && existing.status) || 'open';
  const note = domain.text(pick('note')).slice(0, 200);

  if (courseName.length > 30) errors.course = '코스명은 30자 이하로 입력해주세요.';
  if (!domain.isValidDate(date)) errors.date = '라운드 날짜는 YYYY-MM-DD 형식이어야 합니다.';
  else if (date < today) errors.date = '지난 날짜에는 티타임을 등록할 수 없습니다.';
  else if (date > addDaysIso(today, 366)) errors.date = '티타임은 1년 이내 날짜만 등록할 수 있습니다.';
  if (!isTime(time)) errors.time = '티오프 시간은 HH:MM 형식이어야 합니다.';
  else {
    const hour = Number(time.slice(0, 2));
    if (hour < 4 || hour > 20) errors.time = '티오프 시간은 04:00~20:00 사이로 입력해주세요.';
    else if (hour === 20 && Number(time.slice(3, 5)) > 0) errors.time = '티오프 시간은 20:00까지 입력할 수 있습니다.';
  }

  let session = pick('session');
  if (session === undefined || session === null || session === '') session = isTime(time) ? sessionForTime(time) : '';
  if (!SESSIONS.includes(session)) errors.session = '부는 1부·2부·3부 중 하나여야 합니다.';
  else if (isTime(time) && session !== sessionForTime(time)) {
    errors.session = `티오프 시간(${time})에 맞는 부는 ${sessionForTime(time)}입니다.`;
  }

  const capacityTeams = Number(pick('capacityTeams'));
  if (!Number.isInteger(capacityTeams) || capacityTeams < 1 || capacityTeams > MAX_TEAMS) {
    errors.capacityTeams = `예약 가능 팀 수는 1~${MAX_TEAMS}팀 사이 정수로 입력해주세요.`;
  }
  const maxPlayers = Number(pick('maxPlayers'));
  if (!Number.isInteger(maxPlayers) || maxPlayers < MIN_PEOPLE || maxPlayers > MAX_PEOPLE) {
    errors.maxPlayers = '최대 예약 인원은 2~4명 사이로 입력해주세요.';
  }
  const greenFee = Number(pick('greenFee'));
  if (!Number.isInteger(greenFee) || greenFee < 0 || greenFee > MAX_PRICE) {
    errors.greenFee = `기본 그린피는 0원 이상 ${MAX_PRICE.toLocaleString('ko-KR')}원 이하 숫자로 입력해주세요.`;
  }
  if (pick('status') != null && pick('status') !== '' && !TEE_STATUSES.includes(pick('status'))) {
    errors.status = '상태는 판매 중·판매 중지·마감 중 하나여야 합니다.';
  }

  const keys = Object.keys(errors);
  return {
    ok: keys.length === 0,
    errors,
    message: keys.length ? errors[keys[0]] : '',
    value: { course: courseName, date, time, session, capacityTeams, maxPlayers, greenFee, status: statusValue, note }
  };
}

function findTeeTime(db, id) {
  return (db.teeTimes || []).find(item => String(item.id) === String(id)) || null;
}

function findDuplicateTeeTime(db, value, ignoreId = null) {
  return (db.teeTimes || []).find(item => String(item.id) !== String(ignoreId || '')
    && String(item.courseId) === String(value.courseId)
    && item.date === value.date
    && item.time === value.time
    && domain.text(item.course) === domain.text(value.course)) || null;
}

function remainingTeams(tee) {
  const booked = Number(tee.bookedTeams || 0) + Number(tee.heldTeams || 0);
  return Math.max(0, Number(tee.capacityTeams || 0) - booked);
}

function teeTimeStatus(tee) {
  if (tee.status === 'closed') return 'closed';
  if (tee.status === 'stopped') return 'stopped';
  if (remainingTeams(tee) < 1) return 'closed';
  return 'open';
}

function teeTimeForPartner(tee, rates) {
  const status = teeTimeStatus(tee);
  const q = quote(rates, tee.date, tee.greenFee);
  return {
    ...tee,
    remaining: remainingTeams(tee),
    status,
    statusLabel: teeStatusLabel(status),
    closed: status !== 'open',
    price: q.price,
    priceByPlayers: Object.fromEntries(q.list.map(item => [item.people, item.perPerson])),
    dataMode: 'demo'
  };
}

/* 예약·임시확보·연결 특가가 있는지 확인한다(삭제 차단 근거). */
function teeTimeUsage(db, tee) {
  const reservations = (db.reservations || []).filter(item => String(item.teeTimeId) === String(tee.id) && item.status !== 'cancelled');
  const holds = (db.bookingHolds || []).filter(item => String(item.teeTimeId) === String(tee.id));
  const offers = (db.specialOffers || []).filter(item => String(item.teeTimeId) === String(tee.id) && !item.deletedAt);
  const booked = Number(tee.bookedTeams || 0) + reservations.length;
  const held = Number(tee.heldTeams || 0) + holds.length;
  return {
    reservations: reservations.length,
    holds: holds.length,
    offers: offers.length,
    bookedTeams: booked,
    heldTeams: held,
    inUse: booked > 0 || held > 0 || remainingTeams(tee) < Number(tee.capacityTeams || 0)
  };
}

/* --- 특가 ------------------------------------------------------------------ */
function offerStatus(offer, now = new Date(), soldTeams = 0) {
  if (!offer) return 'deleted';
  if (offer.deletedAt) return 'deleted';
  if (offer.paused) return 'paused';
  const start = new Date(offer.saleStartAt).getTime();
  const end = new Date(offer.saleEndAt).getTime();
  if (Number.isFinite(start) && now.getTime() < start) return 'scheduled';
  if (Number.isFinite(end) && now.getTime() > end) return 'ended';
  if (Number(offer.teamLimit) > 0 && soldTeams >= Number(offer.teamLimit)) return 'soldout';
  return 'active';
}

function soldTeamsFor(db, offerId) {
  return (db.reservations || []).filter(item => String(item.specialOfferId) === String(offerId) && item.status !== 'cancelled').length;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  const a1 = new Date(aStart).getTime();
  const a2 = new Date(aEnd).getTime();
  const b1 = new Date(bStart).getTime();
  const b2 = new Date(bEnd).getTime();
  if (![a1, a2, b1, b2].every(Number.isFinite)) return false;
  return a1 < b2 && b1 < a2;
}

function validateSpecialOffer(input, options = {}) {
  const { partial = false, existing = null, tee = null, offers = [], db = null, now = new Date() } = options;
  const source = input && typeof input === 'object' ? input : {};
  const errors = {};
  const pick = field => (partial && source[field] === undefined ? existing && existing[field] : source[field]);

  const name = domain.text(pick('name')).slice(0, 60);
  const description = domain.text(pick('description')).slice(0, 300);
  const roundDate = String(pick('roundDate') || (tee && tee.date) || '').trim();
  const teeTimeId = domain.text(pick('teeTimeId'));
  const regularPrice = Number(pick('regularPrice'));
  const specialPrice = Number(pick('specialPrice'));
  const teamLimit = Number(pick('teamLimit'));
  const saleStartAt = toIso(pick('saleStartAt'));
  const saleEndAt = toIso(pick('saleEndAt'));
  const visible = pick('visible') !== false;
  const paused = Boolean(pick('paused'));

  if (name.length < 2 || name.length > 60) errors.name = '특가명을 2~60자로 입력해주세요.';
  if (!teeTimeId) errors.teeTimeId = '특가를 연결할 티타임을 선택해주세요.';
  if (!domain.isValidDate(roundDate)) errors.roundDate = '라운드 날짜가 올바르지 않습니다.';
  else if (tee && tee.date !== roundDate) errors.roundDate = '티타임의 라운드 날짜와 같아야 합니다.';
  if (!Number.isInteger(regularPrice) || regularPrice < 1 || regularPrice > MAX_PRICE) {
    errors.regularPrice = '정상 그린피는 1원 이상 숫자로 입력해주세요.';
  }
  if (!Number.isInteger(specialPrice) || specialPrice < 0 || specialPrice > MAX_PRICE) {
    errors.specialPrice = '특가 그린피는 0원 이상 숫자로 입력해주세요.';
  } else if (Number.isInteger(regularPrice) && specialPrice >= regularPrice) {
    errors.specialPrice = '특가 그린피는 정상 그린피보다 낮아야 합니다.';
  }
  if (!Number.isInteger(teamLimit) || teamLimit < 1 || teamLimit > MAX_TEAMS) {
    errors.teamLimit = `특가 적용 팀 수는 1~${MAX_TEAMS}팀 사이로 입력해주세요.`;
  } else if (tee && teamLimit > Number(tee.capacityTeams)) {
    errors.teamLimit = '특가 적용 팀 수는 티타임 예약 가능 팀 수를 넘을 수 없습니다.';
  }
  if (!isIsoDateTime(pick('saleStartAt'))) errors.saleStartAt = '판매 시작 일시를 입력해주세요.';
  if (!isIsoDateTime(pick('saleEndAt'))) errors.saleEndAt = '판매 종료 일시를 입력해주세요.';
  if (isIsoDateTime(pick('saleStartAt')) && isIsoDateTime(pick('saleEndAt'))) {
    if (new Date(saleEndAt).getTime() <= new Date(saleStartAt).getTime()) {
      errors.saleEndAt = '판매 종료 일시는 시작 일시보다 늦어야 합니다.';
    } else if (!existing && new Date(saleEndAt).getTime() < now.getTime()) {
      errors.saleEndAt = '이미 지난 판매 기간에는 특가를 등록할 수 없습니다.';
    }
  }
  if (source.visible !== undefined && typeof source.visible !== 'boolean') errors.visible = '노출 여부가 올바르지 않습니다.';
  if (source.paused !== undefined && typeof source.paused !== 'boolean') errors.paused = '판매 중지 값이 올바르지 않습니다.';

  const overlap = Object.keys(errors).length ? null : (offers || []).find(offer => (
    String(offer.id) !== String((existing && existing.id) || '')
    && !offer.deletedAt
    && !offer.paused
    && String(offer.teeTimeId) === String(teeTimeId)
    && rangesOverlap(saleStartAt, saleEndAt, offer.saleStartAt, offer.saleEndAt)
  ));
  if (overlap) errors.period = '같은 티타임의 판매 기간과 겹치는 특가가 이미 있습니다.';

  const keys = Object.keys(errors);
  return {
    ok: keys.length === 0,
    code: overlap ? 'offer_overlap' : 'validation_failed',
    errors,
    message: keys.length ? errors[keys[0]] : '',
    value: {
      name,
      description,
      roundDate,
      teeTimeId,
      time: tee ? tee.time : domain.text(pick('time')),
      regularPrice,
      specialPrice,
      teamLimit,
      saleStartAt,
      saleEndAt,
      visible,
      paused
    }
  };
}

function offerForPublic(db, offer) {
  const sold = soldTeamsFor(db, offer.id);
  const status = offerStatus(offer, new Date(), sold);
  return {
    id: offer.id,
    courseId: offer.courseId,
    teeTimeId: offer.teeTimeId,
    roundDate: offer.roundDate,
    time: offer.time,
    name: offer.name,
    description: offer.description || '',
    regularPrice: Number(offer.regularPrice),
    specialPrice: Number(offer.specialPrice),
    discountAmount: Number(offer.discountAmount || (Number(offer.regularPrice) - Number(offer.specialPrice))),
    discountRate: Number(offer.discountRate || 0),
    saleStartAt: offer.saleStartAt,
    saleEndAt: offer.saleEndAt,
    teamLimit: Number(offer.teamLimit),
    soldTeams: sold,
    visible: offer.visible !== false,
    paused: Boolean(offer.paused),
    status,
    statusLabel: offerStatusLabel(status),
    version: offer.version,
    updatedAt: offer.updatedAt,
    deletedAt: offer.deletedAt || null,
    source: 'server',
    dataMode: 'demo'
  };
}

function offerForPartner(db, offer) {
  const publicView = offerForPublic(db, offer);
  return {
    ...offer,
    status: publicView.status,
    statusLabel: publicView.statusLabel,
    soldTeams: publicView.soldTeams,
    dataMode: 'demo'
  };
}

/* --- 공개 카탈로그 --------------------------------------------------------- */
function publicTeeTime(db, tee, rates, offers) {
  const status = teeTimeStatus(tee);
  const q = quote(rates, tee.date, tee.greenFee);
  const remaining = remainingTeams(tee);
  const activeOffer = (offers || []).find(offer => {
    if (String(offer.teeTimeId) !== String(tee.id)) return false;
    const sold = soldTeamsFor(db, offer.id);
    const offerState = offerStatus(offer, new Date(), sold);
    return offerState === 'active' && offer.visible !== false;
  }) || null;
  const offerView = activeOffer ? offerForPublic(db, activeOffer) : null;
  return {
    id: tee.id,
    courseId: String(tee.courseId),
    course: tee.course,
    date: tee.date,
    time: tee.time,
    session: tee.session,
    capacityTeams: Number(tee.capacityTeams),
    maxPlayers: Number(tee.maxPlayers),
    remaining,
    greenFee: q.price,
    price: q.price,
    regular: q.price,
    priceByPlayers: Object.fromEntries(q.list.map(item => [item.people, item.perPerson])),
    status,
    statusLabel: teeStatusLabel(status),
    closed: status !== 'open' || remaining < 1,
    special: Boolean(offerView),
    specialOffer: offerView,
    regularPrice: offerView ? Number(offerView.regularPrice) : q.price,
    appliedPrice: offerView ? Number(offerView.specialPrice) : q.price,
    instant: true,
    serverManaged: true,
    source: 'server',
    version: tee.version,
    updatedAt: tee.updatedAt,
    dataMode: 'demo',
    notice: '골프장이 서버에 등록한 시연 티타임입니다. 예약 재고 연동(잠금·차감)은 8단계 범위입니다.'
  };
}

function publicCatalog(db, options = {}) {
  const date = options.date;
  const courseFilter = options.courseId ? String(options.courseId) : null;
  const teeTimes = (db.teeTimes || []).filter(item => item.date === date && (!courseFilter || String(item.courseId) === courseFilter));
  const courseIds = [...new Set(teeTimes.map(item => String(item.courseId)))];
  if (courseFilter && !courseIds.includes(courseFilter)) courseIds.push(courseFilter);
  const courses = courseIds.map(courseId => {
    const course = (db.approvedCourses || []).find(item => String(item.id) === courseId) || null;
    const rates = effectiveRates(db, courseId);
    const offers = (db.specialOffers || []).filter(item => String(item.courseId) === courseId && item.roundDate === date && !item.deletedAt);
    const times = teeTimes.filter(item => String(item.courseId) === courseId)
      .slice()
      .sort((a, b) => String(a.time).localeCompare(String(b.time)))
      .map(item => publicTeeTime(db, item, rates, offers));
    const priceSource = times[0] ? times[0].greenFee : rateForDate(rates, date);
    return {
      courseId,
      courseName: course ? course.name : null,
      rates: clientRates(rates, date, priceSource),
      teeTimes: times,
      offers: offers.map(item => offerForPublic(db, item))
    };
  });
  return {
    ok: true,
    mode: 'server',
    date,
    count: courses.reduce((sum, course) => sum + course.teeTimes.length, 0),
    courses,
    managedCourseIds: [...new Set((db.teeTimes || []).map(item => String(item.courseId)))],
    inventoryLinked: false,
    inventoryNote: '서버 티타임은 골프장이 등록한 운영 정보입니다. 고객 예약 재고(차감·잠금)는 아직 브라우저 시연 데이터이며 서버와 공유되지 않습니다(8단계).',
    dataMode: 'demo',
    updatedAt: db.meta ? db.meta.updatedAt : null
  };
}

module.exports = {
  TEE_STATUSES,
  TEE_STATUS_LABELS,
  SESSIONS,
  MAX_TEAMS,
  MAX_PRICE,
  DEPOSIT_TYPES,
  OFFER_STATUS_LABELS,
  teeStatusLabel,
  offerStatusLabel,
  sessionForTime,
  todayKst,
  addDaysIso,
  nextId,
  defaultRates,
  effectiveRates,
  validateRates,
  rateForDate,
  priceForPeople,
  quote,
  clientRates,
  depositFor,
  validateTeeTime,
  findTeeTime,
  findDuplicateTeeTime,
  remainingTeams,
  teeTimeStatus,
  teeTimeForPartner,
  teeTimeUsage,
  offerStatus,
  soldTeamsFor,
  validateSpecialOffer,
  offerForPublic,
  offerForPartner,
  publicTeeTime,
  publicCatalog
};
