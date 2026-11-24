'use strict';
/* ALL:GOLF 7단계 골프장별 담당자 계정
   - 비밀번호는 Node 내장 crypto.scryptSync + 계정별 salt 로 해시해 저장한다(평문 저장 금지).
   - 계정은 반드시 제휴 승인된 골프장(courseId)에 연결된다.
   - 상태·권한·소속 골프장이 바뀌면 sessionEpoch 를 올려 기존 세션을 즉시 무효화한다.
   - 응답으로 내보내는 계정 정보에는 해시·salt·epoch 를 절대 포함하지 않는다. */

const crypto = require('crypto');
const domain = require('./domain');

const ROLES = ['owner', 'manager', 'viewer'];
const ROLE_LABELS = { owner: '대표 관리자', manager: '운영 담당', viewer: '조회 전용' };
const STATUSES = ['active', 'disabled'];
const STATUS_LABELS = { active: '사용 중', disabled: '사용 중지' };
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72;

const roleLabel = role => ROLE_LABELS[role] || role;
const statusLabel = status => STATUS_LABELS[status] || status;

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(String(saltHex), 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem
  });
  return {
    passwordSalt: salt.toString('hex'),
    passwordHash: hash.toString('hex'),
    passwordAlgo: 'scrypt',
    passwordParams: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen }
  };
}

function verifyPassword(password, account) {
  if (!account || !account.passwordHash || !account.passwordSalt) return false;
  const stored = Buffer.from(String(account.passwordHash), 'hex');
  let given;
  try {
    given = crypto.scryptSync(String(password), Buffer.from(String(account.passwordSalt), 'hex'), stored.length, {
      N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem
    });
  } catch {
    return false;
  }
  if (given.length !== stored.length) return false;
  return crypto.timingSafeEqual(given, stored);
}

function normalizeEmail(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(normalizeEmail(value));
}

/* 비밀번호 정책: 8~72자, 영문과 숫자를 각각 하나 이상 포함 */
function passwordProblem(password) {
  const value = String(password == null ? '' : password);
  if (value.length < MIN_PASSWORD) return `비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다.`;
  if (value.length > MAX_PASSWORD) return `비밀번호는 ${MAX_PASSWORD}자 이하여야 합니다.`;
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return '비밀번호에는 영문과 숫자를 각각 하나 이상 포함해야 합니다.';
  return '';
}

/* 시연 안내용으로만 쓰는 자동 생성 비밀번호(응답에서 한 번만 보여 준다). */
function randomPassword(length = 12) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let value = '';
  for (let index = 0; index < length; index += 1) value += alphabet[crypto.randomInt(0, alphabet.length)];
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return randomPassword(length);
  return value;
}

function nextAccountId(db) {
  const { yymmdd } = domain.kstStamp();
  const key = `PN${yymmdd}`;
  if (!db.meta) db.meta = {};
  if (!db.meta.sequences) db.meta.sequences = {};
  const used = new Set((db.partnerAccounts || []).map(item => String(item.id)));
  let sequence = Number(db.meta.sequences[key] || 0);
  let id = '';
  do {
    sequence += 1;
    id = `PN-${yymmdd}-${String(sequence).padStart(4, '0')}`;
  } while (used.has(id));
  db.meta.sequences[key] = sequence;
  return id;
}

function validateAccountInput(input, context = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const { requirePassword = true, courseIds = null, accounts = [], ignoreId = null } = context;
  const errors = {};
  const email = normalizeEmail(source.email);
  const name = domain.text(source.name);
  const role = ROLES.includes(source.role) ? source.role : 'manager';
  const courseId = domain.text(source.courseId || source.partnerCourseId);
  const password = String(source.password == null ? '' : source.password);

  if (!isEmail(email)) errors.email = '이메일 형식이 올바르지 않습니다.';
  else if (accounts.some(item => String(item.id) !== String(ignoreId) && normalizeEmail(item.email) === email)) {
    errors.email = '이미 사용 중인 이메일입니다.';
  }
  if (name.length < 2 || name.length > 20) errors.name = '담당자명을 2~20자로 입력해주세요.';
  if (!ROLES.includes(source.role) && source.role != null && source.role !== '') errors.role = '권한은 대표 관리자·운영 담당·조회 전용 중 하나여야 합니다.';
  if (!courseId) errors.courseId = '담당할 제휴 골프장을 선택해주세요.';
  else if (courseIds && !courseIds.has(courseId)) errors.courseId = '제휴 승인된 골프장에만 계정을 만들 수 있습니다.';
  if (requirePassword) {
    const problem = passwordProblem(password);
    if (problem) errors.password = problem;
  }

  const keys = Object.keys(errors);
  return {
    ok: keys.length === 0,
    errors,
    message: keys.length ? errors[keys[0]] : '',
    value: { email, name, role, courseId, password }
  };
}

function buildAccount(db, value, meta = {}) {
  const now = new Date().toISOString();
  const secrets = hashPassword(value.password);
  return {
    id: nextAccountId(db),
    courseId: value.courseId,
    email: value.email,
    name: value.name,
    role: value.role,
    status: 'active',
    ...secrets,
    sessionEpoch: 1,
    version: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: meta.createdBy || null,
    lastLoginAt: null,
    passwordUpdatedAt: now
  };
}

/* 화면·API 응답용: 비밀 해시, salt, epoch, 내부 파라미터를 제거한다. */
function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    courseId: account.courseId,
    courseName: account.courseName || null,
    email: account.email,
    name: account.name,
    role: account.role,
    roleLabel: roleLabel(account.role),
    status: account.status,
    statusLabel: statusLabel(account.status),
    version: account.version,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastLoginAt: account.lastLoginAt || null,
    passwordUpdatedAt: account.passwordUpdatedAt || null
  };
}

/* 시연용 계정 시드: 제휴 승인된 골프장마다 아직 계정이 없으면 하나 만든다.
   비밀번호는 호출자가 넘긴 값(기본: 시연용)을 쓰고, 반환값은 한 번만 화면/로그에 보여 준다. */
function seedDemoAccounts(db, options = {}) {
  const password = String(options.password || 'allgolf-partner-2026');
  const made = [];
  const courses = Array.isArray(db.approvedCourses) ? db.approvedCourses : [];
  courses.forEach(course => {
    if (!course || !course.id) return;
    if ((db.partnerAccounts || []).some(item => String(item.courseId) === String(course.id))) return;
    let email = `partner.${String(course.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 18).toLowerCase() || 'course'}@allgolf.demo`;
    let attempt = 1;
    while ((db.partnerAccounts || []).some(item => normalizeEmail(item.email) === email)) {
      attempt += 1;
      email = email.replace(/@/, `${attempt}@`);
    }
    const account = buildAccount(db, {
      courseId: String(course.id),
      email,
      name: `${domain.text(course.name).slice(0, 12) || '골프장'} 담당자`,
      role: 'manager',
      password
    }, { createdBy: { type: 'system', email: 'system@allgolf.demo' } });
    account.courseName = course.name;
    db.partnerAccounts.push(account);
    made.push({ account, password });
  });
  return made;
}

module.exports = {
  ROLES,
  ROLE_LABELS,
  STATUSES,
  STATUS_LABELS,
  MIN_PASSWORD,
  MAX_PASSWORD,
  roleLabel,
  statusLabel,
  hashPassword,
  verifyPassword,
  normalizeEmail,
  isEmail,
  passwordProblem,
  randomPassword,
  nextAccountId,
  validateAccountInput,
  buildAccount,
  publicAccount,
  seedDemoAccounts
};
