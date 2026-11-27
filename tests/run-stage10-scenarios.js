#!/usr/bin/env node
/* ALL:GOLF 10단계 시나리오 테스트 — 원클릭 시연 데이터·투자자/제휴 시연·사업성 시뮬레이터
   사용법: node tests/run-stage10-scenarios.js   (= npm run test:stage10)
   - 사업성 시뮬레이터 계산(가정·반올림·범위 보정·요약 문구)
   - 시연 데이터 준비/초기화 API(관리자 인증·확인 문구·태그 격리·일반 데이터 보존)
   - CLI(npm run demo:stage10 / status / reset --yes)의 태그 격리
   - 서버 재시작 후 유지, 헬스 stage 10, 정적 모드에서 hub 스크립트가 요청을 보내지 않음 */
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

/* --- 사업성 시뮬레이터 (브라우저와 같은 파일을 그대로 실행) ----------------- */
function loadSimulator() {
  const code = fs.readFileSync(path.join(rootDir, 'data', 'business-simulator.js'), 'utf8');
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, Math, Number, String, Object, Array, JSON, Intl, console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'data/business-simulator.js' });
  return { api: module.exports, windowApi: sandbox.ALL_GOLF_SIMULATOR };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
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

async function waitHealth(base, timeoutMs = 15000) {
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

/* 일반(수동) 데이터가 시연 배치에 지워지지 않는지 확인하기 위한 씨앗.
   태그(demoStage)가 없는 레코드만 넣는다. */
function manualDatabase() {
  const now = new Date().toISOString();
  return {
    version: 4,
    meta: { createdAt: now, updatedAt: now, revision: 1, sequences: {}, lastBackupDate: null },
    applications: [{
      id: 'AP-260101-001', status: 'approved', courseMode: 'new', newCourseId: 'manual-cc',
      course: { name: '수동 승인 CC', region: '경기', city: '용인', address: '경기 용인시 수동로 1', holes: 18, operationType: 'public' },
      manager: { name: '수동담당', phone: '010-9000-1000', email: 'manual@example.com' },
      createdAt: now, updatedAt: now
    }],
    approvedCourses: [{
      id: 'manual-cc', name: '수동 승인 CC', region: '경기', city: '용인', address: '경기 용인시 수동로 1',
      operationType: 'public', holes: 18, source: 'new',
      greenFee: { weekday: 160000, weekend: 190000, cart: 100000, caddie: 150000, teeInterval: 8 },
      approvedAt: now, approvedBy: 'manual@example.com', createdAt: now, updatedAt: now
    }],
    partnerAccounts: [],
    teeTimes: [{
      id: 'tt-manual-1', courseId: 'manual-cc', courseName: '수동 승인 CC', course: '전체',
      date: today, time: '10:00', session: '2부', capacityTeams: 2, maxPlayers: 4,
      greenFee: 160000, status: 'open', note: '수동 등록', bookedTeams: 1, heldTeams: 0,
      version: 1, createdAt: now, updatedAt: now, dataMode: 'demo'
    }],
    rates: {},
    specialOffers: [],
    reservations: [{
      id: 'rsv-manual-1', number: 'AG-000000-00001', courseId: 'manual-cc', courseName: '수동 승인 CC',
      teeTimeId: 'tt-manual-1', date: today, dateISO: today, time: '10:00', session: '2부', people: 4,
      booker: '수동고객', phone: '010-9000-2000', companions: [], status: 'confirmed',
      totalEstimated: 890000, paidDeposit: 120000, online: 120000, onsite: 770000,
      greenFee: 160000, createdAt: now, updatedAt: now, dataMode: 'demo'
    }],
    bookingHolds: [],
    auditLogs: [],
    commissionRates: { 'manual-cc': { courseId: 'manual-cc', ratePercent: 7, updatedAt: now, updatedBy: null, version: 1 } },
    settlements: [{
      id: 'stl-manual-1', number: 'ST-202610-0001', courseId: 'manual-cc', courseName: '수동 승인 CC',
      period: { from: today, to: today }, status: 'DRAFT', statusLabel: '작성 중',
      calculation: { basisAmount: 890000, platformFee: 62300, payoutAmount: 827700 },
      commissionRatePercent: 7, basisAmount: 890000, platformFee: 62300, payoutAmount: 827700,
      grossAmount: 890000, cancellationFee: 0, refundAmount: 0, reservations: 1,
      confirmed: 1, completed: 0, noShow: 0, cancelled: 0, people: 4,
      createdAt: now, updatedAt: now, version: 1, history: [], dataMode: 'demo'
    }],
    notificationLogs: []
  };
}

function readDb(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['server/scripts/stage10-demo.js', ...args], {
      cwd: rootDir,
      env: { ...process.env, ALLGOLF_BACKUP: 'off', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  /* --- 1. 사업성 시뮬레이터 -------------------------------------------------- */
  section('10단계 · 사업성 시뮬레이터 계산');
  const { api: sim, windowApi: simWindowApi } = loadSimulator();
  ok('시뮬레이터가 브라우저(window)와 Node 양쪽에 노출', Boolean(sim) && Boolean(simWindowApi) && typeof sim.compute === 'function');
  eq('입력 항목 5개', sim.FIELDS.map(field => field.key), ['partnerCourses', 'teamsPerCoursePerDay', 'avgTicket', 'commissionPercent', 'monthlyDays']);
  eq('기본 가정값', sim.defaultInput(), { partnerCourses: 68, teamsPerCoursePerDay: 3, avgTicket: 320000, commissionPercent: 8, monthlyDays: 26 });
  const base = sim.compute(sim.defaultInput());
  eq('기본 가정 월 예약 팀 수', base.values.teamsPerMonth, 5304);
  eq('기본 가정 월 GMV', base.values.monthlyGmv, 1697280000);
  eq('기본 가정 월 수수료', base.values.monthlyFee, 135782400);
  eq('기본 가정 연 수수료 = 월 × 12', base.values.annualFee, base.values.monthlyFee * 12);
  eq('골프장 1곳당 월 수수료', base.values.perCourseMonthlyFee, 1996800);
  eq('계산 결과에 가정 기준 표시', base.basis, 'assumption');
  ok('면책 문구에 "실제 실적이 아닌" 표시', String(base.disclaimer).includes('실제 실적이 아닌'));
  ok('면책 문구에 취소·환불·세금·운영비 미반영 표시', ['취소', '환불', '세금', '운영비'].every(word => String(base.disclaimer).includes(word)));

  const custom = sim.compute({ partnerCourses: 120, teamsPerCoursePerDay: 4.5, avgTicket: 280000, commissionPercent: 12.5, monthlyDays: 24 });
  eq('사용자 가정 월 예약 팀 수', custom.values.teamsPerMonth, Math.round(120 * 4.5 * 24));
  eq('사용자 가정 월 GMV', custom.values.monthlyGmv, Math.round(Math.round(120 * 4.5 * 24) * 280000));
  eq('사용자 가정 월 수수료', custom.values.monthlyFee, Math.round(custom.values.monthlyGmv * 12.5 / 100));
  eq('소수 입력(4.5팀) 유지', custom.input.teamsPerCoursePerDay, 4.5);

  const clampedLow = sim.compute({ partnerCourses: 0, teamsPerCoursePerDay: -3, avgTicket: -100, commissionPercent: -1, monthlyDays: 0 });
  eq('최소 범위로 보정(골프장)', clampedLow.input.partnerCourses, 1);
  eq('최소 범위로 보정(수수료)', clampedLow.input.commissionPercent, 0);
  ok('범위 보정 경고 표시', clampedLow.warnings.length >= 3, JSON.stringify(clampedLow.warnings));
  const clampedHigh = sim.compute({ partnerCourses: 99999, teamsPerCoursePerDay: 999, avgTicket: 99999999, commissionPercent: 99, monthlyDays: 99 });
  eq('최대 범위로 보정(수수료 30%)', clampedHigh.input.commissionPercent, 30);
  eq('최대 범위로 보정(월 31일)', clampedHigh.input.monthlyDays, 31);
  const junk = sim.compute({ partnerCourses: 'abc', teamsPerCoursePerDay: '', avgTicket: null, commissionPercent: undefined, monthlyDays: '26일' });
  eq('숫자가 아닌 값은 기본값 사용(골프장)', junk.input.partnerCourses, 68);
  eq('빈 값은 경고 없이 기본값 사용(팀)', junk.warnings.filter(text => text.includes('팀')).length, 0);
  eq('소수 팀 입력 반올림(0.05)', sim.compute({ teamsPerCoursePerDay: 2.55 }).input.teamsPerCoursePerDay, 2.6);

  const summary = sim.summaryText(base);
  ok('요약 문구에 월·연 수수료 포함', summary.includes('월 플랫폼 수수료 매출') && summary.includes('연 플랫폼 수수료 매출'), summary.slice(0, 120));
  ok('요약 문구에 가정 값 포함', summary.includes('68곳') && summary.includes('320,000원') && summary.includes('8%'));
  ok('요약 문구에 면책 포함', summary.includes('실제 실적이 아닌'));
  eq('프리셋 3종', sim.PRESETS.map(item => item.key), ['conservative', 'base', 'growth']);
  eq('프리셋 적용', sim.preset('growth').partnerCourses, 150);
  ok('금액 포맷(원)', sim.formatWon(135782400) === '135,782,400원', sim.formatWon(135782400));

  /* --- 2. 시연 데이터 API ---------------------------------------------------- */
  section('10단계 · 시연 데이터 준비·초기화 API');
  const port = await getFreePort();
  const base0 = `http://127.0.0.1:${port}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allgolf-stage10-'));
  const dbPath = path.join(tmpDir, 'db.json');
  const adminPassword = 'Stage10Pass1';
  fs.writeFileSync(dbPath, `${JSON.stringify(manualDatabase(), null, 2)}\n`);
  let server = await startServer({ PORT: String(port), ALLGOLF_DB_PATH: dbPath, ALLGOLF_BACKUP_DIR: path.join(tmpDir, 'backups'), ADMIN_PASSWORD: adminPassword, SESSION_SECRET: 'stage10-secret-0123456789abcdef' });

  async function api(method, pathname, token, body, extraHeaders) {
    const response = await fetch(`${base0}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(extraHeaders || {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: response.status, data };
  }

  try {
    const health = await waitHealth(base0);
    eq('헬스 stage 10', health.stage, 10);
    ok('헬스 stages 에 10 포함', Array.isArray(health.stages) && health.stages.includes(10), JSON.stringify(health.stages));
    eq('헬스 기능 플래그 demoStage', health.features.demoStage, true);

    const login = await api('POST', '/api/admin/login', null, { password: adminPassword });
    eq('관리자 로그인', login.status, 200);
    const token = login.data.token;

    const beforeStatus = await api('GET', '/api/demo/stage10');
    eq('시연 상태 조회(공개)', beforeStatus.status, 200);
    eq('준비 전 배치 없음', beforeStatus.data.staged, false);
    eq('일반 데이터 골프장 1곳 보호', beforeStatus.data.protectedRecords.approvedCourses, 1);
    eq('일반 데이터 예약 1건 보호', beforeStatus.data.protectedRecords.reservations, 1);
    ok('시연 가이드 2모드 제공', Boolean(beforeStatus.data.guide && beforeStatus.data.guide.investor && beforeStatus.data.guide.partner && beforeStatus.data.guide.investor.length >= 5));
    eq('전국 509 · 시연 68 · 정보 441 안내', beforeStatus.data.flows, { investorCourses: 68, infoOnlyCourses: 441, totalCourses: 509 });

    const noAuth = await api('POST', '/api/demo/stage10/stage', null, { confirm: 'STAGE-STAGE10-DEMO' });
    eq('인증 없이 준비 요청 401', noAuth.status, 401);
    const wrongConfirm = await api('POST', '/api/demo/stage10/stage', token, { confirm: '아무거나' });
    eq('확인 문구 없으면 400', wrongConfirm.status, 400);
    eq('확인 문구 오류 코드', wrongConfirm.data.error.code, 'confirm_required');
    const afterWrong = readDb(dbPath);
    eq('확인 실패 후 DB 변화 없음(골프장)', afterWrong.approvedCourses.length, 1);

    const staged = await api('POST', '/api/demo/stage10/stage', token, { confirm: 'STAGE-STAGE10-DEMO' });
    eq('시연 데이터 준비 201', staged.status, 201);
    eq('시연 골프장 3곳 생성', staged.data.created.approvedCourses, 3);
    eq('시연 티타임 84건(3곳 × 7일 × 4시간)', staged.data.created.teeTimes, 84);
    eq('시연 담당자 계정 3개', staged.data.created.partnerAccounts, 3);
    ok('시연 예약 생성(60건 이상)', staged.data.created.reservations >= 60, staged.data.created.reservations);
    eq('시연 정산서 3건', staged.data.created.settlements, 3);
    eq('담당자 시연 비밀번호', staged.data.partnerLogin.password, 'allgolf-partner-2026');
    ok('배치 id 형식', /^s10-\d{14}-/.test(String(staged.data.batch)), staged.data.batch);

    const dbAfterStage = readDb(dbPath);
    eq('일반 골프장 여전히 1곳', dbAfterStage.approvedCourses.filter(item => item.id === 'manual-cc' && !item.demoStage).length, 1);
    eq('일반 예약 여전히 1건', dbAfterStage.reservations.filter(item => item.id === 'rsv-manual-1' && !item.demoStage).length, 1);
    eq('일반 정산서 여전히 1건', dbAfterStage.settlements.filter(item => item.id === 'stl-manual-1' && !item.demoStage).length, 1);
    ok('시연 레코드마다 태그', dbAfterStage.teeTimes.filter(item => item.demoStage === 'stage10' && item.demoBatch === staged.data.batch).length === 84);
    ok('시연 티타임 날짜가 오늘부터 7일', dbAfterStage.teeTimes.filter(item => item.demoStage === 'stage10').every(item => item.date >= today && item.date <= kstDate(6)));
    ok('시연 예약이 라운드일 기준 기간 안', dbAfterStage.reservations.filter(item => item.demoStage === 'stage10').every(item => item.date >= today && item.date <= kstDate(6)));
    eq('시연 수수료율 태그', Object.values(dbAfterStage.commissionRates).filter(item => item.demoStage === 'stage10').length, 3);
    eq('일반 수수료율 7% 유지', dbAfterStage.commissionRates['manual-cc'].ratePercent, 7);

    const statusStaged = await api('GET', '/api/demo/stage10');
    ok('준비 후 상태 staged', statusStaged.data.staged === true && statusStaged.data.demoTotal > 200, JSON.stringify({ staged: statusStaged.data.staged, total: statusStaged.data.demoTotal }));
    eq('보호 레코드 수 유지(골프장)', statusStaged.data.protectedRecords.approvedCourses, 1);

    /* 공개 카탈로그: 시연 티타임이 고객 앱에 보이고 잔여 팀이 계산된다. */
    const catalogRes = await api('GET', `/api/public/catalog?date=${tomorrow}`);
    eq('시연 티타임 고객 카탈로그 노출', catalogRes.status, 200);
    const woojeong = (catalogRes.data.courses || []).find(item => item.courseId === 'woojeong');
    ok('우정힐스 시연 티타임 4건', Boolean(woojeong) && woojeong.teeTimes.length === 4, woojeong ? JSON.stringify(woojeong.teeTimes.map(t => t.time)) : 'none');
    ok('잔여 팀 0~3 범위', Boolean(woojeong) && woojeong.teeTimes.every(tee => tee.remaining >= 0 && tee.remaining <= 3 && tee.capacityTeams === 3), woojeong ? JSON.stringify(woojeong.teeTimes.map(t => ({ time: t.time, remaining: t.remaining }))) : 'none');

    /* 재준비(멱등): 이전 배치를 정리하고 같은 수를 다시 만든다. */
    const nonDemoBefore = dbAfterStage.teeTimes.filter(item => !item.demoStage).length;
    const restaged = await api('POST', '/api/demo/stage10/stage', token, { confirm: 'STAGE-STAGE10-DEMO' });
    eq('재준비 201', restaged.status, 201);
    const dbRestaged = readDb(dbPath);
    eq('재준비 후 시연 티타임 84건 유지(중복 없음)', dbRestaged.teeTimes.filter(item => item.demoStage === 'stage10').length, 84);
    eq('재준비 후 일반 티타임 수 유지', dbRestaged.teeTimes.filter(item => !item.demoStage).length, nonDemoBefore);
    eq('재준비 후 시연 예약 60건 이상', dbRestaged.reservations.filter(item => item.demoStage === 'stage10').length >= 60, true);
    ok('재준비 배치 id 변경', restaged.data.batch !== staged.data.batch);
    eq('재준비 후 일반 정산서 유지', dbRestaged.settlements.filter(item => !item.demoStage).length, 1);

    /* 초기화 가드 */
    const resetNoConfirm = await api('POST', '/api/demo/stage10/reset', token, {});
    eq('확인 문구 없이 초기화 400', resetNoConfirm.status, 400);
    eq('초기화 확인 문구 오류', resetNoConfirm.data.error.code, 'confirm_required');
    const stillThere = readDb(dbPath);
    ok('초기화 실패 후 시연 데이터 그대로', stillThere.reservations.filter(item => item.demoStage === 'stage10').length >= 60);

    /* 초기화 실행 */
    const reset = await api('POST', '/api/demo/stage10/reset', token, { confirm: 'RESET-STAGE10-DEMO' });
    eq('초기화 200', reset.status, 200);
    ok('삭제 합계 200건 이상', reset.data.removedTotal >= 200, reset.data.removedTotal);
    const dbReset = readDb(dbPath);
    eq('초기화 후 시연 골프장 0', dbReset.approvedCourses.filter(item => item.demoStage === 'stage10').length, 0);
    eq('초기화 후 시연 티타임 0', dbReset.teeTimes.filter(item => item.demoStage === 'stage10').length, 0);
    eq('초기화 후 시연 예약 0', dbReset.reservations.filter(item => item.demoStage === 'stage10').length, 0);
    eq('초기화 후 시연 정산서 0', dbReset.settlements.filter(item => item.demoStage === 'stage10').length, 0);
    eq('초기화 후 시연 계정 0', dbReset.partnerAccounts.filter(item => item.demoStage === 'stage10').length, 0);
    eq('초기화 후 시연 수수료율 0', Object.values(dbReset.commissionRates).filter(item => item.demoStage === 'stage10').length, 0);
    eq('초기화 후 일반 골프장 보존', dbReset.approvedCourses.filter(item => item.id === 'manual-cc').length, 1);
    eq('초기화 후 일반 티타임 보존', dbReset.teeTimes.filter(item => item.id === 'tt-manual-1').length, 1);
    eq('초기화 후 일반 예약 보존', dbReset.reservations.filter(item => item.id === 'rsv-manual-1').length, 1);
    eq('초기화 후 일반 정산서 보존', dbReset.settlements.filter(item => item.id === 'stl-manual-1').length, 1);
    eq('초기화 후 일반 수수료율 보존', dbReset.commissionRates['manual-cc'].ratePercent, 7);
    const statusReset = await api('GET', '/api/demo/stage10');
    eq('초기화 후 상태 staged=false', statusReset.data.staged, false);

    /* 재시작 후 유지: 다시 준비 → 서버 재시작 → 데이터 유지 */
    const stagedAgain = await api('POST', '/api/demo/stage10/stage', token, { confirm: 'STAGE-STAGE10-DEMO' });
    eq('재시작 전 준비', stagedAgain.status, 201);
    await stopServer(server);
    server = await startServer({ PORT: String(port), ALLGOLF_DB_PATH: dbPath, ALLGOLF_BACKUP_DIR: path.join(tmpDir, 'backups'), ADMIN_PASSWORD: adminPassword, SESSION_SECRET: 'stage10-secret-0123456789abcdef' });
    await waitHealth(base0);
    const afterRestart = await api('GET', '/api/demo/stage10');
    eq('재시작 후 시연 배치 유지', afterRestart.data.staged, true);
    eq('재시작 후 티타임 84건', afterRestart.data.demo.teeTimes, 84);
    ok('재시작 후 일반 데이터 유지', afterRestart.data.protectedRecords.approvedCourses === 1 && afterRestart.data.protectedRecords.reservations === 1);
  } finally {
    await stopServer(server);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  }

  /* --- 3. CLI ---------------------------------------------------------------- */
  section('10단계 · CLI(npm run demo:stage10)');
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allgolf-stage10-cli-'));
  const cliDb = path.join(cliDir, 'db.json');
  fs.writeFileSync(cliDb, `${JSON.stringify(manualDatabase(), null, 2)}\n`);
  const cliEnv = { ALLGOLF_DB_PATH: cliDb, ALLGOLF_BACKUP_DIR: path.join(cliDir, 'backups'), ALLGOLF_BACKUP: 'off' };
  try {
    const statusEmpty = await runCli(['status'], cliEnv);
    eq('CLI status 종료 코드 0', statusEmpty.code, 0);
    ok('CLI status 에 시연 데이터 0건 표시', statusEmpty.stdout.includes('시연 티타임') && statusEmpty.stdout.includes('0건'), statusEmpty.stdout.slice(0, 200));

    const staged = await runCli([], cliEnv);
    eq('CLI 기본 실행 코드 0', staged.code, 0);
    ok('CLI 준비 결과 출력', staged.stdout.includes('시연 데이터를 준비했습니다') && staged.stdout.includes('allgolf-partner-2026'), staged.stdout.slice(-260));
    const dbCli = readDb(cliDb);
    eq('CLI 시연 티타임 84건', dbCli.teeTimes.filter(item => item.demoStage === 'stage10').length, 84);
    ok('CLI 시연 예약 60건 이상', dbCli.reservations.filter(item => item.demoStage === 'stage10').length >= 60);
    eq('CLI 일반 예약 보존', dbCli.reservations.filter(item => item.id === 'rsv-manual-1').length, 1);

    const resetGuard = await runCli(['reset'], cliEnv);
    eq('CLI 초기화(비대화형, --yes 없음) 코드 0', resetGuard.code, 0);
    ok('CLI 비대화형 초기화는 --yes 요구', resetGuard.stdout.includes('--yes'), resetGuard.stdout.slice(-200));
    eq('CLI 가드 후 데이터 유지', readDb(cliDb).teeTimes.filter(item => item.demoStage === 'stage10').length, 84);

    const dry = await runCli(['reset', '--dry-run'], cliEnv);
    ok('CLI --dry-run 은 삭제하지 않음', dry.code === 0 && readDb(cliDb).teeTimes.filter(item => item.demoStage === 'stage10').length === 84, dry.stdout.slice(-200));

    const reset = await runCli(['reset', '--yes'], cliEnv);
    eq('CLI 초기화 --yes 코드 0', reset.code, 0);
    const dbCliReset = readDb(cliDb);
    eq('CLI 초기화 후 시연 티타임 0', dbCliReset.teeTimes.filter(item => item.demoStage === 'stage10').length, 0);
    eq('CLI 초기화 후 시연 예약 0', dbCliReset.reservations.filter(item => item.demoStage === 'stage10').length, 0);
    eq('CLI 초기화 후 일반 티타임 보존', dbCliReset.teeTimes.filter(item => item.id === 'tt-manual-1').length, 1);
    eq('CLI 초기화 후 일반 예약 보존', dbCliReset.reservations.filter(item => item.id === 'rsv-manual-1').length, 1);
    eq('CLI 초기화 후 일반 정산서 보존', dbCliReset.settlements.filter(item => item.id === 'stl-manual-1').length, 1);
  } finally {
    try { fs.rmSync(cliDir, { recursive: true, force: true }); } catch { /* noop */ }
  }

  /* --- 4. 시연 허브 스크립트 기본 동작(정적 모드에서 요청 0건) ---------------- */
  section('10단계 · 시연 허브 스크립트(정적 모드)');
  const hubBox = createLooseDocument();
  const calls = { count: 0 };
  const hubSandbox = {
    document: hubBox.document,
    location: { search: '', href: 'https://neved12.github.io/all-golf-test/demo/', origin: 'https://neved12.github.io', protocol: 'https:', hash: '' },
    navigator: { userAgent: 'node-smoke' },
    localStorage: makeStorage(), sessionStorage: makeStorage(),
    fetch: () => { calls.count += 1; return Promise.reject(new Error('no network')); },
    URLSearchParams, URL, AbortController,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    console, alert: () => {}, confirm: () => false,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    EventSource: undefined,
    Intl, Math, JSON, Number, String, Object, Array, Date
  };
  hubSandbox.window = hubSandbox;
  hubSandbox.self = hubSandbox;
  hubSandbox.window.__listeners = {};
  hubSandbox.window.addEventListener = (type, handler) => { (hubSandbox.window.__listeners[type] = hubSandbox.window.__listeners[type] || []).push(handler); };
  hubSandbox.window.removeEventListener = () => {};
  hubSandbox.window.dispatchEvent = event => { (hubSandbox.window.__listeners[event.type] || []).forEach(handler => handler(event)); };
  vm.createContext(hubSandbox);
  try {
    ['data/national-golf-courses.js', 'data/golf-courses.js', 'data/demo-teetimes.js', 'data/business-simulator.js', 'data/api-client.js', 'demo/demo.js']
      .forEach(file => vm.runInContext(fs.readFileSync(path.join(rootDir, file), 'utf8'), hubSandbox, { filename: file }));
    await sleep(300);
    ok('허브 스크립트 로드·전역 노출', Boolean(hubSandbox.ALL_GOLF_STAGE10_HUB), 'ALL_GOLF_STAGE10_HUB 없음');
    eq('정적 모드에서 서버 요청 0건', calls.count, 0);
    ok('허브가 정적 시연으로 표시', hubBox.text('#mode-chip').includes('정적 시연'), hubBox.text('#mode-chip'));
    ok('가이드 단계 렌더(투자자 7단계)', hubSandbox.ALL_GOLF_STAGE10_HUB.GUIDE.investor.steps.length === 7 && hubSandbox.ALL_GOLF_STAGE10_HUB.GUIDE.partner.steps.length === 6);
    ok('초기화 버튼 잠김 상태', hubBox.el('#btn-reset') && hubBox.el('#btn-reset').disabled === true);
  } catch (error) {
    ok('허브 스크립트 실행', false, error && error.stack);
  }

  /* --- 결과 출력 ------------------------------------------------------------ */
  for (const item of results) {
    if (item.heading) { console.log(`\n${item.name}`); continue; }
    console.log(`${item.ok ? '  ✓' : '  ✗'} ${item.name}${item.ok || !item.detail ? '' : `\n      → ${item.detail}`}`);
  }
  const total = results.filter(item => !item.heading).length;
  const passed = results.filter(item => !item.heading && item.ok).length;
  console.log(`\n결과: ${passed}/${total} 통과, ${total - passed} 실패`);
  if (passed !== total) process.exitCode = 1;
}

/* 정적 모드 확인용: 실제 렌더는 하지 않고, 스크립트가 요구하는 요소를 흉내낸다. */
function createLooseDocument() {
  const store = new Map();
  const make = selector => {
    const element = {
      selector,
      textContent: '',
      value: '',
      checked: false,
      disabled: false,
      hidden: false,
      _html: '',
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      get innerHTML() { return this._html; },
      set innerHTML(value) { this._html = String(value == null ? '' : value); },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      setAttribute() {},
      getAttribute() { return null; },
      select() {},
      focus() {}
    };
    return element;
  };
  const document = {
    readyState: 'complete',
    querySelector(selector) {
      if (!store.has(selector)) store.set(selector, make(selector));
      return store.get(selector);
    },
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: tag => make(`created:${tag}`)
  };
  return {
    document,
    el: selector => document.querySelector(selector),
    text: selector => document.querySelector(selector).textContent
  };
}

function makeStorage() {
  const memory = {};
  return {
    getItem: key => (Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null),
    setItem: (key, value) => { memory[key] = String(value); },
    removeItem: key => { delete memory[key]; },
    clear: () => Object.keys(memory).forEach(key => delete memory[key])
  };
}

main().catch(error => {
  console.error('\n10단계 테스트 실패:', error && error.stack || error);
  process.exitCode = 1;
});
