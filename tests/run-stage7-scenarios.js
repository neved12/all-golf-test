#!/usr/bin/env node
/* ALL:GOLF 7단계 서버·권한 시나리오 테스트
   사용법: node tests/run-stage7-scenarios.js   (= npm run test:stage7)
   - 실제 server/index.js 를 임시 DB 로 띄워 골프장 담당자 계정·권한·티타임·요금·특가 API 를 검사한다.
   - 골프장 A/B 데이터 격리(403), 세션 무효화, 버전 충돌(409), 재시작 후 데이터 유지,
     공개 카탈로그와 정적 모드 폴백을 확인한다.
   - 브라우저 없이 고객 앱 코드(dom-shim)와 서버 카탈로그 모듈을 실행해 화면 계산도 검증한다. */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const rootDir = path.resolve(__dirname, '..');
const results = [];
const section = name => results.push({ heading: true, name });
const ok = (name, pass, detail) => results.push({ name, ok: Boolean(pass), detail: pass ? undefined : String(detail == null ? '' : detail) });
const eq = (name, actual, expected) => ok(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), `기대=${JSON.stringify(expected)} 실제=${JSON.stringify(actual)}`);

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: rootDir,
      env: { ...process.env, HOST: '127.0.0.1', ALLGOLF_BACKUP: 'off', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('exit', code => { if (code !== 0) reject(new Error(`서버가 종료되었습니다(code=${code})\n${output}`)); });
    resolve({ child, getOutput: () => output });
  });
}

async function waitForHealth(base, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return await response.json();
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`서버가 응답하지 않습니다: ${lastError && lastError.message}`);
}

function stopServer(handle) {
  if (!handle || !handle.child || handle.child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => { try { handle.child.kill('SIGKILL'); } catch { /* noop */ } resolve(); }, 8000);
    handle.child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { handle.child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
  });
}

function kstDate(offsetDays = 0) {
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetDays * 86400000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
const tomorrow = kstDate(1);
const dayAfter = kstDate(2);
const today = kstDate(0);

const newApplication = (name, overrides = {}) => ({
  courseMode: 'new', courseName: name, region: '경기', city: '이천',
  holes: '18', operationType: 'public', coursePhone: '031-555-0000', address: '경기 이천시 스테이지7로 7',
  website: 'https://stage7.example.com',
  managerName: '박담당', managerRole: '예약 담당', managerPhone: '010-5555-6666', managerEmail: `stage7-${name.replace(/\s/g, '')}@example.com`,
  weekdayGreenFee: '160000', weekendGreenFee: '190000', cartFee: '110000', caddieFee: '150000', teeInterval: '8',
  memo: '', agree: true, ...overrides
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allgolf-stage7-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const password = `stage7-${Math.random().toString(36).slice(2, 10)}`;
  const env = { PORT: String(port), ALLGOLF_DB_PATH: dbPath, ADMIN_PASSWORD: password, SESSION_SECRET: 'stage7-test-secret-0123456789abcdef' };
  let server = null;

  async function call(method, pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: response.status, data, headers: response.headers, text };
  }

  let adminToken = '';
  let courseA = '', courseB = '';
  let accountA = null, accountB = null, viewerAccount = null;
  let passwordA = 'Stage7Pass1';
  let passwordB = '';
  let passwordViewer = 'Viewer7Pass1';
  let tokenA = '', tokenB = '', tokenViewer = '';
  let teeA = null, teeB = null;

  try {
    /* 1. 서버 기동 ---------------------------------------------------------- */
    section('7단계 · 서버 기동과 상태');
    server = await startServer(env);
    const health = await waitForHealth(base);
    ok('서버 기동 · /api/health 200', health && health.ok === true);
    /* 8단계에서 health.stage 가 8 로 올라가도 7단계 기능이 그대로 있음을 확인한다. */
    ok('7단계 서버 표시(8단계 이상)', Number(health.stage) >= 7, health.stage);
    ok('골프장 계정 기능 표시', health.features && health.features.partnerAccounts === true);
    ok('공개 카탈로그 기능 표시', health.features && health.features.publicCatalog === true);
    ok('DB 7단계 컬렉션 초기값', health.db && health.db.teeTimes === 0 && health.db.partnerAccounts === 0);

    const staticPage = await call('GET', '/');
    ok('서버 카탈로그 스크립트가 정적 앱에 포함', staticPage.text.includes('data/server-catalog.js'));

    /* 2. 제휴 승인 두 곳 ---------------------------------------------------- */
    section('7단계 · 준비: 제휴 골프장 A/B 승인');
    const login = await call('POST', '/api/admin/login', { body: { password } });
    adminToken = login.data && login.data.token;
    ok('본사 관리자 로그인', login.status === 200 && Boolean(adminToken));

    const appA = await call('POST', '/api/partner-applications', { body: newApplication('스테이지7 알파 CC') });
    const appB = await call('POST', '/api/partner-applications', { body: newApplication('스테이지7 베타 CC') });
    eq('A 제휴 신청 접수', appA.status, 201);
    eq('B 제휴 신청 접수', appB.status, 201);
    const approveA = await call('POST', `/api/admin/partner-applications/${appA.data.application.id}/approve`, { token: adminToken, body: {} });
    const approveB = await call('POST', `/api/admin/partner-applications/${appB.data.application.id}/approve`, { token: adminToken, body: {} });
    eq('A 승인', approveA.status, 200);
    eq('B 승인', approveB.status, 200);
    courseA = approveA.data.application.newCourseId;
    courseB = approveB.data.application.newCourseId;

    /* 3. 담당자 계정 -------------------------------------------------------- */
    section('7단계 · 골프장 담당자 계정 발급');
    const noAuth = await call('GET', '/api/admin/partner-accounts');
    eq('인증 없는 계정 목록 401', noAuth.status, 401);
    const created = await call('POST', '/api/admin/partner-accounts', {
      token: adminToken,
      body: { courseId: courseA, email: 'alpha@stage7.example.com', name: '알파 담당', role: 'manager', password: passwordA }
    });
    eq('A 계정 생성 201', created.status, 201);
    accountA = created.data && created.data.account;
    ok('계정 응답에 초기 비밀번호 1회 제공', Boolean(created.data && created.data.initialPassword));
    ok('계정 응답에 비밀번호 해시 없음', !created.text.includes('passwordHash') && !created.text.includes('passwordSalt'));
    eq('계정 권한', accountA && accountA.role, 'manager');
    eq('계정 초기 상태', accountA && accountA.status, 'active');
    eq('계정이 A 골프장에 연결', accountA && accountA.courseId, courseA);

    const duplicateEmail = await call('POST', '/api/admin/partner-accounts', {
      token: adminToken, body: { courseId: courseB, email: 'alpha@stage7.example.com', name: '중복', role: 'manager', password: 'Another7Pass' }
    });
    eq('중복 이메일 400', duplicateEmail.status, 400);
    ok('중복 이메일 필드 오류', duplicateEmail.data && duplicateEmail.data.error.details.errors.email === '이미 사용 중인 이메일입니다.');
    const badCourse = await call('POST', '/api/admin/partner-accounts', {
      token: adminToken, body: { courseId: 'no-such-course', email: 'x@stage7.example.com', name: '없는곳', role: 'manager', password: 'Another7Pass' }
    });
    eq('제휴 승인 안 된 골프장 400', badCourse.status, 400);
    const weakPassword = await call('POST', '/api/admin/partner-accounts', {
      token: adminToken, body: { courseId: courseA, email: 'weak@stage7.example.com', name: '약한비번', role: 'manager', password: 'short' }
    });
    eq('약한 비밀번호 400', weakPassword.status, 400);

    const createdB = await call('POST', '/api/admin/partner-accounts', {
      token: adminToken, body: { courseId: courseB, email: 'beta@stage7.example.com', name: '베타 담당', role: 'owner' }
    });
    eq('B 계정 자동 비밀번호 생성 201', createdB.status, 201);
    accountB = createdB.data.account;
    passwordB = createdB.data.initialPassword;
    ok('자동 생성 비밀번호 반환', typeof passwordB === 'string' && passwordB.length >= 8, passwordB);
    ok('자동 생성 비밀번호 정책 충족', /[A-Za-z]/.test(passwordB) && /\d/.test(passwordB));

    const createdViewer = await call('POST', '/api/admin/partner-accounts', {
      token: adminToken, body: { courseId: courseA, email: 'viewer@stage7.example.com', name: '조회 담당', role: 'viewer', password: passwordViewer }
    });
    eq('조회 전용 계정 생성', createdViewer.status, 201);
    viewerAccount = createdViewer.data.account;

    const accountList = await call('GET', '/api/admin/partner-accounts', { token: adminToken });
    eq('계정 목록 3개', accountList.data.count, 3);
    eq('사용 중 계정 3개', accountList.data.stats.active, 3);
    ok('계정 목록에 골프장명 표시', (accountList.data.accounts || []).every(item => item.courseName));
    ok('계정 목록에 비밀 해시 없음', !accountList.text.includes('passwordHash') && !accountList.text.includes('sessionEpoch'));

    /* 4. 담당자 로그인 ------------------------------------------------------ */
    section('7단계 · 골프장 담당자 로그인·세션');
    const wrongLogin = await call('POST', '/api/partner/login', { body: { email: 'alpha@stage7.example.com', password: 'wrong-pass' } });
    eq('틀린 비밀번호 401', wrongLogin.status, 401);
    const loginA = await call('POST', '/api/partner/login', { body: { email: 'alpha@stage7.example.com', password: passwordA } });
    eq('A 담당자 로그인 200', loginA.status, 200);
    tokenA = loginA.data && loginA.data.token;
    ok('담당자 토큰 형식 p1', Boolean(tokenA) && tokenA.split('.')[0] === 'p1', tokenA && tokenA.slice(0, 8));
    ok('담당자 HttpOnly 쿠키 발급', /allgolf_partner=/.test(String(loginA.headers.get('set-cookie'))) && /HttpOnly/.test(String(loginA.headers.get('set-cookie'))));
    ok('로그인 응답에 비밀 해시 없음', !loginA.text.includes('passwordHash'));
    const sessionA = await call('GET', '/api/partner/session', { token: tokenA });
    eq('세션 확인 200', sessionA.status, 200);
    eq('세션 골프장 일치', sessionA.data.course.id, courseA);
    eq('세션 계정 이메일', sessionA.data.account.email, 'alpha@stage7.example.com');
    const crossAdmin = await call('GET', '/api/admin/partner-accounts', { token: tokenA });
    eq('담당자 토큰으로 본사 API 401', crossAdmin.status, 401);
    const crossPartner = await call('GET', '/api/partner/session', { token: adminToken });
    eq('본사 토큰으로 담당자 API 401', crossPartner.status, 401);

    const loginB = await call('POST', '/api/partner/login', { body: { email: 'beta@stage7.example.com', password: passwordB } });
    eq('B 담당자 로그인 200', loginB.status, 200);
    tokenB = loginB.data.token;
    const loginViewer = await call('POST', '/api/partner/login', { body: { email: 'viewer@stage7.example.com', password: passwordViewer } });
    eq('조회 전용 로그인 200', loginViewer.status, 200);
    tokenViewer = loginViewer.data.token;

    /* 5. 티타임 CRUD -------------------------------------------------------- */
    section('7단계 · A 티타임 등록과 검증');
    const badDate = await call('POST', '/api/partner/tee-times', { token: tokenA, body: { date: '2026-13-40', time: '07:30', capacityTeams: 2, maxPlayers: 4, greenFee: 160000 } });
    eq('잘못된 날짜 400', badDate.status, 400);
    const pastDate = await call('POST', '/api/partner/tee-times', { token: tokenA, body: { date: '2020-01-01', time: '07:30', capacityTeams: 2, maxPlayers: 4, greenFee: 160000 } });
    eq('지난 날짜 400', pastDate.status, 400);
    const badTime = await call('POST', '/api/partner/tee-times', { token: tokenA, body: { date: tomorrow, time: '25:00', capacityTeams: 2, maxPlayers: 4, greenFee: 160000 } });
    eq('잘못된 시간 400', badTime.status, 400);
    const badCapacity = await call('POST', '/api/partner/tee-times', { token: tokenA, body: { date: tomorrow, time: '07:30', capacityTeams: 0, maxPlayers: 4, greenFee: 160000 } });
    eq('예약 가능 팀 0 400', badCapacity.status, 400);
    const badPeople = await call('POST', '/api/partner/tee-times', { token: tokenA, body: { date: tomorrow, time: '07:30', capacityTeams: 2, maxPlayers: 5, greenFee: 160000 } });
    eq('최대 인원 5명 400', badPeople.status, 400);
    const badSession = await call('POST', '/api/partner/tee-times', { token: tokenA, body: { date: tomorrow, time: '07:30', session: '2부', capacityTeams: 2, maxPlayers: 4, greenFee: 160000 } });
    eq('시간과 부 불일치 400', badSession.status, 400);
    const badPrice = await call('POST', '/api/partner/tee-times', { token: tokenA, body: { date: tomorrow, time: '07:30', capacityTeams: 2, maxPlayers: 4, greenFee: -100 } });
    eq('음수 그린피 400', badPrice.status, 400);

    const createTee = await call('POST', '/api/partner/tee-times', {
      token: tokenA,
      body: { date: tomorrow, time: '07:30', session: '1부', course: '전체', capacityTeams: 2, maxPlayers: 4, greenFee: 160000, status: 'open', note: '스테이지7 테스트' }
    });
    eq('A 티타임 등록 201', createTee.status, 201);
    teeA = createTee.data.teeTime;
    eq('티타임 버전 1', teeA.version, 1);
    eq('티타임 잔여 = 예약 가능 팀', teeA.remaining, 2);
    eq('티타임 상태 라벨', teeA.statusLabel, '판매 중');
    eq('티타임 골프장 연결', teeA.courseId, courseA);

    const duplicateTee = await call('POST', '/api/partner/tee-times', {
      token: tokenA, body: { date: tomorrow, time: '07:30', course: '전체', capacityTeams: 1, maxPlayers: 4, greenFee: 150000 }
    });
    eq('같은 날짜·시간·코스 중복 409', duplicateTee.status, 409);
    const viewerWrite = await call('POST', '/api/partner/tee-times', {
      token: tokenViewer, body: { date: tomorrow, time: '09:30', capacityTeams: 1, maxPlayers: 4, greenFee: 150000 }
    });
    eq('조회 전용 계정 쓰기 403', viewerWrite.status, 403);
    ok('조회 전용 안내 코드', viewerWrite.data.error.code === 'forbidden_role', JSON.stringify(viewerWrite.data));
    const viewerRead = await call('GET', '/api/partner/tee-times?date=' + tomorrow, { token: tokenViewer });
    eq('조회 전용 계정 읽기 200', viewerRead.status, 200);

    const listA = await call('GET', '/api/partner/tee-times?date=' + tomorrow, { token: tokenA });
    eq('A 티타임 목록 1건', listA.data.count, 1);

    const createTeeB = await call('POST', '/api/partner/tee-times', {
      token: tokenB, body: { date: tomorrow, time: '08:30', session: '1부', course: '전체', capacityTeams: 3, maxPlayers: 4, greenFee: 170000 }
    });
    eq('B 티타임 등록 201', createTeeB.status, 201);
    teeB = createTeeB.data.teeTime;
    eq('B 티타임 골프장 연결', teeB.courseId, courseB);

    /* 6. 데이터 격리 -------------------------------------------------------- */
    section('7단계 · 골프장별 데이터 격리(403)');
    const crossList = await call('GET', `/api/partner/tee-times?courseId=${encodeURIComponent(courseB)}`, { token: tokenA });
    eq('A가 B 골프장 ID로 조회 403', crossList.status, 403);
    const crossPatch = await call('PATCH', `/api/partner/tee-times/${encodeURIComponent(teeB.id)}`, { token: tokenA, body: { version: 1, capacityTeams: 1 } });
    eq('A가 B 티타임 수정 403', crossPatch.status, 403);
    const crossDelete = await call('DELETE', `/api/partner/tee-times/${encodeURIComponent(teeB.id)}?version=1`, { token: tokenA });
    eq('A가 B 티타임 삭제 403', crossDelete.status, 403);
    const crossCreate = await call('POST', '/api/partner/tee-times', { token: tokenA, body: { courseId: courseB, date: tomorrow, time: '11:00', capacityTeams: 1, maxPlayers: 4, greenFee: 150000 } });
    eq('A가 B 명의로 등록 403', crossCreate.status, 403);
    const crossRates = await call('PUT', '/api/partner/rates', { token: tokenB, body: { courseId: courseA, baseGreenFee: 1000, depositType: 'none', depositValue: 0 } });
    eq('B가 A 명의로 요금 수정 403', crossRates.status, 403);
    const listB = await call('GET', '/api/partner/tee-times?date=' + tomorrow, { token: tokenB });
    ok('B 목록에는 B 티타임만', listB.data.teeTimes.every(item => item.courseId === courseB), JSON.stringify(listB.data.teeTimes.map(item => item.courseId)));

    /* 7. 수정 충돌 ---------------------------------------------------------- */
    section('7단계 · 티타임 수정 충돌(409)');
    const noVersion = await call('PATCH', `/api/partner/tee-times/${encodeURIComponent(teeA.id)}`, { token: tokenA, body: { capacityTeams: 3 } });
    eq('version 없는 수정 400', noVersion.status, 400);
    const stalePatch = await call('PATCH', `/api/partner/tee-times/${encodeURIComponent(teeA.id)}`, { token: tokenA, body: { version: 2, capacityTeams: 3 } });
    eq('오래된 version 수정 409', stalePatch.status, 409);
    ok('409 응답에 최신 티타임 포함', Boolean(stalePatch.data && stalePatch.data.error.details && stalePatch.data.error.details.current));
    const patchA = await call('PATCH', `/api/partner/tee-times/${encodeURIComponent(teeA.id)}`, { token: tokenA, body: { version: 1, capacityTeams: 3 } });
    eq('올바른 version 수정 200', patchA.status, 200);
    eq('수정 후 버전 2', patchA.data.teeTime.version, 2);
    eq('수정 반영', patchA.data.teeTime.capacityTeams, 3);
    const patchAgain = await call('PATCH', `/api/partner/tee-times/${encodeURIComponent(teeA.id)}`, { token: tokenA, body: { version: 1, status: 'stopped' } });
    eq('같은 version 재사용 409', patchAgain.status, 409);

    /* 8. 요금 --------------------------------------------------------------- */
    section('7단계 · 요금 설정과 3인·4인 계산');
    const ratesA = await call('GET', '/api/partner/rates', { token: tokenA });
    eq('요금 조회 200', ratesA.status, 200);
    eq('승인 신청의 평일 그린피가 기본값', ratesA.data.rates.baseGreenFee, 160000);
    eq('요금 버전 0', ratesA.data.rates.version, 0);
    const putRates = await call('PUT', '/api/partner/rates', {
      token: tokenA,
      body: {
        baseGreenFee: 160000, threePlayerGreenFee: 180000, fourPlayerGreenFee: 150000,
        threePlayerSurcharge: 10000, twoPlayerSurcharge: 5000,
        cartFee: 110000, caddieFee: 150000, depositType: 'person', depositValue: 30000, version: 0
      }
    });
    eq('요금 저장 200', putRates.status, 200);
    eq('요금 버전 1', putRates.data.rates.version, 1);
    const negRates = await call('PUT', '/api/partner/rates', { token: tokenA, body: { baseGreenFee: -1, depositType: 'none', depositValue: 0, version: 1 } });
    eq('음수 기본 그린피 400', negRates.status, 400);
    const badPercent = await call('PUT', '/api/partner/rates', { token: tokenA, body: { baseGreenFee: 160000, depositType: 'percent', depositValue: 120, version: 1 } });
    eq('예약금 비율 120% 400', badPercent.status, 400);
    const staleRates = await call('PUT', '/api/partner/rates', { token: tokenA, body: { baseGreenFee: 155000, depositType: 'none', depositValue: 0, version: 0 } });
    eq('오래된 요금 version 409', staleRates.status, 409);

    /* 9. 특가 --------------------------------------------------------------- */
    section('7단계 · 특가 등록과 검증');
    const saleStart = new Date(Date.now() - 3600000).toISOString();
    const saleEnd = new Date(Date.now() + 2 * 86400000).toISOString();
    const offerBody = {
      teeTimeId: teeA.id, name: '스테이지7 오픈 특가', description: '테스트 특가',
      regularPrice: 160000, specialPrice: 128000, teamLimit: 2,
      saleStartAt: saleStart, saleEndAt: saleEnd, visible: true, paused: false
    };
    const createOffer = await call('POST', '/api/partner/special-offers', { token: tokenA, body: offerBody });
    eq('특가 등록 201', createOffer.status, 201);
    const offerA = createOffer.data.offer;
    eq('할인 금액 계산', offerA.discountAmount, 32000);
    eq('할인율 계산', offerA.discountRate, 20);
    eq('특가 상태 진행 중', offerA.status, 'active');
    const badOfferPrice = await call('POST', '/api/partner/special-offers', { token: tokenA, body: { ...offerBody, specialPrice: 160000 } });
    eq('특가가 정상가 이상 400', badOfferPrice.status, 400);
    const badTeamLimit = await call('POST', '/api/partner/special-offers', { token: tokenA, body: { ...offerBody, specialPrice: 100000, teamLimit: 99 } });
    eq('적용 팀 수 초과 400', badTeamLimit.status, 400);
    const overlap = await call('POST', '/api/partner/special-offers', { token: tokenA, body: { ...offerBody, name: '겹치는 특가', specialPrice: 120000 } });
    eq('판매 기간 겹침 409', overlap.status, 409);
    const crossOffer = await call('PATCH', `/api/partner/special-offers/${encodeURIComponent(offerA.id)}`, { token: tokenB, body: { version: 1, paused: true } });
    eq('B가 A 특가 수정 403', crossOffer.status, 403);

    const hideOffer = await call('PATCH', `/api/partner/special-offers/${encodeURIComponent(offerA.id)}`, { token: tokenA, body: { version: 1, visible: false } });
    eq('특가 숨김 수정 200', hideOffer.status, 200);
    eq('특가 버전 2', hideOffer.data.offer.version, 2);
    const catalogHidden = await call('GET', `/api/public/catalog?date=${tomorrow}&courseId=${encodeURIComponent(courseA)}`);
    const hiddenTee = catalogHidden.data.courses[0].teeTimes[0];
    ok('숨긴 특가는 고객 카탈로그에 미적용', hiddenTee.special === false && hiddenTee.specialOffer === null, JSON.stringify(hiddenTee.specialOffer));
    const showOffer = await call('PATCH', `/api/partner/special-offers/${encodeURIComponent(offerA.id)}`, { token: tokenA, body: { version: 2, visible: true } });
    eq('특가 다시 노출 200', showOffer.status, 200);

    /* 10. 공개 카탈로그 ----------------------------------------------------- */
    section('7단계 · 고객 앱 공개 카탈로그');
    const catalog = await call('GET', `/api/public/catalog?date=${tomorrow}&courseId=${encodeURIComponent(courseA)}`);
    eq('공개 카탈로그 200', catalog.status, 200);
    eq('카탈로그 골프장 1곳', catalog.data.courses.length, 1);
    eq('서버 티타임 1건', catalog.data.courses[0].teeTimes.length, 1);
    const publicTee = catalog.data.courses[0].teeTimes[0];
    eq('티타임 서버 관리 표시', publicTee.serverManaged, true);
    eq('정상가 160000', publicTee.regularPrice, 160000);
    eq('특가 적용가 128000', publicTee.appliedPrice, 128000);
    eq('2인 1인 그린피', publicTee.priceByPlayers['2'], 165000);
    eq('3인 1인 그린피', publicTee.priceByPlayers['3'], 180000);
    eq('4인 1인 그린피', publicTee.priceByPlayers['4'], 150000);
    /* 8단계에서 재고가 서버로 이전되어 inventoryLinked 가 true 로 바뀌었다(7단계 한계 문구 제거). */
    ok('재고 연동 상태 명시(8단계: true)', catalog.data.inventoryLinked === true && String(catalog.data.inventoryNote).includes('서버'), catalog.data.inventoryNote);
    ok('관리 골프장 목록 제공', Array.isArray(catalog.data.managedCourseIds) && catalog.data.managedCourseIds.includes(courseA));
    ok('카탈로그에 계정 이메일 없음', !catalog.text.includes('alpha@stage7.example.com'));
    ok('카탈로그에 비밀번호 해시 없음', !catalog.text.includes('passwordHash'));

    const catalogB = await call('GET', `/api/public/catalog?date=${tomorrow}`);
    ok('전체 카탈로그에 A·B 모두 포함', (catalogB.data.managedCourseIds || []).includes(courseA) && (catalogB.data.managedCourseIds || []).includes(courseB));

    const courseTeeServer = await call('GET', `/api/partner-courses/${encodeURIComponent(courseA)}/tee-times?date=${tomorrow}`);
    eq('기존 공개 티타임 API가 서버 티타임 우선', courseTeeServer.data.source, 'server');
    eq('서버 티타임 1건', courseTeeServer.data.count, 1);
    const courseTeeDemo = await call('GET', `/api/partner-courses/${encodeURIComponent(courseA)}/tee-times?date=${dayAfter}`);
    eq('서버 티타임 없는 날짜는 시연 5건', courseTeeDemo.data.count, 5);
    eq('시연 폴백 표시', courseTeeDemo.data.source, 'demo');

    /* 11. 티타임 삭제 차단 -------------------------------------------------- */
    section('7단계 · 연결된 특가가 있는 티타임 삭제 차단');
    const deleteWithOffer = await call('DELETE', `/api/partner/tee-times/${encodeURIComponent(teeA.id)}?version=2`, { token: tokenA });
    eq('특가 연결 티타임 삭제 409', deleteWithOffer.status, 409);
    ok('삭제 차단 사유 코드', deleteWithOffer.data.error.code === 'offer_linked', JSON.stringify(deleteWithOffer.data.error));

    /* 12. 본사 운영 현황 ---------------------------------------------------- */
    section('7단계 · 본사 관리자 운영 현황·감사 로그');
    const operations = await call('GET', `/api/admin/operations?date=${tomorrow}`, { token: adminToken });
    eq('운영 현황 200', operations.status, 200);
    eq('제휴 골프장 2곳', operations.data.totals.courses, 2);
    eq('등록 티타임 2건', operations.data.totals.teeTimes, 2);
    eq('선택일 티타임 2건', operations.data.totals.teeTimesOnDate, 2);
    eq('담당자 계정 3개', operations.data.totals.accounts, 3);
    const opsA = operations.data.courses.find(item => item.courseId === courseA);
    ok('A 운영 현황에 티타임·특가·계정', opsA && opsA.teeTimes.total === 1 && opsA.offers.total === 1 && opsA.accounts.total === 2, JSON.stringify(opsA && { t: opsA.teeTimes, o: opsA.offers, a: opsA.accounts }));
    ok('A 최근 변경 이력 포함', opsA && opsA.recent.some(item => item.action === 'special-offer.created'));

    const adminTees = await call('GET', `/api/admin/tee-times?courseId=${encodeURIComponent(courseA)}`, { token: adminToken });
    eq('본사 전체 티타임 조회', adminTees.data.count, 1);
    eq('본사 조회에 골프장명 포함', adminTees.data.teeTimes[0].courseName, '스테이지7 알파 CC');
    const adminOffers = await call('GET', `/api/admin/special-offers?courseId=${encodeURIComponent(courseA)}`, { token: adminToken });
    eq('본사 전체 특가 조회', adminOffers.data.count, 1);

    const logs = await call('GET', '/api/admin/audit-logs?limit=200', { token: adminToken });
    const actions = (logs.data.logs || []).map(item => item.action);
    ['partner.login', 'partner-account.created', 'tee-time.created', 'tee-time.updated', 'rates.updated', 'special-offer.created', 'special-offer.updated'].forEach(action => {
      ok(`감사 로그에 ${action}`, actions.includes(action), actions.join(','));
    });
    const partnerLog = (logs.data.logs || []).find(item => item.action === 'tee-time.created' && item.actor && item.actor.email === 'alpha@stage7.example.com');
    ok('감사 로그에 담당자 유형·이메일', partnerLog && partnerLog.actor.type === 'partner', JSON.stringify((logs.data.logs || []).find(item => item.action === 'tee-time.created')?.actor));

    /* 13. 계정 비활성화·세션 무효화 ---------------------------------------- */
    section('7단계 · 계정 비활성화 즉시 세션 무효화');
    const disable = await call('PATCH', `/api/admin/partner-accounts/${encodeURIComponent(accountA.id)}`, { token: adminToken, body: { status: 'disabled', version: accountA.version } });
    eq('A 계정 사용 중지 200', disable.status, 200);
    eq('A 계정 상태', disable.data.account.status, 'disabled');
    const disabledSession = await call('GET', '/api/partner/session', { token: tokenA });
    eq('중지된 계정 기존 토큰 401', disabledSession.status, 401);
    ok('중지 안내 코드', disabledSession.data.error.code === 'account_disabled', JSON.stringify(disabledSession.data.error));
    const disabledWrite = await call('POST', '/api/partner/tee-times', { token: tokenA, body: { date: tomorrow, time: '12:30', capacityTeams: 1, maxPlayers: 4, greenFee: 150000 } });
    eq('중지된 계정 쓰기 401', disabledWrite.status, 401);
    const disabledLogin = await call('POST', '/api/partner/login', { body: { email: 'alpha@stage7.example.com', password: passwordA } });
    eq('중지된 계정 로그인 403', disabledLogin.status, 403);

    accountA = disable.data.account;
    const enable = await call('PATCH', `/api/admin/partner-accounts/${encodeURIComponent(accountA.id)}`, { token: adminToken, body: { status: 'active', version: accountA.version } });
    eq('A 계정 사용 재개 200', enable.status, 200);
    accountA = enable.data.account;
    const oldTokenAfterEnable = await call('GET', '/api/partner/session', { token: tokenA });
    eq('재개 후에도 기존 토큰 401(세션 무효화)', oldTokenAfterEnable.status, 401);
    ok('세션 무효화 코드', oldTokenAfterEnable.data.error.code === 'session_invalidated', JSON.stringify(oldTokenAfterEnable.data.error));
    const reloginA = await call('POST', '/api/partner/login', { body: { email: 'alpha@stage7.example.com', password: passwordA } });
    eq('재개 후 새 로그인 200', reloginA.status, 200);
    tokenA = reloginA.data.token;

    /* 14. 비밀번호 재설정 --------------------------------------------------- */
    section('7단계 · 비밀번호 재설정과 세션 만료');
    const reset = await call('POST', `/api/admin/partner-accounts/${encodeURIComponent(accountA.id)}/reset-password`, { token: adminToken, body: {} });
    eq('비밀번호 재설정 200', reset.status, 200);
    const newPasswordA = reset.data.initialPassword;
    ok('새 비밀번호 반환', typeof newPasswordA === 'string' && newPasswordA.length >= 8);
    const tokenAfterReset = await call('GET', '/api/partner/session', { token: tokenA });
    eq('재설정 후 기존 토큰 401', tokenAfterReset.status, 401);
    const oldPasswordLogin = await call('POST', '/api/partner/login', { body: { email: 'alpha@stage7.example.com', password: passwordA } });
    eq('이전 비밀번호 로그인 401', oldPasswordLogin.status, 401);
    const newPasswordLogin = await call('POST', '/api/partner/login', { body: { email: 'alpha@stage7.example.com', password: newPasswordA } });
    eq('새 비밀번호 로그인 200', newPasswordLogin.status, 200);
    tokenA = newPasswordLogin.data.token;
    passwordA = newPasswordA;
    accountA = newPasswordLogin.data.account;

    /* 15. 재시작 후 유지 ---------------------------------------------------- */
    section('7단계 · 서버 재시작 후 데이터 유지');
    await stopServer(server);
    ok('DB 파일 존재', fs.existsSync(dbPath));
    const rawDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    /* 8단계에서 스키마 버전 3 으로 올라갔다(7단계 데이터는 자동 호환). */
    ok('DB 버전 3(7단계 데이터 호환)', rawDb.version === 3, rawDb.version);
    eq('DB에 담당자 계정 3개', (rawDb.partnerAccounts || []).length, 3);
    eq('DB에 티타임 2건', (rawDb.teeTimes || []).length, 2);
    ok('DB에 요금·특가 저장', Boolean(rawDb.rates[courseA]) && (rawDb.specialOffers || []).length === 1);
    ok('DB에 비밀번호 평문 없음', !JSON.stringify(rawDb.partnerAccounts).includes(passwordA) && Boolean((rawDb.partnerAccounts || [])[0].passwordHash));

    server = await startServer(env);
    await waitForHealth(base);
    const restartLogin = await call('POST', '/api/partner/login', { body: { email: 'alpha@stage7.example.com', password: passwordA } });
    eq('재시작 후 A 로그인 200', restartLogin.status, 200);
    tokenA = restartLogin.data.token;
    const restartTees = await call('GET', '/api/partner/tee-times?date=' + tomorrow, { token: tokenA });
    eq('재시작 후 티타임 유지', restartTees.data.count, 1);
    eq('재시작 후 티타임 버전 유지', restartTees.data.teeTimes[0].version, 2);
    const restartRates = await call('GET', '/api/partner/rates', { token: tokenA });
    eq('재시작 후 요금 유지', restartRates.data.rates.threePlayerGreenFee, 180000);
    const restartOffers = await call('GET', '/api/partner/special-offers', { token: tokenA });
    eq('재시작 후 특가 유지', restartOffers.data.count, 1);
    const restartCatalog = await call('GET', `/api/public/catalog?date=${tomorrow}&courseId=${encodeURIComponent(courseA)}`);
    eq('재시작 후 공개 카탈로그 특가 적용', restartCatalog.data.courses[0].teeTimes[0].appliedPrice, 128000);

    /* 16. 예약 연결 티타임 삭제 차단 --------------------------------------- */
    section('7단계 · 예약이 연결된 티타임 삭제 차단(재시작 후)');
    await stopServer(server);
    const editable = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    /* 8단계 전이라 서버 예약 API 가 없다. DB 파일에 예약 1건을 넣어 삭제 차단 조건을 검증한다. */
    editable.reservations = [{ id: 'RES-TEST-1', teeTimeId: teeA.id, courseId: courseA, status: 'confirmed', date: tomorrow, time: '07:30' }];
    fs.writeFileSync(dbPath, `${JSON.stringify(editable, null, 2)}\n`);
    server = await startServer(env);
    await waitForHealth(base);
    const relogin2 = await call('POST', '/api/partner/login', { body: { email: 'alpha@stage7.example.com', password: passwordA } });
    tokenA = relogin2.data.token;
    const deleteInUse = await call('DELETE', `/api/partner/tee-times/${encodeURIComponent(teeA.id)}?version=2`, { token: tokenA });
    eq('예약 연결 티타임 삭제 409', deleteInUse.status, 409);
    ok('삭제 차단 사유 코드(예약)', deleteInUse.data.error.code === 'tee_time_in_use', JSON.stringify(deleteInUse.data.error));

    const spare = await call('POST', '/api/partner/tee-times', { token: tokenA, body: { date: dayAfter, time: '10:10', session: '2부', capacityTeams: 2, maxPlayers: 4, greenFee: 150000 } });
    eq('삭제용 티타임 등록', spare.status, 201);
    const deleteSpare = await call('DELETE', `/api/partner/tee-times/${encodeURIComponent(spare.data.teeTime.id)}?version=1`, { token: tokenA });
    eq('미사용 티타임 삭제 200', deleteSpare.status, 200);
    const afterDelete = await call('GET', '/api/partner/tee-times?date=' + dayAfter, { token: tokenA });
    eq('삭제 후 목록 0건', afterDelete.data.count, 0);

    /* 17. 반복 등록 -------------------------------------------------------- */
    section('7단계 · 날짜 반복 티타임 등록');
    const recurring = await call('POST', '/api/partner/tee-times/recurring', {
      token: tokenA,
      body: { startDate: kstDate(3), endDate: kstDate(9), time: '06:50', session: '1부', course: '전체', capacityTeams: 1, maxPlayers: 4, greenFee: 145000, status: 'open', weekdays: [1, 3, 5] }
    });
    eq('반복 등록 200', recurring.status, 200);
    ok('반복 등록 건수 1건 이상', recurring.data.created >= 1, JSON.stringify(recurring.data));
    const repeatAgain = await call('POST', '/api/partner/tee-times/recurring', {
      token: tokenA,
      body: { startDate: kstDate(3), endDate: kstDate(9), time: '06:50', session: '1부', course: '전체', capacityTeams: 1, maxPlayers: 4, greenFee: 145000, weekdays: [1, 3, 5] }
    });
    eq('같은 반복 재등록은 모두 건너뜀', repeatAgain.data.created, 0);
    eq('건너뛴 건수 유지', repeatAgain.data.skipped, recurring.data.created);

    /* 18. 정적 모드·고객 앱 연동 -------------------------------------------- */
    section('7단계 · 정적 모드 폴백과 고객 앱 반영');
    const staticClient = await runApiClient({ search: '', serverFlag: false });
    eq('정적 호스팅은 즉시 정적 모드', await staticClient.api.init(), 'static');
    eq('정적 모드 네트워크 요청 0건', staticClient.calls(), 0);
    const staticCatalog = runStaticServerCatalog();
    eq('정적 모드 서버 카탈로그 요청 0건', staticCatalog.calls(), 0);
    eq('정적 모드 카탈로그 동기화 비활성', await staticCatalog.ensure(), false);

    const catalogPayload = (await call('GET', `/api/public/catalog?date=${tomorrow}&courseId=${encodeURIComponent(courseA)}`)).data;
    const offset = await runServerCatalog({ payload: catalogPayload, date: tomorrow });
    ok('서버 카탈로그가 날짜 캐시 적용', offset.applied === true);
    eq('캐시에서 서버 티타임 1건', offset.teeTimes().length, 1);
    eq('캐시에서 특가 1건', offset.offers().length, 1);
    eq('관리 골프장으로 등록', offset.isManaged(), true);
    eq('관리 골프장의 다른 날짜는 빈 배열', offset.teeTimesOn(dayAfter).length, 0);
    eq('미관리 골프장은 null(시연 폴백)', offset.teeTimesOnOther(), null);

    const app = runAppWithServerCatalog(catalogPayload, await (await fetch(`${base}/api/partner-courses`)).json(), courseA);
    ok('고객 앱이 서버 티타임 표시', app.times.length === 1 && app.times[0].serverManaged === true, JSON.stringify(app.times.map(item => ({ time: item.time, serverManaged: item.serverManaged }))));
    eq('고객 앱 특가 적용가 128000', app.times[0].price, 128000);
    eq('고객 앱 정상가 160000', app.times[0].regularPrice, 160000);
    eq('고객 앱 특가 할인율', app.times[0].specialOffer && app.times[0].specialOffer.discountRate, 20);
    eq('고객 앱 3인 추가금 반영', app.playerSurcharge(3), 30000);
    eq('고객 앱 4인 추가금 없음', app.playerSurcharge(4), 0);
    eq('서버 연동 시 서버 재고 그대로 사용(로컬 중복 차감 없음)', app.remainingAfterReservation(), 2);
    app.reset();
    ok('서버 카탈로그가 없으면 기존 시연 티타임', app.demoFallbackCount() > 0, app.demoFallbackCount());
    eq('정적 모드에서 서버 카탈로그 요청 없음', staticClient.calls(), 0);
  } finally {
    await stopServer(server);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  }

  for (const item of results) {
    if (item.heading) { console.log(`\n${item.name}`); continue; }
    console.log(`${item.ok ? '  ✓' : '  ✗'} ${item.name}${item.ok || !item.detail ? '' : `\n      → ${item.detail}`}`);
  }
  const total = results.filter(item => !item.heading).length;
  const passed = results.filter(item => !item.heading && item.ok).length;
  console.log(`\n결과: ${passed}/${total} 통과, ${total - passed} 실패`);
  if (passed !== total) process.exitCode = 1;
}

/* --- 도우미: api-client.js 를 가짜 브라우저에서 실행 --------------------- */
function makeStorage() {
  const memory = {};
  return {
    getItem: key => (Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null),
    setItem: (key, value) => { memory[key] = String(value); },
    removeItem: key => { delete memory[key]; }
  };
}
async function runApiClient(options) {
  const calls = { count: 0 };
  const sandbox = {
    location: { search: options.search || '', href: 'https://neved12.github.io/all-golf-test/', origin: 'https://neved12.github.io', protocol: 'https:' },
    localStorage: makeStorage(), sessionStorage: makeStorage(), URLSearchParams,
    fetch: (...args) => { calls.count += 1; return Promise.reject(new Error('no network')); },
    setTimeout, clearTimeout, AbortController,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    console
  };
  sandbox.window = sandbox;
  sandbox.window.dispatchEvent = () => {};
  if (options.serverFlag) sandbox.ALL_GOLF_SERVER_MODE = true;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(rootDir, 'data/api-client.js'), 'utf8'), sandbox, { filename: 'data/api-client.js' });
  return { api: sandbox.ALL_GOLF_API, calls: () => calls.count };
}

/* --- 도우미: server-catalog.js 를 가짜 브라우저에서 실행 ----------------- */
async function runServerCatalog(options) {
  const stored = makeStorage();
  const applied = [];
  const sandbox = {
    location: { search: '', href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', protocol: 'http:' },
    localStorage: stored, sessionStorage: makeStorage(),
    URLSearchParams, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    console
  };
  sandbox.window = sandbox;
  sandbox.window.dispatchEvent = () => {};
  sandbox.ALL_GOLF_API = {
    state: { mode: 'server', connecting: false, base: 'http://127.0.0.1' },
    init: () => Promise.resolve('server'),
    request: (pathname) => Promise.resolve({ ok: true, status: 200, data: options.payload }),
    apiUrl: pathname => pathname,
    onModeChange: () => () => {}
  };
  sandbox.ALL_GOLF_STORE = {
    applyServerOperations: args => { applied.push(args); return true; }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(rootDir, 'data/server-catalog.js'), 'utf8'), sandbox, { filename: 'data/server-catalog.js' });
  const catalog = sandbox.ALL_GOLF_SERVER_CATALOG;
  const appliedOk = catalog.applyPayload(options.date, options.payload);
  return {
    applied: appliedOk,
    teeTimes: () => catalog.teeTimesFor(options.payload.courses[0].courseId, options.date) || [],
    teeTimesOn: date => catalog.teeTimesFor(options.payload.courses[0].courseId, date) || [],
    teeTimesOnOther: () => catalog.teeTimesFor('cn-gcz-cheonan', options.date),
    offers: () => catalog.offersFor(options.payload.courses[0].courseId, options.date) || [],
    isManaged: () => catalog.isManaged(options.payload.courses[0].courseId),
    appliedOps: applied
  };
}

/* --- 도우미: 정적 모드 server-catalog.js -------------------------------- */
function runStaticServerCatalog() {
  let calls = 0;
  const sandbox = {
    location: { search: '', href: 'https://neved12.github.io/all-golf-test/', origin: 'https://neved12.github.io', protocol: 'https:' },
    localStorage: makeStorage(), sessionStorage: makeStorage(), URLSearchParams,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    console
  };
  sandbox.window = sandbox;
  sandbox.window.dispatchEvent = () => {};
  sandbox.ALL_GOLF_API = {
    state: { mode: 'static', connecting: false, base: '' },
    init: () => Promise.resolve('static'),
    request: () => { calls += 1; return Promise.resolve({ ok: false, status: 0, data: {} }); },
    apiUrl: pathname => pathname,
    onModeChange: () => () => {}
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(rootDir, 'data/server-catalog.js'), 'utf8'), sandbox, { filename: 'data/server-catalog.js' });
  return { calls: () => calls, ensure: () => sandbox.ALL_GOLF_SERVER_CATALOG.ensureDate('2026-11-25') };
}

/* --- 도우미: 실제 고객 앱 코드로 서버 티타임·특가 반영 확인 ------------- */
function runAppWithServerCatalog(payload, coursesPayload, courseId) {
  const preFiles = [
    'tests/dom-shim.js',
    'data/national-golf-courses.js',
    'data/golf-courses.js',
    'data/demo-teetimes.js',
    'data/partner-application.js',
    'data/shared-store.js',
    'data/partner-sync.js',
    'demo-transfer.js'
  ];
  const appSource = fs.readFileSync(path.join(rootDir, 'app.js'), 'utf8');
  const preSource = preFiles.map(file => `\n/* ===== ${file} ===== */\n${fs.readFileSync(path.join(rootDir, file), 'utf8')}`).join('\n');
  const run = new Function('__PAYLOAD__', '__COURSES__', '__COURSE_ID__', `
    ${preSource}
    if (__COURSES__ && window.ALL_GOLF_PARTNER_SYNC) window.ALL_GOLF_PARTNER_SYNC.applyServerCourses(__COURSES__);
    const entry = __PAYLOAD__.courses[0];
    window.ALL_GOLF_STORE.applyServerOperations({ courseId: entry.courseId, rates: entry.rates, offers: entry.offers });
    const serverTimes = entry.teeTimes;
    window.ALL_GOLF_SERVER_CATALOG = {
      teeTimesFor(course, date) { return String(course) === String(entry.courseId) ? serverTimes : null; },
      ensureDate() { return Promise.resolve(true); },
      isServer() { return true; },
      inventoryLinked() { return true; },
      applyPayload() { return true; }
    };
    /* ===== app.js ===== */
    ${appSource}
    const target = courses.find(item => String(item.id) === String(__COURSE_ID__));
    const iso = entry.teeTimes[0].date;
    const reset = () => { localStorage.removeItem('allGolfReservations'); };
    const values = {
      times: timesFor(target, iso),
      playerSurcharge(people) { return shared.getPlayerSurcharge(target.id, people, target.demoThreePlayerSurcharge || 0); },
      remainingAfterReservation() {
        shared.setReservations([{ number: 'AG-TEST-00001', id: 'test-1', courseId: target.id, dateISO: iso, time: entry.teeTimes[0].time, status: 'confirmed', people: 4 }]);
        const found = timesFor(target, iso).find(item => item.id === entry.teeTimes[0].id);
        return found ? found.remaining : -1;
      },
      demoFallbackCount() { return timesFor(courses.find(item => item.id === 'woojeong'), shiftISO(todayISO, 3)).length; },
      reset
    };
    return values;
  `);
  return run(payload, coursesPayload, courseId);
}

main().catch(error => {
  console.error('\n테스트 실행 실패:', error && error.stack || error);
  process.exitCode = 1;
});
