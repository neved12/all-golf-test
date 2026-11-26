#!/usr/bin/env node
/* ALL:GOLF 8단계 예약 엔진 시나리오 테스트
   사용법: node tests/run-stage8-scenarios.js   (= npm run test:stage8)
   - 실제 server/index.js 를 임시 DB 로 띄워 임시확보(Hold)·예약·동시성·멱등성·취소/환불·
     파트너/본사 권한·재시작 유지·DB 마이그레이션·정적 모드 폴백을 검사한다.
   - 브라우저 없이 고객 앱 코드(dom-shim)와 예약 클라이언트 모듈을 실행해 화면 계산도 검증한다. */
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
/* dom-shim 이 프로세스의 setTimeout 을 바꾸므로 실제 타이머는 미리 잡아 둔다. */
const realSetTimeout = setTimeout;

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
const tomorrow = kstDate(1);
const day2 = kstDate(2);
const day7 = kstDate(7);
const day8 = kstDate(8);

const newApplication = (name, email) => ({
  courseMode: 'new', courseName: name, region: '경기', city: '이천',
  holes: '18', operationType: 'public', coursePhone: '031-555-0000', address: '경기 이천시 스테이지8로 8',
  website: 'https://stage8.example.com',
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allgolf-stage8-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const password = `stage8-${Math.random().toString(36).slice(2, 10)}`;
  const env = {
    PORT: String(port),
    ALLGOLF_DB_PATH: dbPath,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: 'stage8-test-secret-0123456789abcdef',
    ALLGOLF_HOLD_TTL_SECONDS: '3',
    ALLGOLF_HOLD_SWEEP_SECONDS: '1'
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
  let tees = {};
  let firstReservation = null;

  async function createTee(token, date, time, capacityTeams, greenFee = 160000, session = null) {
    const hour = Number(time.slice(0, 2));
    const body = { date, time, session: session || (hour < 10 ? '1부' : hour < 14 ? '2부' : '3부'), course: '전체', capacityTeams, maxPlayers: 4, greenFee, status: 'open' };
    const response = await call('POST', '/api/partner/tee-times', { token, body });
    return response.data && response.data.teeTime;
  }

  try {
    /* 1. 서버 기동 --------------------------------------------------------- */
    section('8단계 · 서버 기동과 상태');
    server = await startServer(env);
    const health = await waitForHealth(base);
    ok('서버 기동 · /api/health 200', health && health.ok === true);
    /* 9단계에서 health.stage 가 9 로 올라가도 8단계 예약 기능이 그대로 있음을 확인한다. */
    ok('8단계 서버 표시(9단계 이상)', Number(health.stage) >= 8, health.stage);
    ok('예약·Hold·멱등·환불 기능 표시', health.features && health.features.reservations === true
      && health.features.holds === true && health.features.idempotency === true && health.features.refunds === true);
    eq('재고 연동 표시', health.features.inventoryLinked, true);
    ok('Hold TTL 공개', health.hold && Number(health.hold.ttlSec) === 3, JSON.stringify(health.hold));
    /* 9단계에서 스키마가 v4 로 올라갔으므로 3 이상인지 확인한다. */
    ok('DB 스키마 3 이상(9단계 v4)', Number(health.db.schemaVersion) >= 3, health.db.schemaVersion);
    eq('초기 예약 0·Hold 0', `${health.db.reservations}/${health.db.activeHolds}`, '0/0');

    const home = await call('GET', '/');
    ok('고객 앱에 예약 클라이언트 포함', home.text.includes('data/server-reservations.js'));
    ok('정적 자산 최신 캐시 버전', /v=20261126-(stage9b|national)/.test(home.text), 'v=20261126-national');

    /* 2. 준비: 골프장 A/B 승인·계정·티타임 -------------------------------- */
    section('8단계 · 준비: 골프장 A/B 승인과 티타임');
    const login = await call('POST', '/api/admin/login', { body: { password } });
    adminToken = login.data && login.data.token;
    ok('본사 로그인', Boolean(adminToken));
    const appA = await call('POST', '/api/partner-applications', { body: newApplication('스테이지8 알파 CC', 's8a@example.com') });
    const appB = await call('POST', '/api/partner-applications', { body: newApplication('스테이지8 베타 CC', 's8b@example.com') });
    const approveA = await call('POST', `/api/admin/partner-applications/${appA.data.application.id}/approve`, { token: adminToken, body: {} });
    const approveB = await call('POST', `/api/admin/partner-applications/${appB.data.application.id}/approve`, { token: adminToken, body: {} });
    courseA = approveA.data.application.newCourseId;
    courseB = approveB.data.application.newCourseId;
    eq('A/B 승인', `${approveA.status}/${approveB.status}`, '200/200');
    const accountA = await call('POST', '/api/admin/partner-accounts', { token: adminToken, body: { courseId: courseA, email: 'owner8a@example.com', name: '알파 대표', role: 'owner', password: 'Stage8Pass1' } });
    const accountB = await call('POST', '/api/admin/partner-accounts', { token: adminToken, body: { courseId: courseB, email: 'owner8b@example.com', name: '베타 대표', role: 'owner', password: 'Stage8Pass2' } });
    eq('A/B 계정 발급', `${accountA.status}/${accountB.status}`, '201/201');
    const loginA = await call('POST', '/api/partner/login', { body: { email: 'owner8a@example.com', password: 'Stage8Pass1' } });
    const loginB = await call('POST', '/api/partner/login', { body: { email: 'owner8b@example.com', password: 'Stage8Pass2' } });
    tokenA = loginA.data.token;
    tokenB = loginB.data.token;
    ok('A/B 담당자 로그인', Boolean(tokenA && tokenB));

    tees.main = await createTee(tokenA, tomorrow, '07:30', 3);
    tees.one = await createTee(tokenA, tomorrow, '08:30', 1);
    tees.big = await createTee(tokenA, day7, '07:30', 5);
    tees.day2 = await createTee(tokenA, day2, '09:00', 4);
    tees.extra = await createTee(tokenA, day8, '10:00', 2);
    tees.b = await createTee(tokenB, tomorrow, '07:30', 2);
    ok('티타임 6개 등록', Boolean(tees.main && tees.one && tees.big && tees.day2 && tees.extra && tees.b));
    eq('A 티타임 초기 잔여', tees.main.remaining, 3);

    const rates = await call('PUT', '/api/partner/rates', {
      token: tokenA,
      body: {
        baseGreenFee: 160000, threePlayerGreenFee: 180000, fourPlayerGreenFee: 150000,
        threePlayerSurcharge: 10000, twoPlayerSurcharge: 5000, cartFee: 110000, caddieFee: 150000,
        depositType: 'person', depositValue: 30000, version: 0,
        cancellationPolicy: { sevenPlus: 100, fourToSix: 80, twoToThree: 60, oneDay: 20, sameDay: 0, cutoffHoursBefore: null }
      }
    });
    eq('취소·환불 정책 저장', rates.status, 200);
    eq('정책 값 반영', rates.data.rates.cancellationPolicy.twoToThree, 60);
    const badPolicy = await call('PUT', '/api/partner/rates', {
      token: tokenA,
      body: { baseGreenFee: 160000, version: rates.data.rates.version, cancellationPolicy: { sevenPlus: 120 } }
    });
    eq('환불률 120% 400', badPolicy.status, 400);
    ok('환불률 오류 필드 안내', badPolicy.data.error.details.errors.cancellationPolicy.includes('0~100'));

    /* 3. 공개 카탈로그의 실시간 재고 --------------------------------------- */
    section('8단계 · 공개 카탈로그 재고');
    const catalog = await call('GET', `/api/public/catalog?date=${tomorrow}&courseId=${encodeURIComponent(courseA)}`);
    eq('공개 카탈로그 200', catalog.status, 200);
    eq('재고 연동 true', catalog.data.inventoryLinked, true);
    ok('재고 안내 문구에 서버 기준 명시', String(catalog.data.inventoryNote).includes('서버 예약'));
    const mainTee = catalog.data.courses[0].teeTimes.find(item => item.id === tees.main.id);
    eq('카탈로그 잔여 3', mainTee.remaining, 3);
    eq('카탈로그 예약/임시확보 0', `${mainTee.booked}/${mainTee.held}`, '0/0');
    eq('카탈로그 취소 정책 전달', catalog.data.courses[0].cancellationPolicy.twoToThree, 60);

    /* 4. Hold 생성·재사용·한도·충돌 --------------------------------------- */
    section('8단계 · 임시확보(Hold) TTL·재사용·차단');
    const holdA1 = await call('POST', '/api/public/holds', { body: { courseId: courseA, date: tomorrow, teeTimeId: tees.main.id, people: 4, sessionId: 'sess-a1' } });
    eq('Hold 생성 201', holdA1.status, 201);
    ok('Hold 만료 시각 제공', Boolean(holdA1.data.hold && holdA1.data.hold.expiresAt));
    eq('Hold 후 잔여 2', holdA1.data.tee.remaining, 2);
    const holdA1Again = await call('POST', '/api/public/holds', { body: { courseId: courseA, date: tomorrow, teeTimeId: tees.main.id, people: 4, sessionId: 'sess-a1' } });
    eq('같은 세션 재요청은 기존 Hold 재사용', `${holdA1Again.status}/${holdA1Again.data.reused}`, '200/true');
    eq('재사용 시 Hold id 동일', holdA1Again.data.hold.id, holdA1.data.hold.id);
    const holdB = await call('POST', '/api/public/holds', { body: { courseId: courseA, date: tomorrow, teeTimeId: tees.main.id, people: 4, sessionId: 'sess-b1' } });
    eq('다른 세션 Hold 추가 가능(잔여 3)', holdB.data.tee.remaining, 1);
    const holdOne1 = await call('POST', '/api/public/holds', { body: { courseId: courseA, date: tomorrow, teeTimeId: tees.one.id, people: 4, sessionId: 'sess-one' } });
    eq('1팀 티타임 Hold 성공', holdOne1.status, 201);
    const holdOne2 = await call('POST', '/api/public/holds', { body: { courseId: courseA, date: tomorrow, teeTimeId: tees.one.id, people: 4, sessionId: 'sess-one2' } });
    eq('마지막 1팀은 다른 세션 Hold 409', holdOne2.status, 409);
    eq('Hold 차단 코드', holdOne2.data.error.code, 'sold_out');
    const badHold = await call('POST', '/api/public/holds', { body: { courseId: courseA, date: tomorrow, teeTimeId: tees.main.id, people: 5, sessionId: 'sess-x' } });
    eq('인원 초과 Hold 400', badHold.status, 400);
    const sessionMissing = await call('POST', '/api/public/holds', { body: { courseId: courseA, date: tomorrow, teeTimeId: tees.main.id } });
    eq('세션 없는 Hold 400', sessionMissing.status, 400);
    const limit1 = await call('POST', '/api/public/holds', { body: { courseId: courseA, date: tomorrow, teeTimeId: tees.main.id, people: 4, sessionId: 'sess-limit' } });
    const limit2 = await call('POST', '/api/public/holds', { body: { courseId: courseA, date: day2, teeTimeId: tees.day2.id, people: 4, sessionId: 'sess-limit' } });
    const limit3 = await call('POST', '/api/public/holds', { body: { courseId: courseA, date: day7, teeTimeId: tees.big.id, people: 4, sessionId: 'sess-limit' } });
    eq('세션 Hold 3건까지 허용', `${limit1.status}/${limit2.status}/${limit3.status}`, '201/201/201');
    const holdLimit = await call('POST', '/api/public/holds', { body: { courseId: courseA, date: day8, teeTimeId: tees.extra.id, people: 4, sessionId: 'sess-limit' } });
    eq('Hold 한도(세션당 3건) 초과 400', holdLimit.status, 400);
    eq('Hold 한도 코드', holdLimit.data.error.code, 'hold_limit');

    const remainingBeforeRelease = (await call('GET', `/api/public/inventory?date=${tomorrow}&courseId=${encodeURIComponent(courseA)}`)).data.courses[0].teeTimes.find(item => item.id === tees.main.id).remaining;
    eq('Hold 3건(세션 A·B·한도)으로 잔여 0', remainingBeforeRelease, 0);
    const releaseA1 = await call('DELETE', `/api/public/holds/${encodeURIComponent(holdA1.data.hold.id)}?sessionId=sess-a1`);
    eq('Hold 해제 200', releaseA1.status, 200);
    const invAfterRelease = await call('GET', `/api/public/inventory?date=${tomorrow}&courseId=${encodeURIComponent(courseA)}`);
    const invMain = invAfterRelease.data.courses[0].teeTimes.find(item => item.id === tees.main.id);
    eq('Hold 해제 후 잔여 1팀 복구', invMain.remaining, remainingBeforeRelease + 1);
    const wrongSession = await call('DELETE', `/api/public/holds/${encodeURIComponent(holdB.data.hold.id)}?sessionId=other-session`);
    eq('다른 세션 Hold 해제 403', wrongSession.status, 403);

    /* 5. Hold 만료 → 재고 자동 복구 ---------------------------------------- */
    section('8단계 · Hold 만료와 재고 자동 복구');
    /* Hold TTL 3초 → 만료까지 기다린 뒤 잔여가 복구되는지 확인한다. */
    await sleep(3300);
    const invExpired = await call('GET', `/api/public/inventory?date=${tomorrow}&courseId=${encodeURIComponent(courseA)}`);
    const invExpiredMain = invExpired.data.courses[0].teeTimes.find(item => item.id === tees.main.id);
    eq('만료된 Hold 는 잔여에서 제외(복구)', invExpiredMain.remaining, 3);
    const staleReserve = await call('POST', '/api/public/reservations', { body: booking(courseA, tomorrow, tees.main.id, { holdId: holdB.data.hold.id, sessionId: 'sess-b1' }) });
    eq('만료 Hold 로 확정 409', staleReserve.status, 409);
    eq('만료 Hold 코드', staleReserve.data.error.code, 'hold_expired');
    /* 주기 정리(1초)가 만료 Hold 를 expired 로 남길 때까지 잠시 기다린다. */
    await sleep(1500);
    const dbAfterExpire = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const expiredHolds = (dbAfterExpire.bookingHolds || []).filter(item => item.status === 'expired');
    ok('만료 Hold 상태 기록(expired)', expiredHolds.length >= 2, JSON.stringify((dbAfterExpire.bookingHolds || []).map(item => item.status)));

    /* 6. 예약 확정(원자적 재고 차감) --------------------------------------- */
    section('8단계 · 예약 확정과 재고 차감');
    const res1 = await call('POST', '/api/public/reservations', {
      body: booking(courseA, tomorrow, tees.main.id, { sessionId: 'sess-r1', booker: '김골퍼', phone: '010-1111-2222' })
    });
    eq('예약 확정 201', res1.status, 201);
    firstReservation = res1.data.reservation;
    ok('예약번호 형식 AG-YYMMDD-NNNNN', /^AG-\d{6}-\d{5}$/.test(firstReservation.number), firstReservation.number);
    eq('예약 상태 confirmed', firstReservation.status, 'confirmed');
    eq('예약 단가(4인 150,000)', firstReservation.appliedGreenFee, 150000);
    eq('예약 총액(4인 600,000 + 카트·캐디 260,000)', firstReservation.totalEstimated, 860000);
    eq('예약금(1인 30,000 × 4)', firstReservation.paidDeposit, 120000);
    eq('예약 후 잔여 2', res1.data.inventory.remaining, 2);
    eq('예약 응답 본인 확인 표시', `${firstReservation.phoneVerified}/${firstReservation.phone}`, `true/01011112222`);
    ok('예약 응답에 내부 필드 없음', !res1.text.includes('idempotencyHash') && !res1.text.includes('sessionId'));

    const invalidPeople = await call('POST', '/api/public/reservations', { body: booking(courseA, tomorrow, tees.main.id, { people: 5 }) });
    eq('인원 초과 400', invalidPeople.status, 400);
    ok('인원 오류 필드', invalidPeople.data.error.details.errors.people.includes('2~4'));
    const invalidPhone = await call('POST', '/api/public/reservations', { body: booking(courseA, tomorrow, tees.main.id, { phone: '02-123-4567' }) });
    eq('휴대전화 형식 오류 400', invalidPhone.status, 400);
    const invalidBooker = await call('POST', '/api/public/reservations', { body: booking(courseA, tomorrow, tees.main.id, { booker: '   ' }) });
    eq('예약자 이름 누락 400', invalidBooker.status, 400);
    const mismatch = await call('POST', '/api/public/reservations', { body: booking(courseB, tomorrow, tees.main.id) });
    eq('다른 골프장 티타임 예약 400', mismatch.status, 400);
    const notFound = await call('POST', '/api/public/reservations', { body: booking(courseA, tomorrow, 'tt-없는-티타임') });
    eq('없는 티타임 404', notFound.status, 404);

    /* 7. 동시 예약: 마지막 1팀 --------------------------------------------- */
    section('8단계 · 동시 예약(Overbooking) 409 방어');
    const oneSessions = ['c-one-1', 'c-one-2', 'c-one-3'];
    const parallel = await Promise.all(oneSessions.map((sessionId, index) => call('POST', '/api/public/reservations', {
      body: booking(courseA, tomorrow, tees.one.id, { sessionId, booker: `동시${index + 1}`, phone: `010-9000-000${index + 1}` })
    })));
    const successCount = parallel.filter(item => item.status === 201).length;
    const conflictCount = parallel.filter(item => item.status === 409).length;
    eq('1팀 티타임 동시 3건 중 성공 1건', successCount, 1);
    eq('나머지 2건 409', conflictCount, 2);
    ok('409 응답 코드 sold_out', parallel.filter(item => item.status === 409).every(item => item.data.error.code === 'sold_out'));
    const invOne = await call('GET', `/api/public/inventory?date=${tomorrow}&courseId=${encodeURIComponent(courseA)}`);
    eq('1팀 티타임 잔여 0', invOne.data.courses[0].teeTimes.find(item => item.id === tees.one.id).remaining, 0);

    /* 8. 멱등 키 ------------------------------------------------------------ */
    section('8단계 · 멱등 키(중복 클릭·재전송)');
    const key = `idem-${Date.now()}`;
    const first = await call('POST', '/api/public/reservations', {
      headers: { 'Idempotency-Key': key },
      body: booking(courseA, day7, tees.big.id, { sessionId: 'sess-idem', booker: '멱등고객', phone: '010-2222-3333' })
    });
    const second = await call('POST', '/api/public/reservations', {
      headers: { 'Idempotency-Key': key },
      body: booking(courseA, day7, tees.big.id, { sessionId: 'sess-idem', booker: '멱등고객', phone: '010-2222-3333' })
    });
    eq('첫 요청 201', first.status, 201);
    eq('재전송 200 + idempotent', `${second.status}/${second.data.idempotent}`, '200/true');
    eq('동일 예약번호 반환', second.data.reservation.number, first.data.reservation.number);
    eq('이중 차감 없음(잔여 4)', second.data.inventory.remaining, 4);
    const myList = await call('GET', '/api/public/reservations?phone=010-2222-3333');
    eq('연락처 기준 내 예약 1건', myList.data.count, 1);

    /* 9. 예약 조회 ---------------------------------------------------------- */
    section('8단계 · 예약 조회(번호+연락처)');
    const detail = await call('GET', `/api/public/reservations/${encodeURIComponent(firstReservation.number)}?phone=010-1111-2222`);
    eq('예약 상세 200', detail.status, 200);
    eq('상세 예약번호 일치', detail.data.reservation.number, firstReservation.number);
    ok('본인 확인 시 연락처 전체 표시', !detail.data.reservation.phone.includes('****'), detail.data.reservation.phone);
    eq('취소 예상 환불률(내일 1일 전 20%)', detail.data.cancellationQuote.refundRate, 20);
    eq('취소 예상 환불금(120,000 × 20%)', detail.data.cancellationQuote.refundAmount, 24000);
    eq('취소 가능(기한 제한 없음)', detail.data.cancellationQuote.canCancel, true);
    const wrongPhone = await call('GET', `/api/public/reservations/${encodeURIComponent(firstReservation.number)}?phone=010-9999-9999`);
    eq('다른 연락처 조회 403', wrongPhone.status, 403);
    const unknown = await call('GET', `/api/public/reservations/AG-000000-00000?phone=010-1111-2222`);
    eq('없는 예약 404', unknown.status, 404);
    const noPhone = await call('GET', `/api/public/reservations/${encodeURIComponent(firstReservation.number)}`);
    eq('연락처 없이 조회 400', noPhone.status, 400);

    /* 10. 취소·환불 -------------------------------------------------------- */
    section('8단계 · 취소·환불 상태 전이와 재고 복구');
    const cancelOne = await call('POST', `/api/public/reservations/${encodeURIComponent(firstReservation.number)}/cancel`, { body: { phone: '010-1111-2222', reason: '일정 변경' } });
    eq('취소 200', cancelOne.status, 200);
    eq('상태 cancelled', cancelOne.data.reservation.status, 'cancelled');
    eq('환불 상태 demo_refunded', cancelOne.data.reservation.refundStatus, 'demo_refunded');
    eq('취소수수료 = 예약금 − 환불액', cancelOne.data.refund.cancellationFee, 96000);
    eq('환불액 24,000', cancelOne.data.refund.refundAmount, 24000);
    const afterCancel = await call('GET', `/api/public/inventory?date=${tomorrow}&courseId=${encodeURIComponent(courseA)}`);
    eq('취소 후 잔여 복구(3)', afterCancel.data.courses[0].teeTimes.find(item => item.id === tees.main.id).remaining, 3);
    const cancelAgain = await call('POST', `/api/public/reservations/${encodeURIComponent(firstReservation.number)}/cancel`, { body: { phone: '010-1111-2222' } });
    eq('같은 예약 재취소 200 alreadyCancelled', `${cancelAgain.status}/${cancelAgain.data.alreadyCancelled}`, '200/true');
    const cancelWrongPhone = await call('POST', `/api/public/reservations/${encodeURIComponent(second.data.reservation.number)}/cancel`, { body: { phone: '010-0000-0000' } });
    eq('다른 연락처 취소 403', cancelWrongPhone.status, 403);

    const res2 = await call('POST', '/api/public/reservations', { body: booking(courseA, day2, tees.day2.id, { sessionId: 'sess-r2', booker: '이틀고객', phone: '010-3333-4444' }) });
    eq('2일 뒤 예약 201', res2.status, 201);
    eq('2~3일 전 환불률 60%', (await call('GET', `/api/public/reservations/${encodeURIComponent(res2.data.reservation.number)}?phone=010-3333-4444`)).data.cancellationQuote.refundRate, 60);
    const cancel2 = await call('POST', `/api/public/reservations/${encodeURIComponent(res2.data.reservation.number)}/cancel`, { body: { phone: '010-3333-4444' } });
    eq('2일 뒤 취소 환불 72,000', cancel2.data.refund.refundAmount, 72000);

    /* 취소 가능 기한(티오프 48시간 전)이 지나면 고객 취소 409, 담당자는 강제 취소 가능 */
    const deadlineRes = await call('POST', '/api/public/reservations', { body: booking(courseA, day2, tees.day2.id, { sessionId: 'sess-deadline', booker: '기한고객', phone: '010-6666-7777' }) });
    eq('기한 테스트 예약 생성', deadlineRes.status, 201);
    const policyUpdate = await call('PUT', '/api/partner/rates', {
      token: tokenA,
      body: { baseGreenFee: 160000, version: rates.data.rates.version, cancellationPolicy: { sevenPlus: 100, fourToSix: 80, twoToThree: 60, oneDay: 20, sameDay: 0, cutoffHoursBefore: 48 } }
    });
    eq('취소 기한 48시간 저장', policyUpdate.data.rates.cancellationPolicy.cutoffHoursBefore, 48);
    const deadlineQuote = await call('GET', `/api/public/reservations/${encodeURIComponent(deadlineRes.data.reservation.number)}?phone=010-6666-7777`);
    eq('기한 지난 예약 canCancel false', deadlineQuote.data.cancellationQuote.canCancel, false);
    const deadlineCancel = await call('POST', `/api/public/reservations/${encodeURIComponent(deadlineRes.data.reservation.number)}/cancel`, { body: { phone: '010-6666-7777' } });
    eq('기한 지난 고객 취소 409', deadlineCancel.status, 409);
    eq('기한 초과 코드', deadlineCancel.data.error.code, 'cancel_deadline_passed');
    const partnerForce = await call('POST', `/api/partner/reservations/${encodeURIComponent(deadlineRes.data.reservation.id)}/status`, { token: tokenA, body: { status: 'cancelled', reason: '골프장 판단' } });
    eq('담당자는 기한과 무관하게 취소 200', partnerForce.status, 200);
    eq('담당자 취소도 환불 계산 기록', partnerForce.data.refund.refundRate, 60);

    const resNoHold = await call('POST', '/api/public/reservations', { body: booking(courseA, day7, tees.big.id, { sessionId: 'sess-nohold', booker: '즉시고객', phone: '010-4444-5555' }) });
    eq('Hold 없이 즉석 예약 201', resNoHold.status, 201);

    /* 11. 골프장 담당자 콘솔 ----------------------------------------------- */
    section('8단계 · 골프장 담당자 예약 관리·격리');
    const partnerList = await call('GET', `/api/partner/reservations`, { token: tokenA });
    ok('A 예약 목록 조회', partnerList.status === 200 && partnerList.data.count >= 3, JSON.stringify(partnerList.data));
    eq('A 목록에 담당자용 전체 연락처', partnerList.data.reservations.some(item => item.phone === '01022223333'), true);
    ok('A 목록에 예약 통계', partnerList.data.stats && partnerList.data.stats.total >= 3, JSON.stringify(partnerList.data.stats));
    const partnerListB = await call('GET', '/api/partner/reservations', { token: tokenB });
    eq('B 골프장 예약 0건(격리)', partnerListB.data.count, 0);
    const crossCourse = await call('GET', `/api/partner/reservations?courseId=${encodeURIComponent(courseA)}`, { token: tokenB });
    eq('B가 A courseId 로 조회 403', crossCourse.status, 403);
    const crossDetail = await call('GET', `/api/partner/reservations/${encodeURIComponent(resNoHold.data.reservation.id)}`, { token: tokenB });
    eq('B가 A 예약 상세 403', crossDetail.status, 403);
    const crossStatus = await call('POST', `/api/partner/reservations/${encodeURIComponent(resNoHold.data.reservation.id)}/status`, { token: tokenB, body: { status: 'completed' } });
    eq('B가 A 예약 상태 변경 403', crossStatus.status, 403);

    const complete = await call('POST', `/api/partner/reservations/${encodeURIComponent(resNoHold.data.reservation.id)}/status`, { token: tokenA, body: { status: 'completed', reason: '라운드 종료' } });
    eq('담당자 이용 완료 처리 200', complete.status, 200);
    eq('상태 completed', complete.data.reservation.status, 'completed');
    eq('이용 완료 처리 후에도 잔여 유지(3)', complete.data.reservation && (await call('GET', `/api/public/inventory?date=${day7}&courseId=${encodeURIComponent(courseA)}`)).data.courses[0].teeTimes.find(item => item.id === tees.big.id).remaining, 3);
    const noShowTarget = await call('POST', '/api/public/reservations', { body: booking(courseA, day8, tees.extra.id, { sessionId: 'sess-ns', booker: '노쇼고객', phone: '010-5555-6666' }) });
    const noShow = await call('POST', `/api/partner/reservations/${encodeURIComponent(noShowTarget.data.reservation.id)}/status`, { token: tokenA, body: { status: 'no_show' } });
    eq('노쇼 처리 200', noShow.data.reservation.status, 'no_show');
    const badStatus = await call('POST', `/api/partner/reservations/${encodeURIComponent(noShowTarget.data.reservation.id)}/status`, { token: tokenA, body: { status: 'cancelled', reason: '고객 요청' } });
    eq('담당자 취소(기한 지나도 가능) 200', badStatus.status, 200);
    eq('담당자 취소 상태', badStatus.data.reservation.status, 'cancelled');
    const invalidStatus = await call('POST', `/api/partner/reservations/${encodeURIComponent(noShowTarget.data.reservation.id)}/status`, { token: tokenA, body: { status: 'confirmed' } });
    eq('취소된 예약 상태 변경 409', invalidStatus.status, 409);

    const dash = await call('GET', '/api/partner/dashboard', { token: tokenA });
    eq('대시보드 예약 서버 연동 표시', dash.data.reservations.linked, true);
    eq('대시보드 예약 source', dash.data.reservations.source, 'server');
    ok('대시보드 취소·환불 집계', dash.data.reservations.cancelled >= 2 && dash.data.reservations.refundAmount >= 96000, JSON.stringify(dash.data.reservations));

    /* 12. 본사 관리자 ------------------------------------------------------- */
    section('8단계 · 본사 관리자 전체 예약·취소');
    const adminList = await call('GET', '/api/admin/reservations', { token: adminToken });
    ok('본사 전체 예약 조회', adminList.status === 200 && adminList.data.count >= 5, adminList.data.count);
    ok('본사 통계(총·확정·취소)', adminList.data.stats.total >= 5 && adminList.data.stats.cancelled >= 3, JSON.stringify(adminList.data.stats));
    const adminFiltered = await call('GET', `/api/admin/reservations?status=cancelled&courseId=${encodeURIComponent(courseA)}`, { token: adminToken });
    eq('상태·골프장 필터', adminFiltered.data.reservations.every(item => item.status === 'cancelled' && item.courseId === courseA), true);
    const adminNoAuth = await call('GET', '/api/admin/reservations');
    eq('본사 예약 조회 인증 401', adminNoAuth.status, 401);
    const adminDetail = await call('GET', `/api/admin/reservations/${encodeURIComponent(noShowTarget.data.reservation.id)}`, { token: adminToken });
    eq('본사 예약 상세 200', adminDetail.status, 200);
    const noReason = await call('POST', `/api/admin/reservations/${encodeURIComponent(resNoHold.data.reservation.id)}/status`, { token: adminToken, body: { status: 'cancelled' } });
    eq('본사 취소 사유 누락 400', noReason.status, 400);
    const adminCancel = await call('POST', `/api/admin/reservations/${encodeURIComponent(resNoHold.data.reservation.id)}/status`, { token: adminToken, body: { status: 'cancelled', reason: '본사 강제 취소' } });
    eq('본사 취소 200', adminCancel.status, 200);
    eq('본사 취소 사유 기록', adminCancel.data.reservation.cancelReason, '본사 강제 취소');
    ok('본사 취소 시 환불 계산', adminCancel.data.refund && adminCancel.data.refund.refundRate === 100, JSON.stringify(adminCancel.data.refund));
    const logs = await call('GET', '/api/admin/audit-logs?limit=200', { token: adminToken });
    const actions = (logs.data.logs || []).map(item => item.action);
    ok('감사 로그에 예약 확정 기록', actions.includes('reservation.created'));
    ok('감사 로그에 예약 취소 기록', actions.includes('reservation.cancelled'));
    ok('감사 로그에 예약 상태 변경 기록', actions.includes('reservation.status-updated'));
    const cancelLog = (logs.data.logs || []).find(item => item.action === 'reservation.cancelled' && item.actor && item.actor.type === 'customer');
    ok('고객 취소 로그에 예약번호·수수료', Boolean(cancelLog && cancelLog.reservationNumber && String(cancelLog.memo).includes('환불')), JSON.stringify(cancelLog));
    const stats = await call('GET', '/api/admin/stats', { token: adminToken });
    ok('본사 통계에 예약 포함', stats.data.stats.reservations >= 5 && stats.data.stats.confirmedReservations >= 1, JSON.stringify(stats.data.stats));
    const operations = await call('GET', `/api/admin/operations?date=${tomorrow}`, { token: adminToken });
    const opsA = (operations.data.courses || []).find(item => item.courseId === courseA);
    ok('운영 현황에 골프장별 예약 집계', Boolean(opsA && opsA.reservations && opsA.reservations.total >= 2), JSON.stringify(opsA && opsA.reservations));

    /* 12-1. SSE 실시간 알림 -------------------------------------------------- */
    section('8단계 · SSE 실시간 재고 알림');
    const sse = await openSse(`${base}/api/events`);
    await sleep(200);
    ok('SSE 연결 hello 수신', sse.buffer().includes('hello'), sse.buffer().slice(0, 120));
    const sseReservation = await call('POST', '/api/public/reservations', { body: booking(courseA, day8, tees.extra.id, { sessionId: 'sess-sse', booker: 'SSE고객', phone: '010-8888-7777' }) });
    eq('SSE 테스트 예약 생성', sseReservation.status, 201);
    await sleep(500);
    ok('SSE inventory.changed 수신', sse.buffer().includes('inventory.changed'), sse.buffer().slice(-300));
    ok('SSE reservations.changed 수신', sse.buffer().includes('reservations.changed'), sse.buffer().slice(-300));
    ok('SSE 이벤트에 예약번호 포함', sse.buffer().includes(sseReservation.data.reservation.number), sse.buffer().slice(-300));
    sse.close();

    /* 13. DB 버전 3 과 정적 모드 ------------------------------------------- */
    section('8단계 · DB 스키마와 정적 모드 폴백');
    const rawDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    ok('DB 버전 3 이상', Number(rawDb.version) >= 3, rawDb.version);
    ok('예약·Hold 컬렉션 저장', Array.isArray(rawDb.reservations) && rawDb.reservations.length >= 5 && Array.isArray(rawDb.bookingHolds));
    ok('DB 에 평문 개인정보 노출 최소화(세션 해시 없음)', !JSON.stringify(rawDb.reservations).includes('idempotencyKey'));
    ok('예약 번호 순번 보존', Object.keys(rawDb.meta.sequences || {}).some(k => k.startsWith('rsv:')));

    const staticClient = await runApiClient({ serverFlag: false });
    eq('정적 호스팅 즉시 정적 모드', await staticClient.api.init(), 'static');
    eq('정적 모드 API 요청 0건', staticClient.calls(), 0);
    const staticReservations = await runServerReservations({ mode: 'static' });
    eq('정적 모드 예약 모듈 linked=false', staticReservations.linked(), false);
    const staticConfirm = await staticReservations.confirm({ courseId: courseA, date: tomorrow, teeTimeId: tees.main.id, people: 4, booker: '정적', phone: '010-1111-2222' });
    eq('정적 모드 확정 시도 차단', staticConfirm.ok, false);
    eq('정적 모드 예약 요청 0건', staticReservations.calls(), 0);

    /* 14. 서버 재시작 후 유지 ---------------------------------------------- */
    section('8단계 · 서버 재시작 후 예약·재고 유지');
    const beforeRestart = await call('GET', `/api/public/inventory?date=${tomorrow}&courseId=${encodeURIComponent(courseA)}`);
    const beforeMain = beforeRestart.data.courses[0].teeTimes.find(item => item.id === tees.main.id).remaining;
    await stopServer(server);
    server = await startServer(env);
    await waitForHealth(base);
    const afterRestart = await call('GET', `/api/public/inventory?date=${tomorrow}&courseId=${encodeURIComponent(courseA)}`);
    const afterMain = afterRestart.data.courses[0].teeTimes.find(item => item.id === tees.main.id).remaining;
    eq('재시작 후 잔여 유지', afterMain, beforeMain);
    const restartLogin = await call('POST', '/api/partner/login', { body: { email: 'owner8a@example.com', password: 'Stage8Pass1' } });
    tokenA = restartLogin.data.token;
    const restartList = await call('GET', '/api/partner/reservations', { token: tokenA });
    ok('재시작 후 예약 목록 유지', restartList.data.count >= 3, restartList.data.count);
    const restartDetail = await call('GET', `/api/public/reservations/${encodeURIComponent(second.data.reservation.number)}?phone=010-2222-3333`);
    eq('재시작 후 예약 조회 유지', restartDetail.status, 200);
    const restartHold = await call('POST', '/api/public/holds', { body: { courseId: courseA, date: tomorrow, teeTimeId: tees.main.id, people: 4, sessionId: 'sess-restart' } });
    eq('재시작 후 Hold 정상 동작', restartHold.status, 201);

    /* 15. DB v2 → v3 자동 호환 --------------------------------------------- */
    section('8단계 · 기존 DB(v2) 자동 호환');
    await stopServer(server);
    const legacy = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    legacy.version = 2;
    delete legacy.reservations;
    delete legacy.bookingHolds;
    fs.writeFileSync(dbPath, `${JSON.stringify(legacy, null, 2)}\n`);
    server = await startServer(env);
    const legacyHealth = await waitForHealth(base);
    ok('v2 DB 를 v4 로 승격(3 이상)', Number(legacyHealth.db.schemaVersion) >= 3, legacyHealth.db.schemaVersion);
    ok('v2 데이터(골프장·티타임) 유지', legacyHealth.db.approvedCourses >= 2 && legacyHealth.db.teeTimes >= 6, JSON.stringify(legacyHealth.db));
    eq('v2 DB 에 예약 컬렉션 자동 생성', legacyHealth.db.reservations, 0);
    const legacyLogin = await call('POST', '/api/partner/login', { body: { email: 'owner8a@example.com', password: 'Stage8Pass1' } });
    const legacyTees = await call('GET', `/api/partner/tee-times?date=${tomorrow}`, { token: legacyLogin.data.token });
    eq('v2 데이터 담당자 조회 유지', legacyTees.data.count, 2);

    /* 16. 화면 계산(고객 앱 코드) ------------------------------------------ */
    section('8단계 · 고객 앱 재고 계산');
    const publicResponse = await call('GET', '/api/partner-courses');
    const publicCourses = publicResponse.data.courses || [];
    ok('앱 테스트용 공개 골프장 확보', publicCourses.some(item => String(item.id) === String(courseA)), JSON.stringify(publicCourses.map(item => item.id).slice(0, 3)));
    const app = runAppWithServerInventory({
      courseId: courseA,
      coursesPayload: publicResponse.data,
      teeTimes: [
        { id: tees.main.id, courseId: courseA, date: tomorrow, time: '07:30', session: '1부', capacityTeams: 3, maxPlayers: 4, remaining: 2, booked: 1, held: 0, price: 150000, greenFee: 150000, regular: 150000, closed: false, serverManaged: true },
        { id: tees.one.id, courseId: courseA, date: tomorrow, time: '08:30', session: '1부', capacityTeams: 1, maxPlayers: 4, remaining: 0, booked: 1, held: 0, price: 150000, greenFee: 150000, regular: 150000, closed: true, serverManaged: true }
      ]
    });
    ok('앱이 서버 티타임 2건 표시', app.times.length === 2, app.times.length);
    eq('잔여는 서버 값 그대로(2)', app.times[0].remaining, 2);
    ok('마감 티타임 예약 불가 표시', app.times[1].closed === true && app.times[1].remaining === 0);
    eq('앱이 재고 연동 상태 인식', app.inventoryLinked, true);
    eq('로컬 시연 예약을 더해도 서버 잔여 유지', app.remainingAfterLocalReservation(), 2);
    /* 17. 고객 앱 예약 플로우(서버 Hold → 확정) ------------------------------ */
    section('8단계 · 고객 앱 예약 플로우(서버 연동)');
    const flow = await runAppBookingFlow({
      courseId: courseA,
      coursesPayload: publicResponse.data,
      date: kstDate(3),
      time: '07:30'
    });
    ok('앱이 Hold 를 서버에 요청', flow.paths.includes('/api/public/holds'), JSON.stringify(flow.paths));
    ok('앱이 예약 확정을 서버에 요청', flow.paths.includes('/api/public/reservations'));
    ok('확정 요청에 멱등 키 포함', flow.idempotencyHeader === 'true', flow.idempotencyHeader);
    ok('확정 요청 본문에 Hold id 포함', flow.holdIdSent === 'hold-flow-1', flow.holdIdSent);
    ok('응답 예약이 서버 예약으로 목록에 저장', flow.saved.some(item => item.number === 'AG-260128-00042' && item.source === 'server'), JSON.stringify(flow.saved).slice(0, 200));
    eq('예약 완료 화면으로 이동', flow.page, 'complete');
    eq('완료 화면에 서버 예약번호 표시', flow.text.includes('AG-260128-00042'), true);
    ok('기존 로컬 예약은 유지', flow.saved.some(item => item.number === 'AG-LOCAL-OLD'), JSON.stringify(flow.saved.map(item => item.number)));
    eq('예약 연락처가 기억됨', flow.savedPhone, '01012345678');
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


/* SSE 스트림을 열어 수신된 텍스트를 모은다(테스트용). */
function openSse(url) {
  return new Promise(resolve => {
    const request = http.get(url, response => {
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { buffer += chunk; });
      resolve({
        buffer: () => buffer,
        close: () => { try { request.destroy(); } catch { /* noop */ } }
      });
    });
    request.on('error', () => resolve({ buffer: () => '', close: () => {} }));
  });
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

/* 예약 클라이언트 모듈: 정적 모드에서는 요청 0건 / 서버 모드에서는 응답을 로컬 목록에 합친다. */
async function runServerReservations(options) {
  const calls = { count: 0 };
  const reservations = [];
  const sandbox = {
    location: { search: '', href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', protocol: 'http:' },
    localStorage: makeStorage(), sessionStorage: makeStorage(), URLSearchParams,
    setTimeout, clearTimeout,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    console
  };
  sandbox.window = sandbox;
  sandbox.window.dispatchEvent = () => {};
  sandbox.ALL_GOLF_API = {
    state: { mode: options.mode, health: options.mode === 'server' ? { stage: 8, features: { reservations: true } } : null },
    init: () => Promise.resolve(options.mode),
    request: () => { calls.count += 1; return Promise.resolve({ ok: false, status: 0, data: {}, error: { code: 'network' } }); },
    apiUrl: pathname => pathname,
    onModeChange: () => () => {}
  };
  sandbox.ALL_GOLF_STORE = {
    getReservations: () => reservations.slice(),
    setReservations: items => { reservations.length = 0; reservations.push(...items); return items; },
    calculateCancellation: () => ({ paidDeposit: 0, cancellationFee: 0, refundAmount: 0, canCancel: true })
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(rootDir, 'data/server-reservations.js'), 'utf8'), sandbox, { filename: 'data/server-reservations.js' });
  const module = sandbox.ALL_GOLF_SERVER_RESERVATIONS;
  return {
    linked: () => module.linked(),
    confirm: input => module.confirm(input),
    calls: () => calls.count,
    saved: () => reservations.slice()
  };
}

/* 실제 고객 앱 코드(app.js)로 서버 재고 계산만 확인한다. */
function runAppWithServerInventory(payload) {
  const preFiles = [
    'tests/dom-shim.js',
    'data/national-golf-courses.js',
    'data/golf-courses.js',
    'data/demo-teetimes.js',
    'data/partner-application.js',
    'data/shared-store.js',
    'data/partner-sync.js',
    'data/api-client.js',
    'data/server-catalog.js',
    'data/server-reservations.js',
    'demo-transfer.js'
  ];
  const appSource = fs.readFileSync(path.join(rootDir, 'app.js'), 'utf8');
  const preSource = preFiles.map(file => `\n/* ===== ${file} ===== */\n${fs.readFileSync(path.join(rootDir, file), 'utf8')}`).join('\n');
  const run = new Function('__PAYLOAD__', `
    const __noop = () => {};
    ${preSource}
    window.ALL_GOLF_PARTNER_SYNC.applyServerCourses(__PAYLOAD__.coursesPayload);
    const serverTimes = __PAYLOAD__.teeTimes;
    window.ALL_GOLF_SERVER_CATALOG = {
      teeTimesFor(course, date) { return String(course) === String(__PAYLOAD__.courseId) ? serverTimes : null; },
      ensureDate() { return Promise.resolve(true); },
      isServer() { return true; },
      inventoryLinked() { return true; },
      applyPayload() { return true; }
    };
    /* ===== app.js ===== */
    ${appSource}
    const target = courses.find(item => String(item.id) === String(__PAYLOAD__.courseId));
    const iso = __PAYLOAD__.teeTimes[0].date;
    const values = {
      get times() { return timesFor(target, iso); },
      get inventoryLinked() { return inventoryLinked(); },
      remainingAfterLocalReservation() {
        shared.setReservations([{ id: 'local-1', number: 'AG-LOCAL-00001', courseId: target.id, dateISO: iso, time: __PAYLOAD__.teeTimes[0].time, status: 'confirmed', people: 4 }]);
        const found = timesFor(target, iso).find(item => item.id === __PAYLOAD__.teeTimes[0].id);
        return found ? found.remaining : -1;
      }
    };
    return values;
  `);
  return run(payload);
}


/* 실제 고객 앱 코드로 서버 예약 플로우(Hold → 확정 → 완료 화면)를 실행한다.
   ALL_GOLF_API 를 가짜 서버로 바꿔 네트워크 없이 화면 코드 경로를 검증한다. */
function runAppBookingFlow(payload) {
  const preFiles = [
    'tests/dom-shim.js',
    'data/national-golf-courses.js',
    'data/golf-courses.js',
    'data/demo-teetimes.js',
    'data/partner-application.js',
    'data/shared-store.js',
    'data/api-client.js'
  ];
  const restFiles = ['data/server-reservations.js', 'data/partner-sync.js', 'demo-transfer.js'];
  const appSource = fs.readFileSync(path.join(rootDir, 'app.js'), 'utf8');
  const pre = preFiles.map(file => `\n/* ===== ${file} ===== */\n${fs.readFileSync(path.join(rootDir, file), 'utf8')}`).join('\n');
  const rest = restFiles.map(file => `\n/* ===== ${file} ===== */\n${fs.readFileSync(path.join(rootDir, file), 'utf8')}`).join('\n');
  const body = `
    ${pre}
    const flowCalls = [];
    localStorage.setItem('allGolfReservations', JSON.stringify([{ id: 'local-old', number: 'AG-LOCAL-OLD', courseId: 'woojeong', dateISO: '2026-11-26', time: '06:52', status: 'confirmed', createdAt: '2026-11-20T00:00:00.000Z' }]));
    window.ALL_GOLF_SERVER_MODE = true;
    window.ALL_GOLF_API = {
      state: { mode: 'server', connecting: false, base: '', health: { ok: true, stage: 8, features: { reservations: true } } },
      init: () => Promise.resolve('server'),
      apiUrl: pathname => pathname,
      onModeChange: () => () => {},
      isServer: () => true,
      request: (pathname, options) => {
        flowCalls.push({ pathname, options: options || {} });
        if (pathname === '/api/public/holds') {
          return Promise.resolve({ ok: true, status: 201, data: { reused: false, hold: { id: 'hold-flow-1', courseId: __PAYLOAD__.courseId, teeTimeId: 'tt-flow', expiresAt: new Date(Date.now() + 300000).toISOString() }, tee: { id: 'tt-flow', remaining: 2 } } });
        }
        if (pathname === '/api/public/reservations') {
          return Promise.resolve({ ok: true, status: 201, data: {
            idempotent: false,
            reservation: {
              id: 'rsv-flow-1', number: 'AG-260128-00042', courseId: __PAYLOAD__.courseId, courseName: '스테이지8 알파 CC',
              teeTimeId: 'tt-flow', date: __PAYLOAD__.date, dateISO: __PAYLOAD__.date, time: __PAYLOAD__.time, session: '1부',
              people: 4, booker: '김골퍼', phone: '01012345678', companions: ['박동반'], status: 'confirmed', phoneVerified: true,
              appliedGreenFee: 150000, regularGreenFee: 150000, greenFee: 150000, greenTotal: 600000, totalEstimated: 860000,
              paidDeposit: 120000, onsite: 740000, createdAt: new Date().toISOString()
            },
            inventory: { teeTimeId: 'tt-flow', remaining: 2 }
          } });
        }
        return Promise.resolve({ ok: false, status: 404, data: {}, error: { code: 'not_found', message: 'not found' } });
      }
    };
    ${rest}
    window.ALL_GOLF_PARTNER_SYNC.applyServerCourses(__PAYLOAD__.coursesPayload);
    const flowTimes = [{ id: 'tt-flow', courseId: __PAYLOAD__.courseId, date: __PAYLOAD__.date, time: __PAYLOAD__.time, session: '1부', capacityTeams: 3, maxPlayers: 4, remaining: 3, price: 150000, greenFee: 150000, regular: 150000, closed: false, serverManaged: true }];
    window.ALL_GOLF_SERVER_CATALOG = {
      teeTimesFor(course) { return String(course) === String(__PAYLOAD__.courseId) ? flowTimes : null; },
      ensureDate() { return Promise.resolve(true); },
      isServer() { return true; },
      inventoryLinked() { return true; },
      applyPayload() { return true; }
    };
    /* ===== app.js ===== */
    ${appSource}
    course = courses.find(item => String(item.id) === String(__PAYLOAD__.courseId)) || course;
    calendarDate = __PAYLOAD__.date;
    date = formatCalendarDate(calendarDate);
    tee = timesFor(course).find(item => item.id === 'tt-flow') || timesFor(course)[0];
    people = 4;
    bookingDraft = { booker: '김골퍼', phone: '010-1234-5678', request: '', companions: ['박동반'], terms: true, refund: true };
    const flowErrors = [];
    try { reserve(); } catch (error) { flowErrors.push('reserve: ' + (error && error.message)); }
    return new Promise(resolve => {
      const done = () => {
        try {
          const reservationCall = flowCalls.find(item => item.pathname === '/api/public/reservations');
          resolve({
            paths: flowCalls.map(item => item.pathname),
            idempotencyHeader: String(Boolean(reservationCall && reservationCall.options.headers && reservationCall.options.headers['Idempotency-Key'])),
            holdIdSent: reservationCall && reservationCall.options.body ? String(reservationCall.options.body.holdId) : '',
            saved: shared.getReservations(),
            savedPhone: ALL_GOLF_SERVER_RESERVATIONS.savedPhone(),
            page,
            text: document.querySelector('#app').innerHTML,
            errors: flowErrors
          });
        } catch (error) { resolve({ paths: [], saved: [], text: '', page: 'error', errors: [...flowErrors, 'done: ' + (error && error.message)] }); }
      };
      __realSetTimeout(() => {
        const confirmButton = document.querySelector('#confirm-reserve');
        if (confirmButton && typeof confirmButton.onclick === 'function') {
          try { confirmButton.onclick({ target: confirmButton }); } catch (error) { flowErrors.push('confirm: ' + (error && error.message)); }
        } else {
          flowErrors.push('confirm 버튼 핸들러 없음');
        }
        __realSetTimeout(() => {
          const reservationCall = flowCalls.find(item => item.pathname === '/api/public/reservations');
          resolve({
            paths: flowCalls.map(item => item.pathname),
            idempotencyHeader: String(Boolean(reservationCall && reservationCall.options.headers && reservationCall.options.headers['Idempotency-Key'])),
            holdIdSent: reservationCall && reservationCall.options.body ? String(reservationCall.options.body.holdId) : '',
            saved: shared.getReservations(),
            savedPhone: ALL_GOLF_SERVER_RESERVATIONS.savedPhone(),
            page,
            text: document.querySelector('#app').innerHTML
          });
        }, 200);
      }, 100);
      __realSetTimeout(() => { if (!flowCalls.length) done(); }, 4000);
    });
  `;
  const run = new Function('__PAYLOAD__', '__realSetTimeout', body);
  return Promise.resolve(run(payload, realSetTimeout));
}

main().catch(error => {
  console.error('\n테스트 실행 실패:', error && error.stack || error);
  process.exitCode = 1;
});
