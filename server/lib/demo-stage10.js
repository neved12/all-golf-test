'use strict';
/* ALL:GOLF 10단계 — 원클릭 시연 데이터(투자자·골프장 제휴 시연용)
   - 실제 운영·수동 입력 데이터와 섞이지 않도록, 이 모듈이 만든 레코드는 전부
     `demoStage: 'stage10'` + `demoBatch` 태그를 붙이고 매니페스트(db.meta.demoStage10)에 id 를 남긴다.
   - 초기화(reset)는 태그가 붙은 레코드만 지운다. 태그가 없는 레코드는 손대지 않는다.
     (그래서 시연 중 만든 일반 테스트 데이터나 실제 입력 데이터가 사라지지 않는다.)
   - 되돌릴 수 없는 삭제이므로 호출자가 확인 문구(CONFIRM_RESET)를 넘겨야 실행된다.
   - 외부 패키지 없이 Node.js 내장 모듈만 사용한다. */

const domain = require('./domain');
const operations = require('./operations');
const accounts = require('./accounts');
const reservations = require('./reservations');
const analytics = require('./analytics');

const DEMO_STAGE = 'stage10';
const CONFIRM_STAGE = 'STAGE-STAGE10-DEMO';
const CONFIRM_RESET = 'RESET-STAGE10-DEMO';
const DEMO_PARTNER_PASSWORD = 'allgolf-partner-2026';
const DEMO_COURSE_IDS = ['woojeong', 'emerson', 'princess'];
const TEE_TIMES = ['07:12', '08:24', '12:31', '13:20'];
const TEE_DAYS = 7;
const TEAMS_PER_TEE = 3;
const MAX_PLAYERS = 4;

const APPLICANT = { name: '시연 신청 골프장', email: 'demo-stage10@allgolf.demo', phone: '010-0000-0000' };

function guardedError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status || 400;
  return error;
}

function nextId(prefix, stamp) {
  return `${prefix}-${stamp.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function catalogCourse(catalog, id) {
  return catalog && catalog.byId ? catalog.byId.get(String(id)) : null;
}

function demoGreenFee(catalog, id) {
  const demo = catalog && catalog.demo ? catalog.demo[String(id)] : null;
  const value = demo && Number(demo.demoGreenFee);
  if (Number.isFinite(value) && value > 0) return Math.round(value);
  const course = catalogCourse(catalog, id);
  const weekday = course && course.greenFee ? Number(course.greenFee.weekday) : NaN;
  return Number.isFinite(weekday) && weekday > 0 ? Math.round(weekday) : 150000;
}

/* 매니페스트: 이번 시연 배치가 만든 레코드 id 목록. 태그와 함께 이중으로 확인한다. */
function manifestOf(db) {
  db.meta = db.meta && typeof db.meta === 'object' ? db.meta : {};
  const current = db.meta.demoStage10;
  if (!current || typeof current !== 'object') return null;
  return current;
}

function taggedBatch(db) {
  const manifest = manifestOf(db);
  return manifest && manifest.batch ? String(manifest.batch) : '';
}

function isStage10Record(item) {
  return Boolean(item) && item.demoStage === DEMO_STAGE;
}

function courseRecord(course, courseId, greenFee) {
  return {
    id: String(courseId),
    applicationId: null,
    name: domain.text(course && course.name) || courseId,
    region: domain.text(course && course.region),
    city: domain.text(course && course.city),
    address: domain.text(course && course.address),
    operationType: ['public', 'membership', 'mixed', 'unknown'].includes(course && course.operationType) ? course.operationType : 'unknown',
    holes: Number(course && course.holes) || null,
    phone: domain.text(course && course.phone) || null,
    website: domain.text(course && (course.officialWebsite || course.website)) || null,
    source: 'stage10-demo',
    greenFee: { weekday: Number(greenFee) || demoGreenFee(null, courseId), weekend: null, cart: null, caddie: null, teeInterval: null },
    approvedAt: new Date().toISOString(),
    approvedBy: 'system@allgolf.demo',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

/* --- 상태 ----------------------------------------------------------------- */
function demoStatus(db) {
  const manifest = manifestOf(db);
  const allTagged = {
    approvedCourses: (db.approvedCourses || []).filter(isStage10Record).length,
    teeTimes: (db.teeTimes || []).filter(isStage10Record).length,
    rates: Object.values(db.rates || {}).filter(isStage10Record).length,
    commissionRates: Object.values(db.commissionRates || {}).filter(isStage10Record).length,
    specialOffers: (db.specialOffers || []).filter(isStage10Record).length,
    partnerAccounts: (db.partnerAccounts || []).filter(isStage10Record).length,
    reservations: (db.reservations || []).filter(isStage10Record).length,
    bookingHolds: (db.bookingHolds || []).filter(isStage10Record).length,
    settlements: (db.settlements || []).filter(isStage10Record).length,
    notificationLogs: (db.notificationLogs || []).filter(isStage10Record).length,
    auditLogs: (db.auditLogs || []).filter(isStage10Record).length
  };
  const manual = {
    approvedCourses: (db.approvedCourses || []).filter(item => !isStage10Record(item)).length,
    teeTimes: (db.teeTimes || []).filter(item => !isStage10Record(item)).length,
    partnerAccounts: (db.partnerAccounts || []).filter(item => !isStage10Record(item)).length,
    reservations: (db.reservations || []).filter(item => !isStage10Record(item)).length,
    settlements: (db.settlements || []).filter(item => !isStage10Record(item)).length,
    applications: (db.applications || []).length
  };
  return {
    ok: true,
    stage: 10,
    dataMode: 'demo',
    staged: Boolean(manifest && manifest.stagedAt),
    batch: manifest ? manifest.batch || null : null,
    stagedAt: manifest ? manifest.stagedAt || null : null,
    stagedBy: manifest ? manifest.stagedBy || null : null,
    demo: allTagged,
    demoTotal: Object.values(allTagged).reduce((total, value) => total + value, 0),
    protectedRecords: manual,
    protectedTotal: Object.values(manual).reduce((total, value) => total + value, 0),
    courses: manifest && Array.isArray(manifest.courses) ? manifest.courses.slice() : [],
    partnerLoginHint: DEMO_COURSE_IDS.map(id => ({ courseId: id })),
    statements: {
      isolation: '시연 데이터는 demoStage=stage10 태그로만 구분하며, 초기화는 태그가 붙은 레코드만 지웁니다.',
      notReal: '실제 결제·계좌 이체·문자 발송은 없습니다.'
    }
  };
}

/* --- 초기화(삭제) ----------------------------------------------------------
   confirm 문구가 정확히 일치하지 않으면 아무것도 지우지 않고 중단한다. */
function resetDemo(db, options = {}) {
  if (String(options.confirm || '') !== CONFIRM_RESET) {
    throw guardedError(`확인 문구가 필요합니다. 안전을 위해 "${CONFIRM_RESET}" 를 정확히 입력해야 초기화됩니다.`, 'confirm_required', 400);
  }
  if (options.dryRun) {
    const status = demoStatus(db);
    return { ok: true, dryRun: true, wouldRemove: status.demo, preserved: status.protectedRecords };
  }
  const removed = { approvedCourses: 0, teeTimes: 0, rates: 0, commissionRates: 0, specialOffers: 0, partnerAccounts: 0, reservations: 0, bookingHolds: 0, settlements: 0, notificationLogs: 0, auditLogs: 0 };
  const filterList = (list, key) => (list || []).filter(item => {
    const drop = isStage10Record(item);
    if (drop) removed[key] += 1;
    return !drop;
  });
  db.approvedCourses = filterList(db.approvedCourses, 'approvedCourses');
  db.teeTimes = filterList(db.teeTimes, 'teeTimes');
  db.specialOffers = filterList(db.specialOffers, 'specialOffers');
  db.partnerAccounts = filterList(db.partnerAccounts, 'partnerAccounts');
  db.reservations = filterList(db.reservations, 'reservations');
  db.bookingHolds = filterList(db.bookingHolds, 'bookingHolds');
  db.settlements = filterList(db.settlements, 'settlements');
  db.notificationLogs = filterList(db.notificationLogs, 'notificationLogs');
  db.auditLogs = filterList(db.auditLogs, 'auditLogs');
  const rates = db.rates && typeof db.rates === 'object' ? db.rates : {};
  Object.keys(rates).forEach(courseId => {
    if (isStage10Record(rates[courseId])) {
      delete rates[courseId];
      removed.rates += 1;
    }
  });
  const commissions = db.commissionRates && typeof db.commissionRates === 'object' ? db.commissionRates : {};
  Object.keys(commissions).forEach(courseId => {
    if (isStage10Record(commissions[courseId])) {
      delete commissions[courseId];
      removed.commissionRates += 1;
    }
  });
  /* 매니페스트는 남은 태그 기준으로 다시 계산해, 태그 유실이 있어도 다음 초기화가 이어지게 한다. */
  db.meta.demoStage10 = { batch: null, stagedAt: null, stagedBy: null, courses: [], resetAt: new Date().toISOString(), resetBy: options.actor || null };
  return {
    ok: true,
    stage: 10,
    removed,
    removedTotal: Object.values(removed).reduce((total, value) => total + value, 0),
    preserved: demoStatus(db).protectedRecords,
    resetAt: db.meta.demoStage10.resetAt
  };
}

/* --- 준비(시딩) -----------------------------------------------------------
   기존 stage10 배치를 먼저 지우고(태그 기준) 새로 만든다. 일반 데이터는 건드리지 않는다. */
function stageDemo(db, options = {}) {
  if (String(options.confirm || '') !== CONFIRM_STAGE) {
    throw guardedError(`확인 문구가 필요합니다. 안전을 위해 "${CONFIRM_STAGE}" 를 정확히 입력해야 시연 데이터를 준비합니다.`, 'confirm_required', 400);
  }
  const catalog = options.catalog;
  if (!catalog || !catalog.byId) throw guardedError('골프장 카탈로그를 읽을 수 없습니다.', 'catalog_missing', 500);
  const now = options.now ? new Date(options.now) : new Date();
  const stamp = now.getTime();
  const batch = `s10-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  const actor = options.actor || { type: 'system', email: 'system@allgolf.demo' };

  /* 이전 배치 정리: 확인 문구 없이 내부에서 태그 기준으로만 지운다. */
  const previous = (db.approvedCourses || []).concat(db.teeTimes || [], db.reservations || [], db.settlements || []).filter(isStage10Record).length;
  if (previous) resetDemo(db, { confirm: CONFIRM_RESET, actor: { type: 'system', email: 'system@allgolf.demo', note: 'stage10 재준비' } });

  const tag = { demoStage: DEMO_STAGE, demoBatch: batch, dataMode: 'demo', simulated: true };
  const manifest = { batch, stagedAt: now.toISOString(), stagedBy: actor, courses: DEMO_COURSE_IDS.slice(), resetAt: null, resetBy: null };
  const created = { approvedCourses: [], teeTimes: [], rates: [], partnerAccounts: [], reservations: [], settlements: [], notifications: [], audits: [] };
  const today = operations.todayKst(now);

  /* 1) 제휴 승인 골프장 3곳 (전국 마스터에서 가져온다 — 새 골프장을 만들지 않는다)
        이미 승인된 골프장은 그 레코드를 건드리지 않고, 티타임·계정만 시연용으로 덧붙인다. */
  const demoCourses = DEMO_COURSE_IDS.filter(courseId => Boolean(catalogCourse(catalog, courseId)));
  demoCourses.forEach(courseId => {
    if ((db.approvedCourses || []).some(item => String(item.id) === String(courseId))) return;
    const course = catalogCourse(catalog, courseId);
    const record = { ...courseRecord(course, courseId, demoGreenFee(catalog, courseId)), ...tag };
    db.approvedCourses.push(record);
    created.approvedCourses.push(record.id);
  });

  /* 2) 요금 기본값(골프장이 저장한 값이 없을 때만) */
  db.rates = db.rates && typeof db.rates === 'object' ? db.rates : {};
  demoCourses.forEach(courseId => {
    if (db.rates[courseId]) return;
    const rates = operations.defaultRates(catalogCourse(catalog, courseId), courseId);
    db.rates[courseId] = { ...rates, ...tag };
    created.rates.push(courseId);
  });

  /* 3) 담당자 계정(골프장별 1개, 이미 계정이 있으면 만들지 않는다) */
  demoCourses.forEach(courseId => {
    if ((db.partnerAccounts || []).some(item => String(item.courseId) === String(courseId))) return;
    const course = catalogCourse(catalog, courseId);
    const account = accounts.buildAccount(db, {
      courseId: String(courseId),
      email: `partner.${String(courseId).replace(/[^a-z0-9]/gi, '').toLowerCase()}@allgolf.demo`,
      name: `${(course && course.name ? String(course.name) : '골프장').slice(0, 12)} 담당자`,
      role: 'manager',
      password: DEMO_PARTNER_PASSWORD
    }, { createdBy: actor });
    account.courseName = course && course.name ? course.name : null;
    db.partnerAccounts.push({ ...account, ...tag });
    created.partnerAccounts.push(account.email);
  });

  /* 4) 티타임: 오늘부터 7일 × 4개 시간. 같은 날짜·시간·코스가 이미 있으면 건너뛴다. */
  demoCourses.forEach(courseId => {
    const greenFee = demoGreenFee(catalog, courseId);
    for (let day = 0; day < TEE_DAYS; day += 1) {
      const date = operations.addDaysIso(today, day);
      TEE_TIMES.forEach(time => {
        const duplicate = (db.teeTimes || []).some(item => String(item.courseId) === String(courseId) && item.date === date && item.time === time && domain.text(item.course) === '전체');
        if (duplicate) return;
        const at = now.toISOString();
        const tee = {
          id: nextId('tt', stamp + day),
          courseId: String(courseId),
          courseName: (catalogCourse(catalog, courseId) || {}).name || courseId,
          course: '전체',
          date,
          time,
          session: operations.sessionForTime(time),
          capacityTeams: TEAMS_PER_TEE,
          maxPlayers: MAX_PLAYERS,
          greenFee,
          status: 'open',
          note: '10단계 시연용 티타임',
          bookedTeams: 0,
          heldTeams: 0,
          version: 1,
          createdAt: at,
          updatedAt: at,
          createdBy: actor,
          updatedBy: actor,
          ...tag
        };
        db.teeTimes.push(tee);
        created.teeTimes.push(tee.id);
      });
    }
  });

  /* 5) 수수료율(골프장별로 다르게: 8% / 9% / 8%) — 실제 계약값이 아님을 화면에서 안내한다. */
  db.commissionRates = db.commissionRates && typeof db.commissionRates === 'object' ? db.commissionRates : {};
  demoCourses.forEach((courseId, index) => {
    if (db.commissionRates[courseId]) return;
    db.commissionRates[courseId] = {
      courseId: String(courseId),
      ratePercent: index === 1 ? 9 : 8,
      updatedAt: now.toISOString(),
      updatedBy: actor,
      version: 1,
      ...tag
    };
  });

  /* 6) 예약: 라운드일은 오늘~+6일, 접수일(createdAt)은 최근 20일 안으로 흩어 통계가 채워지게 한다.
        팀 수는 티타임 정원(3팀)을 넘지 않게 배치한다. */
  const bookers = [
    { name: '김시연', phone: '010-1111-2222' },
    { name: '이투자', phone: '010-2222-3333' },
    { name: '박라운드', phone: '010-3333-4444' },
    { name: '정파트너', phone: '010-4444-5555' },
    { name: '최골퍼', phone: '010-5555-6666' },
    { name: '한티오프', phone: '010-6666-7777' }
  ];
  const stagedTees = (db.teeTimes || []).filter(item => item.demoBatch === batch);
  let bookerIndex = 0;
  stagedTees.forEach((tee, index) => {
    /* 일부 티타임만 예약을 넣어 "잔여 팀"이 남아 있는 상태를 만든다(투자자 시연: 재고 차감). */
    if (index % 5 === 4) return;
    const booker = bookers[bookerIndex % bookers.length];
    bookerIndex += 1;
    const createdDaysAgo = index % 12;
    const createdAt = new Date(now.getTime() - createdDaysAgo * 86400000 - (index % 7) * 3600000);
    const result = reservations.createReservation(db, {
      courseId: tee.courseId,
      date: tee.date,
      teeTimeId: tee.id,
      people: 4,
      booker: booker.name,
      phone: booker.phone,
      companions: ['동반1', '동반2', '동반3'],
      request: '',
      terms: true,
      refund: true
    }, { now: createdAt.getTime(), actor: { type: 'customer', note: 'stage10-demo' } });
    if (!result.ok) return;
    Object.assign(result.reservation, tag, {
      createdBy: actor,
      request: '10단계 시연 예약',
      demoBooker: true
    });
    created.reservations.push(result.reservation.number);
    analytics.notifyReservation(db, result.reservation, 'reservation.confirmed');
  });

  /* 7) 정산서: 지난 7일~오늘 라운드 기준 3곳. 한 곳은 확정(CONFIRMED), 한 곳은 지급(PAID), 한 곳은 작성(DRAFT). */
  const from = operations.addDaysIso(today, -6);
  const to = operations.addDaysIso(today, 6);
  const targets = demoCourses.slice(0, 3);
  const statusPlan = ['DRAFT', 'CONFIRMED', 'PAID'];
  targets.forEach((courseId, index) => {
    const result = analytics.createSettlement(db, { courseId, from, to, actor, note: '10단계 시연 정산서' });
    if (!result.ok) return;
    const settlement = result.settlement;
    Object.assign(settlement, tag);
    const plan = statusPlan[index] || 'DRAFT';
    if (plan !== 'DRAFT') {
      const mid = analytics.transitionSettlement(settlement, 'PENDING', { actor, note: '시연: 확인 요청' });
      if (mid.ok && plan !== 'PENDING') {
        const confirmed = analytics.transitionSettlement(settlement, 'CONFIRMED', { actor, note: '시연: 확정' });
        if (confirmed.ok) analytics.notifySettlement(db, settlement, 'CONFIRMED');
        if (confirmed.ok && plan === 'PAID') {
          const paid = analytics.transitionSettlement(settlement, 'PAID', { actor, note: '시연: 지급 완료' });
          if (paid.ok) analytics.notifySettlement(db, settlement, 'PAID');
        }
      }
    }
    created.settlements.push(settlement.number);
  });

  /* 8) 알림 로그·감사 로그에도 같은 태그를 붙여 초기화 대상에 포함한다. */
  const numbers = new Set(created.reservations);
  const settlementNumbers = new Set(created.settlements);
  (db.notificationLogs || []).forEach(item => {
    if (item.demoStage) return;
    if (numbers.has(item.reservationNumber) || settlementNumbers.has(item.settlementNumber)) Object.assign(item, tag);
  });
  const at = now.toISOString();
  const audit = {
    id: `AL-${stamp.toString(36)}-s10`,
    at,
    action: 'demo.stage10.staged',
    actor,
    memo: `10단계 시연 데이터 준비: 골프장 ${created.approvedCourses.length}곳 · 티타임 ${created.teeTimes.length}건 · 예약 ${created.reservations.length}건 · 정산서 ${created.settlements.length}건`,
    ...tag
  };
  db.auditLogs = Array.isArray(db.auditLogs) ? db.auditLogs : [];
  db.auditLogs.push(audit);
  created.audits.push(audit.id);

  manifest.teeTimes = created.teeTimes.slice();
  manifest.reservations = created.reservations.slice();
  manifest.settlements = created.settlements.slice();
  manifest.accounts = created.partnerAccounts.slice();
  manifest.rates = created.rates.slice();
  manifest.notifications = (db.notificationLogs || []).filter(item => item.demoBatch === batch).length;
  db.meta.demoStage10 = manifest;

  return {
    ok: true,
    stage: 10,
    batch,
    created: {
      approvedCourses: created.approvedCourses.length,
      teeTimes: created.teeTimes.length,
      partnerAccounts: created.partnerAccounts.length,
      reservations: created.reservations.length,
      settlements: created.settlements.length,
      commissionRates: created.rates.length,
      notificationsTagged: manifest.notifications
    },
    courses: demoCourses.slice(),
    partnerLogin: { password: DEMO_PARTNER_PASSWORD, emails: created.partnerAccounts.slice() },
    status: demoStatus(db),
    statements: {
      isolation: '이 배치는 demoStage=stage10 태그가 붙은 레코드만 만들었습니다.',
      notReal: '시연용 예약·정산이며 실제 결제·이체·문자 발송은 없습니다.'
    }
  };
}

/* CLI/화면에서 쓰는 시연 흐름 요약(가이드 단계와 같은 순서). */
function flowGuide() {
  return {
    investor: [
      { id: 'invest-1', title: '전국 509곳 데이터 확인', where: '본사 관리자 > 전국 골프장', path: '/admin/', detail: '시연 예약 68곳과 정보 전용 441곳이 구분되어 보입니다.' },
      { id: 'invest-2', title: '제휴 골프장 티타임 확인', where: '사용자 앱 > 예약', path: '/?page=list', detail: '시연 데이터를 준비하면 3곳에 오늘부터 7일 치 티타임이 열립니다.' },
      { id: 'invest-3', title: '예약으로 재고 차감', where: '사용자 앱 > 예약 확인', path: '/?page=list', detail: '예약 1건 = 1팀. 같은 티타임 잔여 팀이 즉시 줄어듭니다.' },
      { id: 'invest-4', title: '예약 취소와 재고 복구', where: '사용자 앱 > 내 예약', path: '/?page=my', detail: '취소하면 잔여 팀이 복구되고 환불액이 계산됩니다(실제 환불 아님).' },
      { id: 'invest-5', title: '본사 운영 통계', where: '본사 관리자 > 운영 통계·제휴 성과', path: '/admin/', detail: '기간별 예약 건수·GMV·취소율·1·2·3부 분포를 확인합니다.' },
      { id: 'invest-6', title: '정산·수수료 흐름', where: '본사 관리자 > 정산·수수료 관리', path: '/admin/', detail: '정산 기준액 → 수수료 → 정산 예정액과 상태 전이를 보여 줍니다.' },
      { id: 'invest-7', title: '사업성 시뮬레이션', where: '시연 허브 > 사업성 시뮬레이터', path: '/demo/#simulator', detail: '가정을 바꿔 월·연 수수료 매출을 계산합니다(가정 기반 시연 계산치).' }
    ],
    partner: [
      { id: 'partner-1', title: '골프장 제휴 신청', where: '사용자 앱 > 혜택 > 제휴 신청', path: '/?page=benefits', detail: '골프장 정보와 담당자를 입력해 접수번호를 받습니다.' },
      { id: 'partner-2', title: '본사 승인', where: '본사 관리자 > 제휴 신청 관리', path: '/admin/', detail: '승인하면 제휴 골프장 목록과 담당자 계정 발급 대상에 들어갑니다.' },
      { id: 'partner-3', title: '담당자 로그인', where: '골프장 관리자', path: '/partner/', detail: '본사에서 발급한 계정으로 로그인합니다(시연 계정은 시연 데이터 준비 시 자동 생성).' },
      { id: 'partner-4', title: '티타임·특가 등록', where: '골프장 관리자 > 티타임 관리', path: '/partner/', detail: '날짜·시간·정원·그린피를 서버 DB에 등록하면 고객 앱에 바로 반영됩니다.' },
      { id: 'partner-5', title: '예약·취소 처리', where: '골프장 관리자 > 예약 관리', path: '/partner/', detail: '자기 골프장 예약만 보이고, 상태 변경은 서버가 권한을 검사합니다.' },
      { id: 'partner-6', title: '정산서 확인', where: '골프장 관리자 > 정산 내역', path: '/partner/', detail: '수수료율·정산 기준액·지급 예정액을 확인합니다(실제 이체 없음).' }
    ]
  };
}

module.exports = {
  DEMO_STAGE,
  CONFIRM_STAGE,
  CONFIRM_RESET,
  DEMO_PARTNER_PASSWORD,
  DEMO_COURSE_IDS,
  demoStatus,
  resetDemo,
  stageDemo,
  flowGuide,
  manifestOf
};
