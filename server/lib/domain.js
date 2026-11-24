'use strict';
/* ALL:GOLF 6단계 도메인 규칙
   - 제휴 신청 검증·공개 응답 변환·접수번호·조회 코드·시연 티타임 생성
   - 프론트엔드 partner-application.js 의 규칙과 같은 값을 쓰도록 맞춘다. */

const crypto = require('crypto');

const STATUS_LABELS = { pending: '검토 대기', approved: '승인 완료', rejected: '반려' };
const MODE_LABELS = { existing: '기존 골프장', new: '신규 골프장' };
const MAX_MEMO = 500;
const SLOT_TIMES = ['06:52', '07:38', '08:24', '12:41', '13:27'];
const OPERATION_TYPES = ['public', 'membership', 'mixed'];

const text = value => String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
const digits = value => String(value == null ? '' : value).replace(/\D/g, '');
const isPhone = value => /^01[016789]\d{7,8}$/.test(digits(value));
const isEmail = value => /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(text(value));
const moneyValue = value => {
  if (value === '' || value == null) return null;
  const number = Number(String(value).replace(/[,\s원]/g, ''));
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : NaN;
};
const normalizeName = value => String(value == null ? '' : value)
  .toLocaleLowerCase('ko')
  .replace(/(컨트리클럽|골프클럽|골프앤리조트|골프&리조트|리조트|cc|gc|club|플라자)/gi, '')
  .replace(/[^0-9a-z가-힣]/g, '');

const pad2 = value => String(value).padStart(2, '0');

/* 접수번호 PA-YYMMDD-NNNN 의 날짜는 한국 시간 기준 */
function kstStamp(date = new Date()) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return {
    yymmdd: `${String(shifted.getUTCFullYear()).slice(2)}${pad2(shifted.getUTCMonth() + 1)}${pad2(shifted.getUTCDate())}`,
    date: `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`
  };
}

function nextApplicationId(db, now = new Date()) {
  const { yymmdd } = kstStamp(now);
  const sequences = (db.meta && db.meta.sequences) || {};
  const used = new Set((db.applications || []).map(item => String(item.id)));
  let sequence = Number(sequences[yymmdd] || 0);
  let id = '';
  do {
    sequence += 1;
    id = `PA-${yymmdd}-${String(sequence).padStart(4, '0')}`;
  } while (used.has(id));
  if (!db.meta) db.meta = {};
  if (!db.meta.sequences) db.meta.sequences = {};
  db.meta.sequences[yymmdd] = sequence;
  return id;
}

function newCourseId(db) {
  const used = new Set((db.applications || []).map(item => String(item.newCourseId || '')).filter(Boolean));
  let candidate = '';
  do {
    candidate = `ap-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  } while (used.has(candidate));
  return candidate;
}

function createLookupCode() {
  return String(crypto.randomInt(100000, 1000000));
}
function hashLookupCode(code, applicationId) {
  return crypto.createHash('sha256').update(`${digits(code)}|${applicationId}`).digest('hex');
}
function verifyLookupCode(code, application) {
  if (!application || !application.lookupCodeHash) return false;
  const given = Buffer.from(hashLookupCode(code, application.id), 'hex');
  const stored = Buffer.from(String(application.lookupCodeHash), 'hex');
  if (given.length !== stored.length) return false;
  return crypto.timingSafeEqual(given, stored);
}

/* 신청 검증 ------------------------------------------------------------------ */
function validateApplication(input, context) {
  const { masterCourseIds = new Set(), regionCodes = new Set(), isPartner = () => false, applications = [] } = context || {};
  const source = input && typeof input === 'object' ? input : {};
  const errors = {};
  const mode = source.courseMode === 'new' ? 'new' : 'existing';
  let courseId = '';
  let course = { name: '', region: '', city: '', address: '', phone: '', website: '', holes: '', operationType: 'public' };

  if (mode === 'existing') {
    const selectedId = text(source.courseId);
    if (!masterCourseIds.has(selectedId)) errors.courseId = '제휴를 신청할 골프장을 선택해주세요.';
    else {
      courseId = selectedId;
      const found = context.masterById && context.masterById.get(selectedId);
      course = {
        name: text(found && found.name),
        region: text(found && found.region),
        city: text(found && found.city),
        address: text(found && found.address),
        phone: text(found && found.phone),
        website: text(found && (found.officialWebsite || found.website)),
        holes: found && found.holes ? String(found.holes) : '',
        operationType: OPERATION_TYPES.includes(found && found.operationType) ? found.operationType : 'public'
      };
      if (isPartner(selectedId)) errors.courseId = '이미 ALL:GOLF 제휴 중인 골프장입니다.';
      const pending = applications.find(item => item.status === 'pending' && item.courseMode === 'existing' && item.courseId === selectedId);
      if (pending && !errors.courseId) errors.courseId = `이미 검토 중인 신청이 있습니다. (접수번호 ${pending.id})`;
    }
  } else {
    course.name = text(source.courseName);
    course.region = text(source.region);
    course.city = text(source.city);
    course.address = text(source.address);
    course.phone = text(source.coursePhone);
    course.website = text(source.website);
    course.holes = text(source.holes);
    course.operationType = OPERATION_TYPES.includes(source.operationType) ? source.operationType : 'public';
    if (course.name.length < 2 || course.name.length > 40) errors.courseName = '골프장명을 2~40자로 입력해주세요.';
    if (!regionCodes.has(course.region)) errors.region = '지역을 선택해주세요.';
    if (!course.city || course.city.length > 20) errors.city = '시·군을 20자 이하로 입력해주세요.';
    if (course.holes && (!Number.isInteger(Number(course.holes)) || Number(course.holes) < 9 || Number(course.holes) > 72)) errors.holes = '홀 수는 9~72 사이 숫자로 입력해주세요.';
    const sameName = applications.find(item => normalizeName(item.course && item.course.name) === normalizeName(course.name) && normalizeName(course.name).length > 1 && item.status !== 'rejected');
    if (sameName && !errors.courseName) {
      errors.courseName = sameName.status === 'approved'
        ? '이미 승인된 골프장입니다.'
        : `이미 검토 중인 신청이 있습니다. (접수번호 ${sameName.id})`;
    }
  }

  const managerName = text(source.managerName);
  const managerPhone = text(source.managerPhone);
  const managerEmail = text(source.managerEmail);
  const managerRole = text(source.managerRole);
  if (managerName.length < 2 || managerName.length > 20) errors.managerName = '담당자명을 2~20자로 입력해주세요.';
  if (!isPhone(managerPhone)) errors.managerPhone = '휴대전화번호 형식이 올바르지 않습니다. 예: 010-1234-5678';
  if (!isEmail(managerEmail)) errors.managerEmail = '이메일 형식이 올바르지 않습니다.';
  if (managerRole.length > 20) errors.managerRole = '직책은 20자 이하로 입력해주세요.';

  const conditions = {
    weekdayGreenFee: moneyValue(source.weekdayGreenFee),
    weekendGreenFee: moneyValue(source.weekendGreenFee),
    cartFee: moneyValue(source.cartFee),
    caddieFee: moneyValue(source.caddieFee),
    teeInterval: moneyValue(source.teeInterval),
    memo: text(source.memo)
  };
  ['weekdayGreenFee', 'weekendGreenFee', 'cartFee', 'caddieFee'].forEach(field => {
    if (Number.isNaN(conditions[field])) errors[field] = '금액은 0원 이상 숫자로 입력해주세요.';
  });
  if (Number.isNaN(conditions.teeInterval) || (conditions.teeInterval != null && (conditions.teeInterval < 5 || conditions.teeInterval > 30))) {
    errors.teeInterval = '티오프 간격은 5~30분으로 입력해주세요.';
  }
  if (conditions.memo.length > MAX_MEMO) errors.memo = `운영 조건 메모는 ${MAX_MEMO}자 이하로 입력해주세요.`;
  if (source.agree !== true) errors.agree = '제휴 조건 확인 및 시연용 안내에 동의해주세요.';

  const keys = Object.keys(errors);
  return {
    ok: keys.length === 0,
    errors,
    message: keys.length ? errors[keys[0]] : '',
    value: {
      courseMode: mode,
      courseId,
      course,
      manager: { name: managerName, role: managerRole, phone: managerPhone, email: managerEmail },
      conditions
    }
  };
}

const statusLabel = status => STATUS_LABELS[status] || status;
const modeLabel = mode => MODE_LABELS[mode] || mode;

/* 본인 조회 응답: 신청자 본인의 정보만 그대로 돌려준다. */
function publicApplication(app) {
  if (!app) return null;
  return {
    id: app.id,
    status: app.status,
    statusLabel: statusLabel(app.status),
    courseMode: app.courseMode,
    modeLabel: modeLabel(app.courseMode),
    courseId: app.courseId || null,
    newCourseId: app.newCourseId || null,
    course: { ...(app.course || {}) },
    manager: { ...(app.manager || {}) },
    conditions: { ...(app.conditions || {}) },
    decision: app.decision ? { ...app.decision } : null,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    dataMode: 'demo'
  };
}

/* 본사 관리자 응답: 담당자 연락처까지 포함한다. 조회 코드 해시는 절대 내보내지 않는다. */
function adminApplication(app) {
  if (!app) return null;
  const { lookupCodeHash, ...rest } = app;
  return { ...rest, statusLabel: statusLabel(app.status), modeLabel: modeLabel(app.courseMode) };
}

/* 공개 응답: 담당자 이름·전화·이메일과 자유 입력 메모를 제외한다. */
function publicCourse(record) {
  if (!record) return null;
  return {
    id: record.id,
    name: record.name,
    region: record.region,
    city: record.city,
    address: record.address || null,
    operationType: record.operationType || 'public',
    holes: record.holes || null,
    phone: record.phone || null,
    website: record.website || null,
    source: record.source || null,
    partnerApplicationId: record.applicationId || null,
    approvedAt: record.approvedAt || null,
    greenFee: {
      weekday: record.greenFee && record.greenFee.weekday != null ? Number(record.greenFee.weekday) : null,
      weekend: record.greenFee && record.greenFee.weekend != null ? Number(record.greenFee.weekend) : null,
      cart: record.greenFee && record.greenFee.cart != null ? Number(record.greenFee.cart) : null,
      caddie: record.greenFee && record.greenFee.caddie != null ? Number(record.greenFee.caddie) : null,
      teeInterval: record.greenFee && record.greenFee.teeInterval != null ? Number(record.greenFee.teeInterval) : null
    },
    dataMode: 'demo'
  };
}

const demoBaseFee = record => {
  const configured = Number(record && record.greenFee && record.greenFee.weekday);
  return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 150000;
};

/* 시연 티타임: 골프장 ID와 날짜로 항상 같은 값이 나오게 만든다(프론트와 동일 규칙). */
function teeTimesFor(record, date) {
  const baseFee = demoBaseFee(record);
  const weekend = [0, 6].includes(new Date(`${date}T00:00:00`).getDay());
  const seed = [...String(record.id)].reduce((sum, char) => sum + char.charCodeAt(0), 0)
    + [...String(date)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const base = baseFee + (weekend ? 20000 : 0);
  return SLOT_TIMES.map((time, index) => ({
    id: `${record.id}::${date}::${time}`,
    courseId: record.id,
    date,
    time,
    session: +time.slice(0, 2) < 10 ? '1부' : +time.slice(0, 2) < 14 ? '2부' : '3부',
    price: base + (index === 2 ? 10000 : index === 4 ? -5000 : 0),
    regular: base + (index === 2 ? 10000 : index === 4 ? -5000 : 0),
    maxPlayers: 4,
    remaining: 1 + ((seed + index) % 3),
    special: false,
    closed: false,
    instant: true,
    dataMode: 'demo',
    notice: '시연용 티타임이며 실제 판매 재고가 아닙니다.'
  }));
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

module.exports = {
  STATUS_LABELS,
  MODE_LABELS,
  MAX_MEMO,
  SLOT_TIMES,
  OPERATION_TYPES,
  text,
  digits,
  isPhone,
  isEmail,
  moneyValue,
  normalizeName,
  kstStamp,
  nextApplicationId,
  newCourseId,
  createLookupCode,
  hashLookupCode,
  verifyLookupCode,
  validateApplication,
  publicApplication,
  adminApplication,
  publicCourse,
  teeTimesFor,
  demoBaseFee,
  isValidDate,
  statusLabel,
  modeLabel
};
