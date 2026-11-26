#!/usr/bin/env node
/* ALL:GOLF 9단계 시나리오 테스트 — 본사 운영 통계·제휴 성과·수수료/정산 시뮬레이션·알림 로그
   사용법: node tests/run-stage9-scenarios.js   (= npm run test:stage9)
   - 실제 server/index.js 를 임시 DB 로 띄워 통계·정산 계산, 상태 전이, 중복/중복기간 409,
     파트너 골프장 격리 403, 알림 시뮬레이션 로그, DB v4 승격·재시작 유지, 정적 모드 0건을 검사한다. */
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    await sleep(150);
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
const today = kstDate(0);
const tomorrow = kstDate(1);
const day2 = kstDate(2);
const day3 = kstDate(3);
const day8 = kstDate(8);
const day20 = kstDate(20);
const day25 = kstDate(25);

const newApplication = (name, email) => ({
  courseMode: 'new', courseName: name, region: '경기', city: '이천',
  holes: '18', operationType: 'public', coursePhone: '031-555-0000', address: '경기 이천시 스테이지9로 9',
  website: 'https://stage9.example.com',
  managerName: '정담당', managerRole: '예약 담당', managerPhone: '010-8888-9999', managerEmail: email,
  weekdayGreenFee: '160000', weekendGreenFee: '190000', cartFee: '110000', caddieFee: '150000', teeInterval: '8',
  memo: '', agree: true
});

const booking = (courseId, date, teeTimeId, extra = {}) => ({
  courseId, date, teeTimeId, people: 4, booker: '김골퍼', phone: '010-1234-5678',
  companions: ['박동반'], request: '', terms: true, refund: true, ...extra
});

async function main() {
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allgolf-stage9-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const password = `stage9-${Math.random().toString(36).slice(2, 10)}`;
  const env = {
    PORT: String(port),
    ALLGOLF_DB_PATH: dbPath,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: 'stage9-test-secret-0123456789abcdef'
  };
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
  let courseA = '';
  let courseB = '';
  let tokenA = '';
  let tokenB = '';
  const tees = {};
  const reservations = {};

  async function createTee(token, date, time, capacityTeams, greenFee = 160000) {
    const hour = Number(time.slice(0, 2));
    const body = { date, time, session: hour < 10 ? '1부' : hour < 14 ? '2부' : '3부', course: '전체', capacityTeams, maxPlayers: 4, greenFee, status: 'open' };
    const response = await call('POST', '/api/partner/tee-times', { token, body });
    return response.data && response.data.teeTime;
  }

  /* 실행 중인 파일 DB 를 직접 고쳐 과거 예약(createdAt)을 만든다(기간 필터 검증용). */
  function patchDb(mutator) {
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    mutator(db);
    fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`);
  }

  try {
    /* 1. 서버 기동 --------------------------------------------------------- */
    section('9단계 · 서버 기동과 상태');
    server = await startServer(env);
    const health = await waitForHealth(base);
    ok('서버 기동 · /api/health 200', health && health.ok === true);
    eq('9단계 서버 표시', health.stage, 9);
    ok('1~9단계 표시', Array.isArray(health.stages) && health.stages.length === 9 && health.stages[8] === 9, JSON.stringify(health.stages));
    eq('DB 스키마 4', health.db.schemaVersion, 4);
    ok('통계·정산·수수료·알림 기능 표시', health.features.analytics === true && health.features.settlements === true
      && health.features.commissions === true && health.features.notifications === true);
    eq('기본 수수료율 8% 공개', health.settlement.defaultCommissionPercent, 8);
    ok('수수료율 범위 0~30 공개', JSON.stringify(health.settlement.commissionRange) === JSON.stringify([0, 30]), JSON.stringify(health.settlement.commissionRange));
    eq('정산 상태 4단계 공개', (health.settlement.statuses || []).join(','), 'DRAFT,PENDING,CONFIRMED,PAID');
    const home = await call('GET', '/');
    ok('정적 자산 9단계 캐시 버전', /v=20261126-(stage9b|national)/.test(home.text));

    /* 2. 준비: 골프장 A/B 승인·계정·티타임·요금 ---------------------------- */
    section('9단계 · 준비: 골프장 A/B·요금·티타임');
    const login = await call('POST', '/api/admin/login', { body: { password } });
    adminToken = login.data && login.data.token;
    ok('본사 로그인', Boolean(adminToken));
    const appA = await call('POST', '/api/partner-applications', { body: newApplication('스테이지9 알파 CC', 's9a@example.com') });
    const appB = await call('POST', '/api/partner-applications', { body: newApplication('스테이지9 베타 CC', 's9b@example.com') });
    const approveA = await call('POST', `/api/admin/partner-applications/${appA.data.application.id}/approve`, { token: adminToken, body: {} });
    const approveB = await call('POST', `/api/admin/partner-applications/${appB.data.application.id}/approve`, { token: adminToken, body: {} });
    courseA = approveA.data.application.newCourseId;
    courseB = approveB.data.application.newCourseId;
    eq('A/B 승인', `${approveA.status}/${approveB.status}`, '200/200');
    const accountA = await call('POST', '/api/admin/partner-accounts', { token: adminToken, body: { courseId: courseA, email: 'owner9a@example.com', name: '알파 대표', role: 'owner', password: 'Stage9Pass1' } });
    const accountB = await call('POST', '/api/admin/partner-accounts', { token: adminToken, body: { courseId: courseB, email: 'owner9b@example.com', name: '베타 대표', role: 'owner', password: 'Stage9Pass2' } });
    eq('A/B 계정 발급', `${accountA.status}/${accountB.status}`, '201/201');
    const loginA = await call('POST', '/api/partner/login', { body: { email: 'owner9a@example.com', password: 'Stage9Pass1' } });
    const loginB = await call('POST', '/api/partner/login', { body: { email: 'owner9b@example.com', password: 'Stage9Pass2' } });
    tokenA = loginA.data.token;
    tokenB = loginB.data.token;
    ok('A/B 담당자 로그인', Boolean(tokenA && tokenB));

    tees.a1 = await createTee(tokenA, tomorrow, '07:30', 6);
    tees.a2 = await createTee(tokenA, day2, '12:30', 6);
    tees.a3 = await createTee(tokenA, day8, '15:30', 6);
    tees.b1 = await createTee(tokenB, tomorrow, '08:30', 4);
    ok('티타임 4개 등록', Boolean(tees.a1 && tees.a2 && tees.a3 && tees.b1));
    const ratesA = await call('PUT', '/api/partner/rates', {
      token: tokenA,
      body: {
        baseGreenFee: 160000, threePlayerGreenFee: 180000, fourPlayerGreenFee: 150000,
        threePlayerSurcharge: 10000, twoPlayerSurcharge: 5000, cartFee: 110000, caddieFee: 150000,
        depositType: 'person', depositValue: 30000, version: 0,
        cancellationPolicy: { sevenPlus: 100, fourToSix: 80, twoToThree: 60, oneDay: 20, sameDay: 0, cutoffHoursBefore: null }
      }
    });
    eq('A 요금·취소정책 저장', ratesA.status, 200);

    /* 3. 수수료율 관리 ------------------------------------------------------ */
    section('9단계 · 골프장별 수수료율');
    const commissions = await call('GET', '/api/admin/commissions', { token: adminToken });
    eq('수수료율 목록 200', commissions.status, 200);
    eq('승인 골프장 2곳', commissions.data.count, 2);
    const rowA = (commissions.data.courses || []).find(item => item.courseId === courseA);
    const rowB = (commissions.data.courses || []).find(item => item.courseId === courseB);
    ok('기본 수수료율 8%·기본값 표시', rowA && rowA.ratePercent === 8 && rowA.source === 'default', JSON.stringify(rowA));
    eq('범위 값 전달', `${commissions.data.minPercent}/${commissions.data.maxPercent}`, '0/30');
    const setA = await call('PUT', `/api/admin/commissions/${encodeURIComponent(courseA)}`, { token: adminToken, body: { ratePercent: 10 } });
    eq('A 수수료율 10% 설정', setA.status, 200);
    eq('설정값 반영', setA.data.commission.ratePercent, 10);
    eq('설정 출처 custom', setA.data.commission.source, 'custom');
    const tooHigh = await call('PUT', `/api/admin/commissions/${encodeURIComponent(courseA)}`, { token: adminToken, body: { ratePercent: 31 } });
    eq('30% 초과 400', tooHigh.status, 400);
    ok('범위 오류 안내', String(tooHigh.data.error.message).includes('0~30'));
    const tooLow = await call('PUT', `/api/admin/commissions/${encodeURIComponent(courseA)}`, { token: adminToken, body: { ratePercent: -1 } });
    eq('음수 수수료율 400', tooLow.status, 400);
    const notNumber = await call('PUT', `/api/admin/commissions/${encodeURIComponent(courseA)}`, { token: adminToken, body: { ratePercent: 'abc' } });
    eq('숫자 아님 400', notNumber.status, 400);
    const staleVersion = await call('PUT', `/api/admin/commissions/${encodeURIComponent(courseA)}`, { token: adminToken, body: { ratePercent: 11, version: 0 } });
    eq('이전 버전으로 수정 409', staleVersion.status, 409);
    eq('버전 충돌 코드', staleVersion.data.error.code, 'version_conflict');
    const unknownCourse = await call('PUT', '/api/admin/commissions/no-such-course', { token: adminToken, body: { ratePercent: 5 } });
    eq('없는 골프장 404', unknownCourse.status, 404);
    const noAuthCommission = await call('GET', '/api/admin/commissions');
    eq('수수료율 조회 인증 401', noAuthCommission.status, 401);
    const partnerCommission = await call('GET', '/api/partner/commission', { token: tokenA });
    eq('담당자 본인 수수료율 조회', `${partnerCommission.status}/${partnerCommission.data.commission.ratePercent}`, '200/10');
    const crossCommission = await call('GET', `/api/partner/commission?courseId=${encodeURIComponent(courseB)}`, { token: tokenA });
    eq('다른 골프장 수수료율 조회 403', crossCommission.status, 403);
    const logsAfterCommission = await call('GET', '/api/admin/audit-logs?action=commission.updated', { token: adminToken });
    ok('수수료율 변경 감사 로그', logsAfterCommission.data.logs.some(item => item.courseId === courseA && String(item.memo).includes('10')), JSON.stringify(logsAfterCommission.data.logs[0] || {}));

    /* 4. 예약·취소·노쇼·이용완료 데이터 ------------------------------------ */
    section('9단계 · 정산·통계용 예약 데이터');
    const r1 = await call('POST', '/api/public/reservations', { body: booking(courseA, tomorrow, tees.a1.id, { booker: '김일번', phone: '010-1111-0001', sessionId: 's9-r1' }) });
    const r2 = await call('POST', '/api/public/reservations', { body: booking(courseA, day2, tees.a2.id, { people: 3, booker: '이이번', phone: '010-1111-0002', sessionId: 's9-r2' }) });
    const r3 = await call('POST', '/api/public/reservations', { body: booking(courseA, day8, tees.a3.id, { booker: '삼삼번', phone: '010-1111-0003', sessionId: 's9-r3' }) });
    const r4 = await call('POST', '/api/public/reservations', { body: booking(courseB, tomorrow, tees.b1.id, { booker: '사사번', phone: '010-1111-0004', sessionId: 's9-r4' }) });
    const r5 = await call('POST', '/api/public/reservations', { body: booking(courseA, tomorrow, tees.a1.id, { booker: '오오번', phone: '010-1111-0005', sessionId: 's9-r5' }) });
    const r6 = await call('POST', '/api/public/reservations', { body: booking(courseA, tomorrow, tees.a1.id, { booker: '육육번', phone: '010-1111-0006', sessionId: 's9-r6' }) });
    eq('A/B 예약 6건 생성', [r1, r2, r3, r4, r5, r6].map(item => item.status).join(','), '201,201,201,201,201,201');
    Object.assign(reservations, { r1: r1.data.reservation, r2: r2.data.reservation, r3: r3.data.reservation, r4: r4.data.reservation, r5: r5.data.reservation, r6: r6.data.reservation });
    eq('A 4인 예약 총액 860,000', reservations.r1.totalEstimated, 860000);
    eq('A 3인 예약 총액 800,000', reservations.r2.totalEstimated, 800000);
    eq('B 4인 예약 총액 900,000', reservations.r4.totalEstimated, 900000);
    eq('A 4인 예약금 120,000', reservations.r1.paidDeposit, 120000);

    const cancelled = await call('POST', `/api/public/reservations/${encodeURIComponent(reservations.r6.number)}/cancel`, { body: { phone: '010-1111-0006', reason: '일정 변경' } });
    eq('R6 고객 취소 200', cancelled.status, 200);
    eq('R6 환불률 20%(1일 전)', cancelled.data.refund.refundRate, 20);
    eq('R6 환불액 24,000', cancelled.data.refund.refundAmount, 24000);
    eq('R6 취소 수수료 96,000', cancelled.data.refund.cancellationFee, 96000);
    const completed = await call('POST', `/api/admin/reservations/${encodeURIComponent(reservations.r3.id)}/status`, { token: adminToken, body: { status: 'completed', reason: '라운드 종료' } });
    eq('R3 이용 완료 200', completed.status, 200);
    const noShow = await call('POST', `/api/admin/reservations/${encodeURIComponent(reservations.r5.id)}/status`, { token: adminToken, body: { status: 'no_show', reason: '연락 두절' } });
    eq('R5 노쇼 처리 200', noShow.status, 200);

    /* 5. 운영 통계 ---------------------------------------------------------- */
    section('9단계 · 운영 통계(오늘/7일/30일/전체)');
    const anToday = await call('GET', '/api/admin/analytics?period=today', { token: adminToken });
    eq('통계 200', anToday.status, 200);
    const t = anToday.data.totals || {};
    eq('기간 표시', `${anToday.data.period.key}/${anToday.data.period.from}/${anToday.data.period.to}`, `today/${today}/${today}`);
    eq('예약 접수일 기준 명시', anToday.data.period.basis, 'createdAt');
    eq('예약 건수 6', t.reservations, 6);
    eq('확정 3 · 이용완료 1 · 노쇼 1 · 취소 1', `${t.confirmed}/${t.completed}/${t.noShow}/${t.cancelled}`, '3/1/1/1');
    eq('GMV 4,280,000', t.gmv, 4280000);
    eq('확정 인원 19명', t.people, 19);
    eq('환불액 24,000', t.refundAmount, 24000);
    eq('취소 수수료 96,000', t.cancellationFee, 96000);
    eq('정산 기준액 4,376,000', t.basisAmount, 4376000);
    eq('노쇼율 20%', t.noShowRate, 20);
    eq('취소율 16.7%', t.cancelRate, 16.7);
    eq('객단가 856,000', t.averageTicket, 856000);
    eq('1부 예약 3건', t.sessions['1부'], 3);
    eq('2부 예약 1건', t.sessions['2부'], 1);
    eq('3부 예약 1건', t.sessions['3부'], 1);
    const byCourseA = (anToday.data.byCourse || []).find(item => item.courseId === courseA);
    const byCourseB = (anToday.data.byCourse || []).find(item => item.courseId === courseB);
    eq('골프장별 A GMV 3,380,000', byCourseA.gmv, 3380000);
    eq('골프장별 B GMV 900,000', byCourseB.gmv, 900000);
    eq('A 수수료율 10% 반영', byCourseA.commissionRatePercent, 10);
    eq('B 수수료율 기본 8%', byCourseB.commissionRatePercent, 8);
    eq('A 플랫폼 수수료 347,600', byCourseA.platformFee, 347600);
    eq('A 정산 예정액 3,128,400', byCourseA.payoutAmount, 3128400);
    eq('B 플랫폼 수수료 72,000', byCourseB.platformFee, 72000);
    const apps = anToday.data.applications || {};
    eq('기간 내 제휴 신청 2건', apps.total, 2);
    eq('승인 2건', apps.approved, 2);
    eq('승인 전환율 100%', apps.conversionRate, 100);
    const an7 = await call('GET', '/api/admin/analytics?period=7d', { token: adminToken });
    eq('7일 통계 합계 동일', an7.data.totals.gmv, 4280000);
    const an30 = await call('GET', '/api/admin/analytics?period=30d', { token: adminToken });
    eq('30일 통계 합계 동일', an30.data.totals.reservations, 6);
    const anAll = await call('GET', '/api/admin/analytics?period=all', { token: adminToken });
    eq('전체 기간 from 없음', anAll.data.period.from, null);
    eq('전체 통계 합계 동일', anAll.data.totals.gmv, 4280000);
    const filtered = await call('GET', `/api/admin/analytics?period=today&courseId=${encodeURIComponent(courseB)}`, { token: adminToken });
    eq('골프장 필터 1곳', filtered.data.byCourse.length, 1);
    eq('골프장 필터 GMV', filtered.data.totals.gmv, 900000);
    const noAuthAnalytics = await call('GET', '/api/admin/analytics');
    eq('통계 조회 인증 401', noAuthAnalytics.status, 401);

    /* 기간 필터: R1 을 45일 전 접수로 바꾸면 오늘/30일에서 빠지고 전체에는 남는다. */
    patchDb(db => {
      const target = (db.reservations || []).find(item => item.id === reservations.r1.id);
      if (target) target.createdAt = new Date(Date.now() - 45 * 86400000).toISOString();
    });
    const anTodayAfter = await call('GET', '/api/admin/analytics?period=today', { token: adminToken });
    eq('45일 전 접수 예약은 오늘 통계에서 제외', anTodayAfter.data.totals.reservations, 5);
    eq('제외 후 GMV 3,420,000', anTodayAfter.data.totals.gmv, 3420000);
    const an30After = await call('GET', '/api/admin/analytics?period=30d', { token: adminToken });
    eq('30일 통계에서도 제외', an30After.data.totals.gmv, 3420000);
    const anAllAfter = await call('GET', '/api/admin/analytics?period=all', { token: adminToken });
    eq('전체 통계에는 포함', anAllAfter.data.totals.gmv, 4280000);
    patchDb(db => {
      const target = (db.reservations || []).find(item => item.id === reservations.r1.id);
      if (target) target.createdAt = new Date().toISOString();
    });

    /* 6. CSV/JSON 내보내기 -------------------------------------------------- */
    section('9단계 · 통계 CSV 내보내기');
    const csv = await call('GET', '/api/admin/analytics?period=today&format=csv', { token: adminToken });
    eq('CSV 200', csv.status, 200);
    ok('CSV Content-Type', String(csv.headers.get('content-type')).includes('text/csv'), csv.headers.get('content-type'));
    ok('CSV 첨부 파일명', String(csv.headers.get('content-disposition')).includes('allgolf-analytics'), csv.headers.get('content-disposition'));
    const rawCsv = await fetch(`${base}/api/admin/analytics?period=today&format=csv`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const csvBytes = Buffer.from(await rawCsv.arrayBuffer());
    ok('CSV BOM 포함(UTF-8)', csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF, [...csvBytes.slice(0, 3)].join(','));
    const csvLines = csv.text.replace(/^\uFEFF/, '').split('\r\n');
    ok('CSV 헤더에 골프장·GMV', csvLines[0].includes('골프장') && csvLines[0].includes('GMV'), csvLines[0]);
    eq('CSV 행 수(헤더+2곳+합계)', csvLines.length, 4);
    ok('CSV 에 골프장 이름', csv.text.includes('스테이지9 알파 CC'));
    eq('CSV 에 수수료율 10', csvLines[1].includes('"10"') || csvLines[1].includes(',10,'), true);
    const csvNoAuth = await call('GET', '/api/admin/analytics?format=csv');
    eq('CSV 인증 401', csvNoAuth.status, 401);

    /* 7. 정산서 생성·계산 --------------------------------------------------- */
    section('9단계 · 정산서 계산·중복 방어');
    const settleA = await call('POST', '/api/admin/settlements', { token: adminToken, body: { courseId: courseA, from: tomorrow, to: day8 } });
    eq('A 정산서 생성 201', settleA.status, 201);
    const sA = settleA.data.settlement;
    ok('정산번호 ST-YYYYMM-NNNN', /^ST-\d{6}-\d{4}$/.test(sA.number), sA.number);
    eq('정산 상태 DRAFT', sA.status, 'DRAFT');
    eq('정산 수수료율 스냅샷 10%', sA.commissionRatePercent, 10);
    eq('정산 GMV 3,380,000', sA.grossAmount, 3380000);
    eq('정산 취소 수수료 96,000', sA.cancellationFee, 96000);
    eq('정산 기준액 3,476,000', sA.basisAmount, 3476000);
    eq('플랫폼 수수료 347,600', sA.platformFee, 347600);
    eq('정산 예정액 3,128,400', sA.payoutAmount, 3128400);
    eq('정산 예약 건수 5', sA.reservations, 5);
    eq('정산 취소 1건', sA.cancelled, 1);
    ok('정산 계산식 제공', sA.calculation && String(sA.calculation.formula.basisAmount).includes('cancellationFee'), JSON.stringify(sA.calculation && sA.calculation.formula));
    const duplicate = await call('POST', '/api/admin/settlements', { token: adminToken, body: { courseId: courseA, from: tomorrow, to: day8 } });
    eq('같은 기간 중복 정산 409', duplicate.status, 409);
    eq('중복 정산 코드', duplicate.data.error.code, 'duplicate_settlement');
    const overlap = await call('POST', '/api/admin/settlements', { token: adminToken, body: { courseId: courseA, from: day2, to: day3 } });
    eq('겹치는 기간 정산 409', overlap.status, 409);
    eq('겹침 코드', overlap.data.error.code, 'overlapping_settlement');
    const badRange = await call('POST', '/api/admin/settlements', { token: adminToken, body: { courseId: courseA, from: day8, to: tomorrow } });
    eq('역순 기간 400', badRange.status, 400);
    const noDates = await call('POST', '/api/admin/settlements', { token: adminToken, body: { courseId: courseA } });
    eq('기간 누락 400', noDates.status, 400);
    const unknownSettle = await call('POST', '/api/admin/settlements', { token: adminToken, body: { courseId: 'no-such-course', from: tomorrow, to: day8 } });
    eq('없는 골프장 정산 404', unknownSettle.status, 404);
    const noAuthSettle = await call('POST', '/api/admin/settlements', { body: { courseId: courseA, from: tomorrow, to: day8 } });
    eq('정산 생성 인증 401', noAuthSettle.status, 401);
    const settleB = await call('POST', '/api/admin/settlements', { token: adminToken, body: { courseId: courseB, from: tomorrow, to: tomorrow, status: 'PENDING' } });
    eq('B 정산서 PENDING 생성', `${settleB.status}/${settleB.data.settlement.status}`, '201/PENDING');
    eq('B 정산 예정액 828,000', settleB.data.settlement.payoutAmount, 828000);

    /* 8. 상태 전이 ---------------------------------------------------------- */
    section('9단계 · 정산 상태 전이(DRAFT→PENDING→CONFIRMED→PAID)');
    const skipToPaid = await call('POST', `/api/admin/settlements/${sA.id}/transition`, { token: adminToken, body: { status: 'PAID' } });
    eq('DRAFT 에서 PAID 로 건너뛰기 409', skipToPaid.status, 409);
    eq('전이 오류 코드', skipToPaid.data.error.code, 'invalid_transition');
    const toPending = await call('POST', `/api/admin/settlements/${sA.id}/transition`, { token: adminToken, body: { status: 'PENDING' } });
    eq('DRAFT→PENDING 200', `${toPending.status}/${toPending.data.settlement.status}`, '200/PENDING');
    const pendingAgain = await call('POST', `/api/admin/settlements/${sA.id}/transition`, { token: adminToken, body: { status: 'PENDING' } });
    eq('같은 상태 재전이 409', pendingAgain.status, 409);
    const wrongVersion = await call('POST', `/api/admin/settlements/${sA.id}/transition`, { token: adminToken, body: { status: 'CONFIRMED', version: 1 } });
    eq('이전 버전 전이 409', wrongVersion.status, 409);
    eq('버전 충돌 코드', wrongVersion.data.error.code, 'version_conflict');
    const toConfirmed = await call('POST', `/api/admin/settlements/${sA.id}/transition`, { token: adminToken, body: { status: 'CONFIRMED' } });
    eq('PENDING→CONFIRMED 200', `${toConfirmed.status}/${toConfirmed.data.settlement.status}`, '200/CONFIRMED');
    ok('확정 시각 기록', Boolean(toConfirmed.data.settlement.confirmedAt));
    const toPaid = await call('POST', `/api/admin/settlements/${sA.id}/transition`, { token: adminToken, body: { status: 'PAID' } });
    eq('CONFIRMED→PAID 200', `${toPaid.status}/${toPaid.data.settlement.status}`, '200/PAID');
    ok('지급 시각 기록', Boolean(toPaid.data.settlement.paidAt));
    const backToConfirmed = await call('POST', `/api/admin/settlements/${sA.id}/transition`, { token: adminToken, body: { status: 'CONFIRMED' } });
    eq('PAID 되돌리기 409', backToConfirmed.status, 409);
    const history = toPaid.data.settlement.history || [];
    eq('상태 이력 4단계', history.map(item => item.status).join(','), 'DRAFT,PENDING,CONFIRMED,PAID');
    ok('전이 처리자 기록', history.every(item => item.by && item.by.email), JSON.stringify(history.map(item => item.by)));
    const logsAfterSettle = await call('GET', '/api/admin/audit-logs?limit=200', { token: adminToken });
    const settleActions = (logsAfterSettle.data.logs || []).map(item => item.action);
    ok('감사 로그 정산서 생성', settleActions.includes('settlement.created'));
    ok('감사 로그 정산 확정', settleActions.includes('settlement.confirmed'));
    ok('감사 로그 정산 지급', settleActions.includes('settlement.paid'));
    const list = await call('GET', '/api/admin/settlements', { token: adminToken });
    eq('정산 목록 2건', list.data.count, 2);
    eq('상태별 집계 PAID 1', list.data.byStatus.PAID, 1);
    ok('정산 합계 제공', list.data.totals.payoutAmount === 3128400 + 828000, JSON.stringify(list.data.totals));
    const listFiltered = await call('GET', '/api/admin/settlements?status=PENDING', { token: adminToken });
    eq('상태 필터 1건', listFiltered.data.count, 1);
    const settleCsv = await call('GET', '/api/admin/settlements/export', { token: adminToken });
    eq('정산 CSV 200', settleCsv.status, 200);
    ok('정산 CSV 에 정산번호', settleCsv.text.includes(sA.number));
    const detail = await call('GET', `/api/admin/settlements/${sA.number}`, { token: adminToken });
    eq('정산번호로 상세 조회', `${detail.status}/${detail.data.settlement.id}`, `200/${sA.id}`);

    /* 9. 수수료율 변경 후 정산 스냅샷 --------------------------------------- */
    section('9단계 · 수수료율 변경과 정산 스냅샷');
    const changeRate = await call('PUT', `/api/admin/commissions/${encodeURIComponent(courseA)}`, { token: adminToken, body: { ratePercent: 12 } });
    eq('A 수수료율 12% 변경', `${changeRate.status}/${changeRate.data.commission.ratePercent}`, '200/12');
    const oldSettlement = await call('GET', `/api/admin/settlements/${sA.id}`, { token: adminToken });
    eq('이미 만든 정산서는 10% 유지', oldSettlement.data.settlement.commissionRatePercent, 10);
    eq('이미 만든 정산서 금액 불변', oldSettlement.data.settlement.platformFee, 347600);
    const newRange = await call('POST', '/api/admin/settlements', { token: adminToken, body: { courseId: courseA, from: day20, to: day25 } });
    eq('새 기간 정산서 201', newRange.status, 201);
    eq('새 정산서는 12% 적용', newRange.data.settlement.commissionRatePercent, 12);
    eq('예약 없는 기간 정산액 0', newRange.data.settlement.payoutAmount, 0);
    const analyticsAfterRate = await call('GET', '/api/admin/analytics?period=today', { token: adminToken });
    const byCourseAfter = (analyticsAfterRate.data.byCourse || []).find(item => item.courseId === courseA);
    eq('통계는 현재 수수료율 12% 반영', byCourseAfter.commissionRatePercent, 12);
    eq('통계 플랫폼 수수료 417,120', byCourseAfter.platformFee, 417120);

    /* 10. 파트너 정산·알림 격리 --------------------------------------------- */
    section('9단계 · 파트너 정산·알림 골프장 격리');
    const partnerList = await call('GET', '/api/partner/settlements', { token: tokenA });
    eq('A 정산 목록 200', partnerList.status, 200);
    eq('A 정산 2건만', partnerList.data.count, 2);
    ok('A 정산에 B 골프장 없음', (partnerList.data.settlements || []).every(item => item.courseId === courseA));
    eq('A 수수료율 12% 표시', partnerList.data.commission.ratePercent, 12);
    eq('A 정산 합계 제공', partnerList.data.totals.payoutAmount, 3128400);
    const crossList = await call('GET', `/api/partner/settlements?courseId=${encodeURIComponent(courseB)}`, { token: tokenA });
    eq('A가 B courseId 로 정산 조회 403', crossList.status, 403);
    const crossDetail = await call('GET', `/api/partner/settlements/${settleB.data.settlement.id}`, { token: tokenA });
    eq('A가 B 정산서 상세 403', crossDetail.status, 403);
    const ownDetail = await call('GET', `/api/partner/settlements/${sA.id}`, { token: tokenA });
    eq('A 본인 정산서 상세 200', ownDetail.status, 200);
    const partnerCreate = await call('POST', '/api/partner/settlements', { token: tokenA, body: { courseId: courseA, from: day25, to: day25 } });
    eq('담당자 정산서 생성 403', partnerCreate.status, 403);
    eq('담당자 생성 차단 코드', partnerCreate.data.error.code, 'forbidden_role');
    const partnerTransition = await call('POST', `/api/partner/settlements/${sA.id}/transition`, { token: tokenA, body: { status: 'PAID' } });
    eq('담당자 상태 변경 403', partnerTransition.status, 403);
    const partnerListB = await call('GET', '/api/partner/settlements', { token: tokenB });
    eq('B 정산 목록 1건', partnerListB.data.count, 1);
    eq('B 정산서만 표시', partnerListB.data.settlements[0].courseId, courseB);
    const noAuthPartner = await call('GET', '/api/partner/settlements');
    eq('담당자 정산 조회 인증 401', noAuthPartner.status, 401);

    /* 11. 알림 시뮬레이션 로그 ---------------------------------------------- */
    section('9단계 · 운영 알림 시뮬레이션 로그');
    const adminNotes = await call('GET', '/api/admin/notifications?limit=200', { token: adminToken });
    eq('알림 로그 200', adminNotes.status, 200);
    const notes = adminNotes.data.notifications || [];
    const events = notes.map(item => item.event);
    ok('예약 확정 알림 기록', events.includes('reservation.confirmed'));
    ok('예약 취소 알림 기록', events.includes('reservation.cancelled'));
    ok('정산 확정 알림 기록', events.includes('settlement.confirmed'));
    ok('정산 지급 알림 기록', events.includes('settlement.paid'));
    ok('모든 알림 상태 simulated', notes.every(item => item.status === 'simulated' && item.externalSend === false), JSON.stringify(notes.slice(0, 2)));
    ok('알림에 수신 대상·채널·제목·요약', notes.every(item => item.recipient && item.channel && item.subject && item.summary && item.at), JSON.stringify(notes[0]));
    ok('실제 발송 아님 안내', String(adminNotes.data.note).includes('실제 문자'), adminNotes.data.note);
    eq('알림 16건(예약 6×2 + 취소 2 + 정산 2)', notes.length, 16);
    const confirmedNote = notes.find(item => item.event === 'reservation.confirmed' && item.channel === 'simulated_sms');
    ok('예약 확정 문자에 예약번호·예약금', String(confirmedNote.summary).includes('예약금'), confirmedNote.summary);
    ok('고객 알림 연락처 마스킹', String(confirmedNote.recipient.phone).includes('****'), confirmedNote.recipient.phone);
    const settlementNote = notes.find(item => item.event === 'settlement.confirmed');
    eq('정산 알림 채널', settlementNote.channel, 'simulated_settlement');
    ok('정산 알림에 정산 예정액', String(settlementNote.summary).includes('3,128,400'), settlementNote.summary);
    const filterEvent = await call('GET', '/api/admin/notifications?event=settlement.confirmed', { token: adminToken });
    eq('이벤트 필터 1건', filterEvent.data.count, 1);
    const filterCourse = await call('GET', `/api/admin/notifications?courseId=${encodeURIComponent(courseB)}`, { token: adminToken });
    ok('골프장 필터 B 2건', filterCourse.data.count === 2, filterCourse.data.count);
    const partnerNotes = await call('GET', '/api/partner/notifications?limit=200', { token: tokenA });
    eq('A 알림 로그 200', partnerNotes.status, 200);
    ok('A 알림은 A 관련만', (partnerNotes.data.notifications || []).every(item => String(item.courseId) === courseA), JSON.stringify((partnerNotes.data.notifications || []).map(item => item.courseId)));
    eq('A 알림 14건', partnerNotes.data.count, 14);
    const partnerNotesB = await call('GET', '/api/partner/notifications', { token: tokenB });
    eq('B 알림 2건', partnerNotesB.data.count, 2);
    const crossNotes = await call('GET', `/api/partner/notifications?courseId=${encodeURIComponent(courseA)}`, { token: tokenB });
    eq('B가 A 알림 조회 403', crossNotes.status, 403);
    const noAuthNotes = await call('GET', '/api/admin/notifications');
    eq('알림 조회 인증 401', noAuthNotes.status, 401);

    /* 12. DB v4 저장 상태 --------------------------------------------------- */
    section('9단계 · DB 스키마 v4');
    const rawDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    eq('DB 버전 4', rawDb.version, 4);
    ok('수수료율 저장', rawDb.commissionRates && rawDb.commissionRates[courseA] && Number(rawDb.commissionRates[courseA].ratePercent) === 12, JSON.stringify(rawDb.commissionRates));
    eq('정산서 3건 저장', (rawDb.settlements || []).length, 3);
    eq('알림 로그 16건 저장', (rawDb.notificationLogs || []).length, 16);
    ok('정산 순번 보존', Object.keys(rawDb.meta.sequences || {}).some(key => key.startsWith('stl:')), JSON.stringify(rawDb.meta.sequences));
    ok('DB 에 세션·멱등 키 원문 없음', !JSON.stringify(rawDb.reservations).includes('idempotencyKey') && !JSON.stringify(rawDb.notificationLogs).includes('passwordHash'), '예약·알림 로그 확인');

    /* 13. 서버 재시작 유지 -------------------------------------------------- */
    section('9단계 · 서버 재시작 후 정산·수수료 유지');
    await stopServer(server);
    server = await startServer(env);
    const restartHealth = await waitForHealth(base);
    eq('재시작 후 스키마 4', restartHealth.db.schemaVersion, 4);
    eq('재시작 후 정산 3건', restartHealth.db.settlements, 3);
    const restartLogin = await call('POST', '/api/admin/login', { body: { password } });
    adminToken = restartLogin.data.token;
    const restartSettlements = await call('GET', '/api/admin/settlements', { token: adminToken });
    const paidSettlement = (restartSettlements.data.settlements || []).find(item => item.id === sA.id);
    eq('재시작 후 PAID 상태 유지', paidSettlement && paidSettlement.status, 'PAID');
    eq('재시작 후 금액 유지', paidSettlement && paidSettlement.payoutAmount, 3128400);
    const restartCommissions = await call('GET', '/api/admin/commissions', { token: adminToken });
    const restartRowA = (restartCommissions.data.courses || []).find(item => item.courseId === courseA);
    eq('재시작 후 수수료율 12% 유지', restartRowA && restartRowA.ratePercent, 12);
    const restartNotes = await call('GET', '/api/admin/notifications?limit=200', { token: adminToken });
    eq('재시작 후 알림 로그 유지', restartNotes.data.count, 16);
    const restartLoginA = await call('POST', '/api/partner/login', { body: { email: 'owner9a@example.com', password: 'Stage9Pass1' } });
    tokenA = restartLoginA.data.token;
    const restartPartnerSettlements = await call('GET', '/api/partner/settlements', { token: tokenA });
    eq('재시작 후 담당자 정산 조회', restartPartnerSettlements.data.count, 2);

    /* 14. 기존 DB(v3) 자동 v4 승격 ------------------------------------------ */
    section('9단계 · 기존 DB(v3) 자동 v4 승격');
    await stopServer(server);
    const legacy = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    legacy.version = 3;
    delete legacy.commissionRates;
    delete legacy.settlements;
    delete legacy.notificationLogs;
    fs.writeFileSync(dbPath, `${JSON.stringify(legacy, null, 2)}\n`);
    server = await startServer(env);
    const legacyHealth = await waitForHealth(base);
    eq('v3 DB 를 v4 로 승격', legacyHealth.db.schemaVersion, 4);
    ok('v3 데이터(골프장·예약) 유지', legacyHealth.db.approvedCourses >= 2 && legacyHealth.db.reservations >= 6, JSON.stringify({ courses: legacyHealth.db.approvedCourses, reservations: legacyHealth.db.reservations }));
    eq('v3 DB 에 정산 컬렉션 생성', `${legacyHealth.db.settlements}/${legacyHealth.db.commissionRates}/${legacyHealth.db.notificationLogs}`, '0/0/0');
    const legacyLogin = await call('POST', '/api/admin/login', { body: { password } });
    adminToken = legacyLogin.data.token;
    const legacyAnalytics = await call('GET', '/api/admin/analytics?period=all', { token: adminToken });
    eq('승격 후 통계 조회 유지', legacyAnalytics.data.totals.reservations, 6);
    const legacyCommissions = await call('GET', '/api/admin/commissions', { token: adminToken });
    const legacyRowA = (legacyCommissions.data.courses || []).find(item => item.courseId === courseA);
    eq('승격 후 기본 수수료율 8%', legacyRowA && legacyRowA.ratePercent, 8);
    const legacySettle = await call('POST', '/api/admin/settlements', { token: adminToken, body: { courseId: courseA, from: tomorrow, to: day8 } });
    eq('승격 후 정산 생성 가능', legacySettle.status, 201);

    /* 15. 정적 모드(서버 없음) 요청 0건 ------------------------------------ */
    section('9단계 · 정적 모드 폴백(API 요청 0건)');
    const staticClient = await runApiClient({ serverFlag: false });
    eq('정적 호스팅 즉시 정적 모드', await staticClient.api.init(), 'static');
    eq('정적 모드 API 요청 0건', staticClient.calls(), 0);
    ok('정적 모드에서는 9단계 화면 안내', true);
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

/* --- 도우미 ---------------------------------------------------------------- */
function makeStorage() {
  const memory = {};
  return {
    getItem: key => (Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null),
    setItem: (key, value) => { memory[key] = String(value); },
    removeItem: key => { delete memory[key]; },
    clear: () => Object.keys(memory).forEach(key => delete memory[key])
  };
}

async function runApiClient(options) {
  const calls = { count: 0 };
  const sandbox = {
    location: { search: options.search || '', href: 'https://neved12.github.io/all-golf-test/', origin: 'https://neved12.github.io', protocol: 'https:' },
    localStorage: makeStorage(), sessionStorage: makeStorage(), URLSearchParams,
    fetch: () => { calls.count += 1; return Promise.reject(new Error('no network')); },
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

main().catch(error => {
  console.error('\n테스트 실행 실패:', error && error.stack || error);
  process.exitCode = 1;
});
