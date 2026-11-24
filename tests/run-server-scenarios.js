#!/usr/bin/env node
/* ALL:GOLF 6단계 서버·DB 시나리오 테스트
   사용법: node tests/run-server-scenarios.js   (= npm run test:server)
   - 실제 server/index.js 를 임시 DB 로 띄워 HTTP API 를 검사한다.
   - 브라우저 없이 사용자 앱 코드를 실행해 "승인된 골프장 예약 가능"까지 확인한다.
   - 실패가 있으면 종료 코드 1. */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const catalog = require('../server/lib/catalog').getCatalog();
const nonPartnerCourseId = catalog.courses.find(item => !catalog.defaultPartnerIdSet.has(String(item.id))).id;

const rootDir = path.resolve(__dirname, '..');
const results = [];
let currentSection = '';
const section = name => { currentSection = name; results.push({ heading: true, name }); };
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

async function waitForHealth(base, timeoutMs = 12000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return await response.json();
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`서버가 응답하지 않습니다: ${lastError && lastError.message}`);
}

function stopServer(handle) {
  if (!handle || !handle.child || handle.child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => { try { handle.child.kill('SIGKILL'); } catch { /* noop */ } resolve(); }, 6000);
    handle.child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { handle.child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
  });
}

const tomorrow = (() => {
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000 + 86400000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
})();

async function main() {
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allgolf-stage6-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const password = `stage6-${Math.random().toString(36).slice(2, 10)}`;
  const env = { PORT: String(port), ALLGOLF_DB_PATH: dbPath, ADMIN_PASSWORD: password, SESSION_SECRET: 'stage6-test-secret-0123456789abcdef' };

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

  const newApplication = (overrides = {}) => ({
    courseMode: 'new', courseName: '스테이지6 힐스 CC', region: '경기', city: '이천',
    holes: '18', operationType: 'public', coursePhone: '031-000-0000', address: '경기 이천시 테스트로 1',
    website: 'https://stage6.example.com',
    managerName: '김담당', managerRole: '예약 담당', managerPhone: '010-1234-5678', managerEmail: 'stage6@example.com',
    weekdayGreenFee: '160000', weekendGreenFee: '190000', cartFee: '100000', caddieFee: '150000', teeInterval: '8',
    memo: '주말 2인 플레이 가능', agree: true, ...overrides
  });

  let server = null;
  let application = null;
  let lookupCode = '';
  let token = '';
  let approvedCourseId = '';

  try {
    /* 1. 서버 기동 ---------------------------------------------------------- */
    section('6단계 · 서버 기동과 상태');
    server = await startServer(env);
    const health = await waitForHealth(base);
    ok('서버 기동 · /api/health 200', health && health.ok === true, JSON.stringify(health));
    eq('API 이름', health.name, 'ALL:GOLF API');
    ok('DB 영속 모드 표시', health.db && health.db.persistent === true);
    eq('관리자 인증 환경변수 모드', health.auth && health.auth.mode, 'env');
    ok('SSE 지원 표시', health.features && health.features.sse === true);
    const staticPage = await call('GET', '/');
    ok('같은 서버가 정적 앱도 서빙', staticPage.status === 200 && staticPage.text.includes('ALL:GOLF'));
    ok('서버 모드 플래그 주입', staticPage.text.includes('window.ALL_GOLF_SERVER_MODE=true'));
    const blocked = await call('GET', '/server/data/db.json');
    ok('DB 파일 직접 접근 차단', blocked.status === 404, `status=${blocked.status}`);
    const envFile = await call('GET', '/.env');
    ok('.env 직접 접근 차단', envFile.status === 404, `status=${envFile.status}`);
    const encodedDb = await call('GET', '/server%2Fdata%2Fdb.json');
    ok('인코딩 우회한 DB 접근도 차단', encodedDb.status === 404, `status=${encodedDb.status}`);

    /* 2. 공개 목록 초기 상태 ------------------------------------------------ */
    section('6단계 · 공개 제휴 골프장 목록');
    const emptyList = await call('GET', '/api/partner-courses');
    eq('최초 승인 골프장 0곳', emptyList.data.count, 0);
    ok('공개 목록 응답 형식', emptyList.data.ok === true && Array.isArray(emptyList.data.courses));

    /* 3. 신청 검증 ---------------------------------------------------------- */
    section('6단계 · 제휴 신청 접수와 검증');
    const badPhone = await call('POST', '/api/partner-applications', { body: newApplication({ managerPhone: '1234' }) });
    eq('잘못된 연락처 400', badPhone.status, 400);
    ok('필드별 오류 반환', badPhone.data && badPhone.data.error && badPhone.data.error.details && badPhone.data.error.details.errors.managerPhone === '휴대전화번호 형식이 올바르지 않습니다. 예: 010-1234-5678', JSON.stringify(badPhone.data));
    const noAgree = await call('POST', '/api/partner-applications', { body: newApplication({ agree: false }) });
    eq('동의 없음 400', noAgree.status, 400);
    const badRegion = await call('POST', '/api/partner-applications', { body: newApplication({ region: '없는지역' }) });
    eq('없는 지역 400', badRegion.status, 400);
    const noCourse = await call('POST', '/api/partner-applications', { body: newApplication({ courseMode: 'existing', courseId: 'no-such-course' }) });
    eq('없는 골프장 선택 400', noCourse.status, 400);

    /* 4. 컨텍스트 A: 신청 접수 --------------------------------------------- */
    section('6단계 · 컨텍스트 A (골프장) 신청 접수');
    const created = await call('POST', '/api/partner-applications', { body: newApplication() });
    eq('신청 접수 201', created.status, 201);
    application = created.data.application;
    lookupCode = created.data.lookupCode;
    ok('접수번호 형식 PA-YYMMDD-NNNN', /^PA-\d{6}-\d{4}$/.test(application.id), application.id);
    eq('신청 상태 검토 대기', application.status, 'pending');
    ok('6자리 조회 코드 발급', /^\d{6}$/.test(lookupCode), lookupCode);
    ok('응답에 조회 코드 해시 없음', !JSON.stringify(created.data).includes('lookupCodeHash'));
    ok('createdAt·updatedAt 부여', Boolean(application.createdAt && application.updatedAt));

    const duplicate = await call('POST', '/api/partner-applications', { body: newApplication({ city: '여주' }) });
    eq('같은 이름 중복 신청 409', duplicate.status, 409);
    ok('중복 안내에 접수번호 포함', String(duplicate.data.error.message).includes(application.id), JSON.stringify(duplicate.data));

    const existingCourse = nonPartnerCourseId;
    const existingApp = await call('POST', '/api/partner-applications', {
      body: newApplication({ courseMode: 'existing', courseId: existingCourse, courseName: undefined, region: undefined, city: undefined, holes: undefined })
    });
    eq('기존 마스터 골프장(비제휴) 신청도 접수', existingApp.status, 201);

    /* 5. 컨텍스트 A: 본인 조회 / 타인 차단 --------------------------------- */
    section('6단계 · 컨텍스트 A 본인 조회와 타인 차단');
    const noCode = await call('GET', `/api/partner-applications/${application.id}`);
    eq('조회 코드 없이 조회 403', noCode.status, 403);
    const wrongCode = await call('GET', `/api/partner-applications/${application.id}?code=000000`);
    eq('틀린 조회 코드 403', wrongCode.status, 403);
    const ownLookup = await call('GET', `/api/partner-applications/${application.id}?code=${lookupCode}`);
    eq('본인 조회 200', ownLookup.status, 200);
    ok('타인 조회 응답에 조회 코드 해시 없음', !JSON.stringify(ownLookup.data).includes('lookupCodeHash'));
    const byPhone = await call('GET', `/api/partner-applications/${application.id}?phone=010-1234-5678`);
    eq('담당자 연락처로도 본인 조회', byPhone.status, 200);
    const unknown = await call('GET', '/api/partner-applications/PA-000000-0001?code=123456');
    eq('없는 접수번호 404', unknown.status, 404);

    /* 6. 관리자 인증 -------------------------------------------------------- */
    section('6단계 · 컨텍스트 B (본사) 관리자 인증');
    const noAuthList = await call('GET', '/api/admin/partner-applications');
    eq('인증 없이 신청 목록 401', noAuthList.status, 401);
    const badToken = await call('GET', '/api/admin/partner-applications', { token: 'v1.fake.token' });
    eq('위조 토큰 401', badToken.status, 401);
    const wrongPassword = await call('POST', '/api/admin/login', { body: { password: 'wrong-password' } });
    eq('틀린 비밀번호 401', wrongPassword.status, 401);
    const login = await call('POST', '/api/admin/login', { body: { email: 'admin@allgolf.demo', password } });
    eq('관리자 로그인 200', login.status, 200);
    token = login.data && login.data.token;
    ok('서명 토큰 발급', Boolean(token) && token.split('.').length === 3);
    ok('HttpOnly 세션 쿠키 발급', /allgolf_admin=/.test(String(login.headers.get('set-cookie'))) && /HttpOnly/.test(String(login.headers.get('set-cookie'))));
    const session = await call('GET', '/api/admin/session', { token });
    eq('세션 확인 200', session.status, 200);
    const adminList = await call('GET', '/api/admin/partner-applications', { token });
    eq('관리자 신청 목록 200', adminList.status, 200);
    ok('관리자 목록에는 담당자 연락처 포함', JSON.stringify(adminList.data).includes('010-1234-5678'));
    ok('관리자 목록에 조회 코드 해시 없음', !JSON.stringify(adminList.data).includes('lookupCodeHash'));

    const noAuthApprove = await call('POST', `/api/admin/partner-applications/${application.id}/approve`, { body: {} });
    eq('인증 없는 승인 401', noAuthApprove.status, 401);
    const noAuthReject = await call('POST', `/api/admin/partner-applications/${application.id}/reject`, { body: { reason: 'x' } });
    eq('인증 없는 반려 401', noAuthReject.status, 401);

    /* 7. 승인·반려 ---------------------------------------------------------- */
    section('6단계 · 컨텍스트 B 승인 처리');
    const emptyReason = await call('POST', `/api/admin/partner-applications/${existingApp.data.application.id}/reject`, { token, body: { reason: '' } });
    eq('반려 사유 없으면 400', emptyReason.status, 400);
    const approved = await call('POST', `/api/admin/partner-applications/${application.id}/approve`, { token, body: { memo: '서류 확인 완료' } });
    eq('승인 200', approved.status, 200);
    eq('승인 상태 반영', approved.data.application.status, 'approved');
    ok('승인자·일시 기록', Boolean(approved.data.application.decision && approved.data.application.decision.at && approved.data.application.decision.by));
    approvedCourseId = approved.data.application.newCourseId;
    const approveAgain = await call('POST', `/api/admin/partner-applications/${application.id}/approve`, { token, body: {} });
    eq('중복 승인 409', approveAgain.status, 409);
    const rejectApproved = await call('POST', `/api/admin/partner-applications/${application.id}/reject`, { token, body: { reason: '뒤늦은 반려' } });
    eq('승인 건 반려 409', rejectApproved.status, 409);

    /* 8. 공개 목록과 민감정보 ---------------------------------------------- */
    section('6단계 · 컨텍스트 C 공개 목록(민감정보 제외)');
    const publicList = await call('GET', '/api/partner-courses');
    eq('승인 골프장 1곳 공개', publicList.data.count, 1);
    const publicCourse = publicList.data.courses[0];
    ok('승인 골프장 정보 포함', publicCourse.id === approvedCourseId && publicCourse.name === '스테이지6 힐스 CC', JSON.stringify(publicCourse));
    const publicJson = JSON.stringify(publicList.data);
    ok('공개 목록에 담당자 전화 없음', !publicJson.includes('010-1234-5678'));
    ok('공개 목록에 대표 전화는 포함(공개 정보)', publicJson.includes('031-000-0000'));
    ok('공개 목록에 담당자 이메일 없음', !publicJson.includes('stage6@example.com'));
    ok('공개 목록에 담당자 이름 없음', !publicJson.includes('김담당'));
    ok('공개 목록에 운영 메모 없음', !publicJson.includes('주말 2인 플레이 가능'));
    ok('공개 목록에 제휴 신청 접수번호 없음', !publicJson.includes(application.id), application.id);
    const teeTimes = await call('GET', `/api/partner-courses/${approvedCourseId}/tee-times?date=${tomorrow}`);
    eq('승인 골프장 시연 티타임 200', teeTimes.status, 200);
    ok('시연 티타임 5개 생성', teeTimes.data.teeTimes.length === 5 && teeTimes.data.teeTimes.every(item => /^\d{2}:\d{2}$/.test(item.time)));
    const badDate = await call('GET', `/api/partner-courses/${approvedCourseId}/tee-times?date=2026-13-40`);
    eq('잘못된 날짜 400', badDate.status, 400);

    /* 9. 처리 이력 ---------------------------------------------------------- */
    section('6단계 · 승인 처리 이력(auditLogs)');
    const noAuthLogs = await call('GET', '/api/admin/audit-logs');
    eq('인증 없는 이력 조회 401', noAuthLogs.status, 401);
    const logs = await call('GET', '/api/admin/audit-logs?limit=50', { token });
    eq('이력 조회 200', logs.status, 200);
    ok('신청 접수 이력 존재', logs.data.logs.some(item => item.action === 'application.created' && item.applicationId === application.id));
    ok('승인 이력 존재', logs.data.logs.some(item => item.action === 'application.approved' && item.applicationId === application.id));
    ok('이력에 처리자 이메일 기록', logs.data.logs.some(item => item.actor && item.actor.email === 'admin@allgolf.demo'));
    const filtered = await call('GET', `/api/admin/audit-logs?applicationId=${application.id}`, { token });
    ok('접수번호로 이력 필터', filtered.data.logs.length >= 2 && filtered.data.logs.every(item => item.applicationId === application.id));

    /* 10. 동시성 ----------------------------------------------------------- */
    section('6단계 · 동시 승인 경쟁 상태 방어');
    const concurrent = await call('POST', '/api/partner-applications', {
      body: newApplication({ courseName: '스테이지6 동시성 CC', managerEmail: 'race@example.com' })
    });
    eq('동시성 테스트용 신청 접수', concurrent.status, 201);
    const raceId = concurrent.data.application.id;
    const raceResults = await Promise.all(Array.from({ length: 10 }, () => call('POST', `/api/admin/partner-applications/${raceId}/approve`, { token, body: {} })));
    const successes = raceResults.filter(item => item.status === 200).length;
    const conflicts = raceResults.filter(item => item.status === 409).length;
    eq('동시 승인 중 성공 1건', successes, 1);
    eq('나머지는 409', conflicts, 9);

    /* 11. 재시작 후 데이터 보존 -------------------------------------------- */
    section('6단계 · 서버 재시작 후 데이터 보존');
    const beforeRestart = await call('GET', '/api/admin/partner-applications', { token });
    const beforeCourses = (await call('GET', '/api/partner-courses')).data.count;
    await stopServer(server);
    ok('DB 파일 생성됨', fs.existsSync(dbPath));
    server = await startServer(env);
    await waitForHealth(base);
    const relogin = await call('POST', '/api/admin/login', { body: { password } });
    eq('재시작 후 관리자 재로그인', relogin.status, 200);
    token = relogin.data.token;
    const afterRestart = await call('GET', '/api/admin/partner-applications', { token });
    eq('재시작 후 신청 건수 유지', afterRestart.data.applications.length, beforeRestart.data.applications.length);
    const kept = afterRestart.data.applications.find(item => item.id === application.id);
    eq('재시작 후 승인 상태 유지', kept && kept.status, 'approved');
    eq('재시작 후 공개 골프장 수 유지', (await call('GET', '/api/partner-courses')).data.count, beforeCourses);
    const lookupAfterRestart = await call('GET', `/api/partner-applications/${application.id}?code=${lookupCode}`);
    eq('재시작 후 본인 조회 유지', lookupAfterRestart.status, 200);
    const logsAfterRestart = await call('GET', '/api/admin/audit-logs?limit=200', { token });
    ok('재시작 후 처리 이력 유지', logsAfterRestart.data.logs.some(item => item.action === 'application.approved'));

    /* 12. 정적 모드 폴백 ---------------------------------------------------- */
    section('6단계 · 서버 오프라인 정적 모드 폴백');
    const staticClient = await runApiClient({ search: '', serverFlag: false, fetchImpl: countingFetch() });
    eq('정적 호스팅은 즉시 정적 모드', await staticClient.api.init(), 'static');
    eq('정적 모드에서 네트워크 요청 0건', staticClient.calls(), 0);
    eq('모드 표기', staticClient.api.modeLabel(), '정적 시연');

    const offlineClient = await runApiClient({
      search: '?api=http://127.0.0.1:1/',
      serverFlag: false,
      fetchImpl: () => Promise.reject(new Error('connect ECONNREFUSED'))
    });
    eq('설정된 서버가 꺼져 있으면 정적 모드', await offlineClient.api.init(), 'static');
    eq('오프라인 사유 기록', offlineClient.api.state.reason, 'server_unreachable');
    const offlineRequest = await offlineClient.api.request('/api/health');
    ok('정적 모드 요청은 실패 객체로 반환(예외 없음)', offlineRequest.ok === false && offlineRequest.error.code === 'static_mode');

    /* 13. 사용자 앱 연동 ---------------------------------------------------- */
    section('6단계 · 컨텍스트 C 사용자 앱 예약 가능 확인');
    const publicPayload = (await call('GET', '/api/partner-courses')).data;
    const app = runAppWithServerCourses(publicPayload);
    ok('사용자 앱이 승인 골프장을 제휴로 인식', app.partnerStore.isPartnerCourse(approvedCourseId), approvedCourseId);
    const appCourse = app.getCourses().find(item => item.id === approvedCourseId);
    ok('사용자 앱 목록에 승인 골프장 표시', Boolean(appCourse), approvedCourseId);
    ok('사용자 앱에서 예약 가능 상태', appCourse && appCourse.bookable === true && appCourse.partnered === true, JSON.stringify(appCourse && { bookable: appCourse.bookable, partnered: appCourse.partnered }));
    const times = app.shared.getTeeTimes(approvedCourseId, tomorrow, app.partnerStore.demoTimesFor(approvedCourseId, tomorrow));
    ok('승인 골프장 시연 티타임 노출', times.length > 0, times.length);
    ok('승인 골프장 티타임 예약 성공', app.shared.reserveTee(approvedCourseId, tomorrow, times[0].time) === true, times[0] && times[0].time);
    eq('신규 골프장은 승인된 수만큼만 예약 가능', app.getCourses().filter(item => String(item.id).startsWith('ap-')).length, publicPayload.courses.filter(item => item.source === 'new').length);
    ok('검토 대기 중인 기존 골프장은 아직 제휴 아님', !app.partnerStore.isPartnerCourse(existingCourse), existingCourse);
  } finally {
    await stopServer(server);
    try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* noop */ }
  }

  /* 보고 ------------------------------------------------------------------ */
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
  const fetchImpl = options.fetchImpl || (() => Promise.resolve({ ok: false, status: 404, text: async () => 'not found' }));
  const sandbox = {
    location: { search: options.search || '', href: 'https://neved12.github.io/all-golf-test/', origin: 'https://neved12.github.io', protocol: 'https:' },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    URLSearchParams,
    fetch: (...args) => { calls.count += 1; return fetchImpl(...args); },
    setTimeout,
    clearTimeout,
    AbortController,
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

function countingFetch() {
  return () => Promise.resolve({ ok: false, status: 404, text: async () => 'not found' });
}

/* --- 도우미: 실제 앱 코드를 실행해 서버 승인 골프장 반영 확인 ----------- */
function runAppWithServerCourses(payload) {
  const files = [
    'tests/dom-shim.js',
    'data/national-golf-courses.js',
    'data/golf-courses.js',
    'data/demo-teetimes.js',
    'data/partner-application.js',
    'data/shared-store.js',
    'data/partner-sync.js',
    'demo-transfer.js',
    'app.js'
  ];
  const source = files.map(file => `\n/* ===== ${file} ===== */\n${fs.readFileSync(path.join(rootDir, file), 'utf8')}`).join('\n');
  const run = new Function('__SERVER_COURSES__', `${source}\n
    const sync = window.ALL_GOLF_PARTNER_SYNC;
    sync.applyServerCourses(__SERVER_COURSES__);
    return {
      partnerStore: window.ALL_GOLF_PARTNER_STORE,
      shared: window.ALL_GOLF_STORE,
      getCourses: () => courses
    };`);
  return run(payload);
}

main().catch(error => {
  console.error('\n테스트 실행 실패:', error && error.stack || error);
  process.exitCode = 1;
});
