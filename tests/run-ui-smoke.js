#!/usr/bin/env node
/* ALL:GOLF 화면 스크립트 스모크 (브라우저 없이 partner/admin 화면 코드를 실제 서버에 붙여 실행)
   사용법: node tests/run-ui-smoke.js   (= npm run test:ui)
   - 원격 환경에서 127.0.0.1 실브라우저 E2E 가 막혀 있어, 화면 스크립트를 최소 DOM 으로 실행하고
     클릭 핸들러를 직접 호출해 로그인·티타임 등록·계정 생성·운영 현황까지 확인한다.
   - 실제 server/index.js 와 실제 fetch 를 쓰며, 결과를 stdout 에 남긴다. */
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

/* --- 최소 DOM --------------------------------------------------------------- */
const ATTR_RE = /([\w:@.-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const TAG_RE = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

function parseAttrs(text) {
  const attrs = {};
  let match;
  ATTR_RE.lastIndex = 0;
  while ((match = ATTR_RE.exec(text))) {
    const key = match[1];
    if (!key || key === '/') continue;
    attrs[key] = match[3] != null ? match[3] : match[4] != null ? match[4] : match[5] != null ? match[5] : '';
  }
  return attrs;
}

function makeClassList(element) {
  const set = new Set();
  /* HTML 의 class 속성도 실제 브라우저처럼 classList 에 반영한다(선택자 검사용). */
  String((element.attrs && element.attrs.class) || '').split(/\s+/).filter(Boolean).forEach(name => set.add(name));
  return {
    add: name => set.add(name),
    remove: name => set.delete(name),
    toggle: (name, force) => { const on = force === undefined ? !set.has(name) : Boolean(force); if (on) set.add(name); else set.delete(name); return on; },
    contains: name => set.has(name)
  };
}

class FakeElement {
  constructor(tag, attrs, document) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.attrs = attrs || {};
    this.id = this.attrs.id || '';
    this.dataset = {};
    Object.keys(this.attrs).forEach(key => {
      if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = this.attrs[key];
    });
    this.value = this.attrs.value != null ? this.attrs.value : '';
    this.checked = Object.prototype.hasOwnProperty.call(this.attrs, 'checked');
    this.disabled = Object.prototype.hasOwnProperty.call(this.attrs, 'disabled');
    this.hidden = Object.prototype.hasOwnProperty.call(this.attrs, 'hidden');
    this.textContent = '';
    this.style = {};
    this.classList = makeClassList(this);
    this.listeners = {};
    this._html = '';
    this._nodes = [];
    this._byId = new Map();
    this._document = document;
    if (this.tagName === 'TEXTAREA') this.value = '';
  }
  get innerHTML() { return this._html; }
  set innerHTML(value) {
    this._html = String(value == null ? '' : value);
    this._nodes = [];
    this._byId = new Map();
    if (this._document) this._document._parseInto(this);
  }
  querySelector(selector) { return querySelector([this], selector); }
  querySelectorAll(selector) { return querySelectorAll([this], selector); }
  addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); }
  removeEventListener() {}
  dispatch(type, event) { (this.listeners[type] || []).forEach(handler => handler(event || { target: this })); }
  click() { const event = { target: this, preventDefault() {}, stopPropagation() {} }; let value; if (typeof this.onclick === 'function') value = this.onclick(event); (this.listeners.click || []).forEach(handler => handler(event)); return value; }
  appendChild() {}
  remove() {}
  setAttribute(key, value) { this.attrs[key] = String(value); }
  removeAttribute(key) { delete this.attrs[key]; if (key === 'hidden') this.hidden = false; }
  focus() {}
  select() {}
  setSelectionRange() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
}

function matches(element, selector) {
  let text = String(selector || '').trim();
  if (!text) return false;
  let checkedOnly = false;
  if (text.endsWith(':checked')) { checkedOnly = true; text = text.slice(0, -8); }
  const parts = text.split(/(?=[.#\[])/).filter(Boolean);
  for (const part of parts) {
    if (part.startsWith('#')) { if (element.id !== part.slice(1)) return false; continue; }
    if (part.startsWith('.')) { if (!element.classList.contains(part.slice(1))) return false; continue; }
    if (part.startsWith('[')) {
      const inner = part.slice(1, -1);
      const equalIndex = inner.indexOf('=');
      if (equalIndex < 0) { if (!Object.prototype.hasOwnProperty.call(element.attrs, inner)) return false; continue; }
      const key = inner.slice(0, equalIndex);
      const value = inner.slice(equalIndex + 1).replace(/^["']|["']$/g, '');
      if ((element.attrs[key] || '') !== value) return false;
      continue;
    }
    if (element.tagName !== part.toUpperCase()) return false;
  }
  if (checkedOnly && !element.checked) return false;
  return true;
}

function collect(roots, selector) {
  const found = [];
  const walk = element => {
    element._nodes.forEach(node => {
      if (!found.includes(node) && matches(node, selector)) found.push(node);
      walk(node);
    });
  };
  roots.forEach(root => { walk(root); if (matches(root, selector)) found.unshift(root); });
  return found;
}
function querySelector(roots, selector) { return collect(roots, selector)[0] || null; }
function querySelectorAll(roots, selector) { return collect(roots, selector); }

function createDom(appId = 'partner-app') {
  const document = {
    readyState: 'complete',
    _roots: [],
    _parseInto(root) {
      const html = root._html;
      /* select 의 선택된 option 값을 먼저 계산한다. */
      const selectValues = {};
      const selectRe = /<select\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/select>/g;
      let selectMatch;
      while ((selectMatch = selectRe.exec(html))) {
        const selectAttrs = parseAttrs(selectMatch[1]);
        if (!selectAttrs.id) continue;
        const optionRe = /<option\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
        let optionMatch;
        let chosen = '';
        while ((optionMatch = optionRe.exec(selectMatch[2]))) {
          const optionAttrs = parseAttrs(optionMatch[1]);
          if (!chosen) chosen = optionAttrs.value != null ? optionAttrs.value : '';
          if (Object.prototype.hasOwnProperty.call(optionAttrs, 'selected')) chosen = optionAttrs.value != null ? optionAttrs.value : '';
        }
        selectValues[selectAttrs.id] = chosen;
      }
      TAG_RE.lastIndex = 0;
      let tagMatch;
      while ((tagMatch = TAG_RE.exec(html))) {
        const tag = tagMatch[1];
        if (tag === 'option' || tag === '/') continue;
        const attrs = parseAttrs(tagMatch[2] || '');
        const element = new FakeElement(tag, attrs, document);
        if (element.tagName === 'SELECT' && element.id && selectValues[element.id] != null) element.value = selectValues[element.id];
        root._nodes.push(element);
        if (element.id) {
          root._byId.set(element.id, element);
          document._byIdAll.set(element.id, element);
        }
      }
    },
    _byIdAll: new Map(),
    querySelector(selector) { return querySelector(this._roots, selector); },
    querySelectorAll(selector) { return querySelectorAll(this._roots, selector); },
    getElementById(id) { return this._byIdAll.get(id) || null; },
    createElement(tag) { return new FakeElement(tag, {}, document); },
    addEventListener() {},
    removeEventListener() {}
  };
  const body = new FakeElement('body', {}, document);
  const app = new FakeElement('div', { id: appId }, document);
  const modal = new FakeElement('div', { id: 'modal' }, document);
  document.body = body;
  document._roots.push(body, app, modal);
  return { document, app, modal };
}


function domText(dom) {
  const chunks = [];
  const walk = element => {
    if (!element) return;
    chunks.push(element._html || '');
    (element._nodes || []).forEach(walk);
  };
  walk(dom.app);
  walk(dom.modal);
  return chunks.join('\n');
}

/* --- 서버 ------------------------------------------------------------------- */
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
      cwd: rootDir, env: { ...process.env, HOST: '127.0.0.1', ALLGOLF_BACKUP: 'off', ...env }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('exit', code => { if (code !== 0) reject(new Error(`서버 종료 code=${code}\n${output}`)); });
    resolve({ child });
  });
}
async function waitHealth(base) {
  for (let index = 0; index < 100; index += 1) {
    try { const response = await fetch(`${base}/api/health`); if (response.ok) return await response.json(); } catch { /* 대기 */ }
    await sleep(150);
  }
  throw new Error('서버가 응답하지 않습니다.');
}
function stopServer(handle) {
  if (!handle || !handle.child || handle.child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => { try { handle.child.kill('SIGKILL'); } catch { /* noop */ } resolve(); }, 6000);
    handle.child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { handle.child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
  });
}

function loadScripts(sandbox, files) {
  const source = files.map(file => `\n/* ===== ${file} ===== */\n${fs.readFileSync(path.join(rootDir, file), 'utf8')}`).join('\n');
  vm.runInContext(source, sandbox, { filename: files.join('+') });
}

async function main() {
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allgolf-ui-'));
  const adminPassword = 'UiSmokePass1';
  const server = await startServer({ PORT: String(port), ALLGOLF_DB_PATH: path.join(tmpDir, 'db.json'), ADMIN_PASSWORD: adminPassword, SESSION_SECRET: 'ui-smoke-secret-0123456789abcdef' });
  const alerts = [];
  let partnerSandbox = null;
  let adminSandbox = null;

  async function api(method, pathname, token, body) {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: response.status, data };
  }

  try {
    await waitHealth(base);
    /* 준비: 제휴 승인 1곳 + 담당자 계정 1개 */
    const adminLogin = await api('POST', '/api/admin/login', null, { password: adminPassword });
    const adminToken = adminLogin.data.token;
    const application = await api('POST', '/api/partner-applications', null, {
      courseMode: 'new', courseName: 'UI 스모크 CC', region: '경기', city: '용인', holes: '18', operationType: 'public',
      managerName: '김담당', managerPhone: '010-1234-5678', managerEmail: 'ui@example.com', weekdayGreenFee: '155000', agree: true
    });
    const approve = await api('POST', `/api/admin/partner-applications/${application.data.application.id}/approve`, adminToken, {});
    const courseId = approve.data.application.newCourseId;
    const accountResponse = await api('POST', '/api/admin/partner-accounts', adminToken, {
      courseId, email: 'ui-partner@example.com', name: 'UI 담당', role: 'manager', password: 'UiPartner1'
    });
    const partnerPassword = accountResponse.data.initialPassword;

    /* --- 골프장 관리자 화면 ------------------------------------------------- */
    section('화면 스모크 · 골프장 관리자(partner/)');
    const dom = createDom('partner-app');
    const sandbox = {
      document: dom.document,
      location: { search: '', href: `${base}/partner/`, origin: base, protocol: 'http:', hash: '', reload() {} },
      navigator: { userAgent: 'node-smoke' },
      localStorage: makeStorage(), sessionStorage: makeStorage(),
      fetch: (input, init) => fetch(String(input).startsWith('http') ? input : `${base}${input}`, init),
      URLSearchParams, URL, AbortController, TextEncoder, TextDecoder,
      setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
      console, alert: message => { alerts.push(String(message)); }, confirm: () => true, prompt: () => '고객 요청',
      CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
      EventSource: undefined,
      scrollTo() {}
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.window.dispatchEvent = event => { (sandbox.window.__listeners[event.type] || []).forEach(handler => handler(event)); };
    sandbox.window.__listeners = {};
    sandbox.window.addEventListener = (type, handler) => { (sandbox.window.__listeners[type] = sandbox.window.__listeners[type] || []).push(handler); };
    sandbox.window.removeEventListener = () => {};
    sandbox.ALL_GOLF_SERVER_MODE = true;
    vm.createContext(sandbox);
    partnerSandbox = sandbox;
    loadScripts(sandbox, [
      'data/national-golf-courses.js', 'data/golf-courses.js', 'data/demo-teetimes.js',
      'data/partner-application.js', 'data/shared-store.js', 'data/api-client.js', 'data/partner-sync.js', 'partner/partner.js'
    ]);
    await sleep(600);
    ok('partner 화면이 로그인 화면으로 시작', domText(dom).includes('골프장 관리자 로그인'), domText(dom).slice(0, 120));
    ok('partner 화면에 서버 연동 배지', domText(dom).includes('서버 연동'));
    dom.document.querySelector('#partner-email').value = 'ui-partner@example.com';
    dom.document.querySelector('#partner-password').value = partnerPassword;
    const loginButton = dom.document.querySelector('#partner-login');
    if (loginButton && typeof loginButton.onclick === 'function') loginButton.click();
    await sleep(900);
    ok('partner 로그인 후 운영 현황 렌더', domText(dom).includes('운영 현황') && domText(dom).includes('UI 스모크 CC'), domText(dom).slice(0, 160));
    ok('partner 화면에 담당자 이름 표시', domText(dom).includes('UI 담당'));
    dom.document.querySelector('[data-view="tees"]').click();
    await sleep(700);
    ok('티타임 관리 화면 렌더', domText(dom).includes('티타임 관리') && domText(dom).includes('+ 티타임 추가'));
    dom.document.querySelector('#server-new-tee').click();
    ok('티타임 추가 모달 열림', domText(dom).includes('티타임 추가'));
    /* 화면의 기본 날짜(오늘)에 등록해 목록 표시까지 확인한다. */
    const kstNow = new Date(Date.now() + 9 * 3600000);
    const iso = `${kstNow.getUTCFullYear()}-${String(kstNow.getUTCMonth() + 1).padStart(2, '0')}-${String(kstNow.getUTCDate()).padStart(2, '0')}`;
    dom.document.querySelector('#st-date').value = iso;
    dom.document.querySelector('#st-time').value = '07:40';
    dom.document.querySelector('#st-session').value = '1부';
    dom.document.querySelector('#st-capacity').value = '2';
    dom.document.querySelector('#st-max').value = '4';
    dom.document.querySelector('#st-price').value = '155000';
    dom.document.querySelector('#st-save').click();
    await sleep(1500);
    ok('티타임 저장 후 목록에 시간 표시', domText(dom).includes('07:40'), domText(dom).slice(0, 200));
    const savedTees = await api('GET', `/api/partner/tee-times?date=${iso}`, partnerSandbox.ALL_GOLF_API.getPartnerToken());
    eq('화면에서 등록한 티타임이 서버에 저장', savedTees.data.count, 1);

    dom.document.querySelector('[data-view="rates"]').click();
    await sleep(700);
    ok('요금 설정 화면 렌더', domText(dom).includes('기본 그린피') && domText(dom).includes('3인 1인 그린피'));
    dom.document.querySelector('#sr-three').value = '175000';
    dom.document.querySelector('#server-save-rates').click();
    await sleep(900);
    const rates = await api('GET', '/api/partner/rates', partnerSandbox.ALL_GOLF_API.getPartnerToken());
    eq('화면에서 저장한 3인 그린피가 서버에 반영', rates.data.rates.threePlayerGreenFee, 175000);

    /* 8단계: 서버 예약이 파트너 화면에 표시되고 취소 처리까지 동작한다. */
    const hold = await api('POST', '/api/public/holds', null, { courseId, date: iso, teeTimeId: savedTees.data.teeTimes[0].id, people: 4, sessionId: 'ui-hold' });
    eq('화면 검증용 Hold 생성', hold.status, 201);
    const createdReservation = await api('POST', '/api/public/reservations', null, {
      courseId, date: iso, teeTimeId: savedTees.data.teeTimes[0].id, people: 4,
      booker: 'UI고객', phone: '010-7777-8888', companions: ['UI동반'], holdId: hold.data.hold.id, sessionId: 'ui-hold'
    });
    eq('화면 검증용 서버 예약 생성', createdReservation.status, 201);
    const createdNumber = createdReservation.data.reservation.number;
    dom.document.querySelector('[data-view="bookings"]').click();
    await sleep(1200);
    ok('파트너 예약 관리에 서버 예약 표시', domText(dom).includes(createdNumber) && domText(dom).includes('UI고객'), domText(dom).slice(0, 220));
    ok('파트너 예약 통계 표시', domText(dom).includes('확정 1건') || domText(dom).includes('전체 예약'), domText(dom).slice(0, 220));
    dom.document.querySelector('[data-server-reservation-status][data-server-status="cancelled"]')?.click();
    await sleep(1500);
    const partnerReservationsAfter = await api('GET', '/api/partner/reservations', partnerSandbox.ALL_GOLF_API.getPartnerToken());
    ok('파트너 화면에서 예약 취소 반영', (partnerReservationsAfter.data.reservations || []).some(item => item.number === createdNumber && item.status === 'cancelled'), JSON.stringify(partnerReservationsAfter.data.reservations || []).slice(0, 200));
    const inventoryAfterCancel = await api('GET', `/api/public/inventory?date=${iso}&courseId=${encodeURIComponent(courseId)}`);
    eq('취소 후 잔여 팀 복구', inventoryAfterCancel.data.courses[0].teeTimes[0].remaining, 2);

    /* 9단계: 정산서를 만들고 파트너 화면에서 정산·알림 로그를 확인한다. */
    const settlementForUi = await api('POST', '/api/admin/settlements', adminToken, { courseId, from: iso, to: iso });
    eq('화면 검증용 정산서 생성', settlementForUi.status, 201);
    const settlementNumberForUi = settlementForUi.data.settlement.number;
    dom.document.querySelector('[data-view="settlements"]').click();
    await sleep(1200);
    ok('파트너 정산 내역 화면 렌더', domText(dom).includes('정산 내역') && domText(dom).includes('수수료율'), domText(dom).slice(0, 220));
    ok('파트너 정산서 번호 표시', domText(dom).includes(settlementNumberForUi), domText(dom).slice(0, 300));
    ok('파트너 정산 상태 · 조회 전용 안내', domText(dom).includes('작성 중') && domText(dom).includes('본사 관리자만'), domText(dom).slice(0, 300));
    dom.document.querySelector('[data-view="notifications"]').click();
    await sleep(1200);
    ok('파트너 알림 로그 화면 렌더', domText(dom).includes('운영 알림 로그') && domText(dom).includes('시연용 알림 로그'), domText(dom).slice(0, 260));
    ok('파트너 알림에 예약 확정 기록', domText(dom).includes('예약 확정 알림') && domText(dom).includes('시연 발송 기록'), domText(dom).slice(0, 320));

    dom.document.querySelector('#logout').click();
    await sleep(600);
    ok('로그아웃 후 로그인 화면', domText(dom).includes('골프장 관리자 로그인'));

    /* --- 본사 관리자 화면 --------------------------------------------------- */
    section('화면 스모크 · 본사 관리자(admin/)');
    const adminDom = createDom('admin-app');
    const adminBox = {
      document: adminDom.document,
      location: { search: '', href: `${base}/admin/`, origin: base, protocol: 'http:', hash: '', reload() {} },
      navigator: { userAgent: 'node-smoke' },
      localStorage: makeStorage(), sessionStorage: makeStorage(),
      fetch: (input, init) => fetch(String(input).startsWith('http') ? input : `${base}${input}`, init),
      URLSearchParams, URL, AbortController,
      setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
      console, alert: message => { alerts.push(String(message)); }, confirm: () => true, prompt: () => '고객 요청',
      CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
      EventSource: undefined,
      scrollTo() {}
    };
    adminBox.window = adminBox;
    adminBox.self = adminBox;
    adminBox.window.__listeners = {};
    adminBox.window.dispatchEvent = event => { (adminBox.window.__listeners[event.type] || []).forEach(handler => handler(event)); };
    adminBox.window.addEventListener = (type, handler) => { (adminBox.window.__listeners[type] = adminBox.window.__listeners[type] || []).push(handler); };
    adminBox.window.removeEventListener = () => {};
    adminBox.ALL_GOLF_SERVER_MODE = true;
    vm.createContext(adminBox);
    adminSandbox = adminBox;
    loadScripts(adminBox, [
      'data/national-golf-courses.js', 'data/golf-courses.js', 'data/demo-teetimes.js',
      'data/partner-application.js', 'data/shared-store.js', 'admin/national-dashboard.js', 'demo-transfer.js',
      'data/api-client.js', 'data/partner-sync.js', 'admin/admin.js'
    ]);
    await sleep(800);
    ok('admin 화면이 서버 로그인으로 시작', domText(adminDom).includes('본사 관리자 로그인'), domText(adminDom).slice(0, 140));
    adminDom.document.querySelector('#email').value = 'admin@allgolf.demo';
    adminDom.document.querySelector('#password').value = adminPassword;
    adminDom.document.querySelector('#login').click();
    await sleep(1000);
    ok('admin 로그인 후 대시보드 렌더', domText(adminDom).includes('전국 운영 대시보드'), domText(adminDom).slice(0, 160));

    adminDom.document.querySelector('[data-page="accounts"]').click();
    await sleep(1500);
    ok('제휴 계정 관리 화면에 기존 계정 표시', domText(adminDom).includes('ui-partner@example.com'), domText(adminDom).slice(0, 200));
    adminDom.document.querySelector('#new-partner-account').click();
    await sleep(200);
    ok('계정 생성 모달 열림', domText(adminDom).includes('골프장 담당자 계정 생성'));
    adminDom.document.querySelector('#acc-name').value = '새 담당';
    adminDom.document.querySelector('#acc-email').value = 'new-ui@example.com';
    adminDom.document.querySelector('#acc-role').value = 'viewer';
    adminDom.document.querySelector('#acc-password').value = 'NewUiPass1';
    adminDom.document.querySelector('#acc-save').click();
    await sleep(900);
    ok('계정 생성 후 초기 비밀번호 1회 표시', domText(adminDom).includes('NewUiPass1'), adminDom.modal.innerHTML.slice(0, 200));
    adminDom.document.querySelector('#acc-done').click();
    await sleep(1200);
    ok('계정 목록에 새 계정 반영', domText(adminDom).includes('new-ui@example.com'), domText(adminDom).slice(0, 200));

    adminDom.document.querySelector('[data-page="operations"]').click();
    await sleep(1500);
    ok('골프장 운영 현황 렌더', domText(adminDom).includes('UI 스모크 CC') && domText(adminDom).includes('등록 티타임'), domText(adminDom).slice(0, 200));
    ok('운영 현황에 화면에서 등록한 티타임 1건', domText(adminDom).includes('07:40') || domText(adminDom).includes('1건'));

    adminDom.document.querySelector('[data-page="reservations"]').click();
    await sleep(1600);
    ok('본사 전체 예약 화면에 서버 예약 표시', domText(adminDom).includes(createdNumber) && domText(adminDom).includes('UI고객'), domText(adminDom).slice(0, 220));
    ok('본사 예약 화면에 예약 통계', domText(adminDom).includes('전체 예약'), domText(adminDom).slice(0, 200));
    adminDom.document.querySelector('[data-admin-reservation]')?.click();
    await sleep(900);
    ok('본사 예약 상세 모달 열림', domText(adminDom).includes('예약 상세') && domText(adminDom).includes('예약자'), adminDom.modal.innerHTML.slice(0, 200));
    adminDom.document.querySelector('[data-close]')?.click();

    adminDom.document.querySelector('[data-page="audit"]').click();
    await sleep(1500);
    ok('감사 로그에 담당자 로그인 기록', domText(adminDom).includes('담당자 로그인'), domText(adminDom).slice(0, 200));
    ok('감사 로그에 티타임 등록 기록', domText(adminDom).includes('티타임 등록'));
    ok('감사 로그에 예약 확정 기록', domText(adminDom).includes('예약 확정'), domText(adminDom).slice(0, 200));
    ok('감사 로그에 예약 취소 기록', domText(adminDom).includes('예약 취소'));

    /* 9단계: 운영 통계·제휴 성과 화면 */
    adminDom.document.querySelector('[data-page="analytics"]').click();
    await sleep(1600);
    ok('운영 통계 화면 렌더', domText(adminDom).includes('운영 통계·제휴 성과') && domText(adminDom).includes('기간별 운영 통계'), domText(adminDom).slice(0, 240));
    ok('통계 KPI(GMV·노쇼율) 표시', domText(adminDom).includes('GMV') && domText(adminDom).includes('노쇼율'), domText(adminDom).slice(0, 300));
    ok('통계에 골프장·수수료율 표시', domText(adminDom).includes('UI 스모크 CC') && domText(adminDom).includes('8%'), domText(adminDom).slice(0, 400));
    ok('제휴 성과(승인 전환율) 표시', domText(adminDom).includes('승인 전환율') && domText(adminDom).includes('제휴 신청'));
    adminDom.document.querySelector('[data-analytics-period="today"]').click();
    await sleep(1600);
    ok('기간(오늘) 전환 후 통계 유지', domText(adminDom).includes('기간별 운영 통계') && domText(adminDom).includes('GMV'), domText(adminDom).slice(0, 260));

    /* 9단계: 정산·수수료 관리 화면 */
    adminDom.document.querySelector('[data-page="settlements"]').click();
    await sleep(1800);
    ok('정산·수수료 관리 화면 렌더', domText(adminDom).includes('정산서 생성·상태 전이') && domText(adminDom).includes('골프장별 수수료율'), domText(adminDom).slice(0, 260));
    ok('정산 목록에 기존 정산서 표시', domText(adminDom).includes(settlementNumberForUi) && domText(adminDom).includes('작성 중'), domText(adminDom).slice(0, 400));
    const rateField = adminDom.document.querySelector(`#rate-${courseId}`);
    ok('수수료율 입력란 표시', Boolean(rateField));
    if (rateField) rateField.value = '9';
    adminDom.document.querySelector(`[data-rate-save="${courseId}"]`)?.click();
    await sleep(1400);
    const commissionAfterUi = await api('GET', '/api/admin/commissions', adminToken);
    const commissionRowUi = (commissionAfterUi.data.courses || []).find(item => item.courseId === courseId);
    eq('화면에서 저장한 수수료율 9% 반영', commissionRowUi && commissionRowUi.ratePercent, 9);
    adminDom.document.querySelector('#settlement-from').value = '2026-01-01';
    adminDom.document.querySelector('#settlement-to').value = '2026-01-31';
    adminDom.document.querySelector('#create-settlement').click();
    await sleep(1600);
    const settlementsAfterUi = await api('GET', '/api/admin/settlements', adminToken);
    const createdByUi = (settlementsAfterUi.data.settlements || []).find(item => item.period.from === '2026-01-01' && item.period.to === '2026-01-31');
    ok('화면에서 정산서 생성', Boolean(createdByUi), JSON.stringify((settlementsAfterUi.data.settlements || []).map(item => item.number)));
    ok('생성 알림 문구 표시', alerts.some(message => message.includes('정산서를 만들었습니다')), alerts.join(' | '));
    const pendingButton = adminDom.document.querySelector('[data-settlement-next="PENDING"]');
    if (pendingButton) pendingButton.click();
    await sleep(1500);
    const pendingSettlements = await api('GET', '/api/admin/settlements?status=PENDING', adminToken);
    ok('화면에서 DRAFT→PENDING 전이', (pendingSettlements.data.settlements || []).length >= 1, JSON.stringify(pendingSettlements.data.byStatus || {}));
    ok('스모크 중 예기치 않은 alert 없음', alerts.filter(message => !message.includes('건 등록') && !message.includes('저장되었습니다') && !message.includes('예약을 취소했습니다') && !message.includes('수수료율이') && !message.includes('정산서를 만들었습니다')).length === 0, alerts.join(' | '));

    /* --- 10단계: 시연 허브(서버 연동) ---------------------------------------- */
    section('화면 스모크 · 10단계 시연 허브(서버 연동)');
    const hubHtml = (() => {
      const html = fs.readFileSync(path.join(rootDir, 'demo', 'index.html'), 'utf8');
      const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      return body ? body[1].replace(/<script[\s\S]*?<\/script>/gi, '') : '';
    })();
    const hubDom = createDom('hub-root');
    hubDom.app.innerHTML = hubHtml;
    const hubBox = {
      document: hubDom.document,
      location: { search: '', href: `${base}/demo/`, origin: base, protocol: 'http:', hash: '', reload() {} },
      navigator: { userAgent: 'node-smoke' },
      localStorage: makeStorage(), sessionStorage: makeStorage(),
      fetch: (input, init) => fetch(String(input).startsWith('http') ? input : `${base}${input}`, init),
      URLSearchParams, URL, AbortController, TextEncoder, TextDecoder,
      setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
      console, alert: message => { alerts.push(String(message)); }, confirm: () => true,
      CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
      EventSource: undefined,
      Intl, Math, JSON, Number, String, Object, Array, Date,
      scrollTo() {}
    };
    hubBox.window = hubBox;
    hubBox.self = hubBox;
    hubBox.window.__listeners = {};
    hubBox.window.dispatchEvent = event => { (hubBox.window.__listeners[event.type] || []).forEach(handler => handler(event)); };
    hubBox.window.addEventListener = (type, handler) => { (hubBox.window.__listeners[type] = hubBox.window.__listeners[type] || []).push(handler); };
    hubBox.window.removeEventListener = () => {};
    hubBox.ALL_GOLF_SERVER_MODE = true;
    vm.createContext(hubBox);
    loadScripts(hubBox, ['data/national-golf-courses.js', 'data/golf-courses.js', 'data/demo-teetimes.js', 'data/business-simulator.js', 'data/api-client.js', 'demo/demo.js']);
    await sleep(1800);
    const hubText = () => domText(hubDom);
    const hubEl = selector => hubDom.document.querySelector(selector);
    ok('허브가 서버 연동으로 표시', String(hubEl('#mode-chip') && hubEl('#mode-chip').textContent).includes('서버 연동'), hubEl('#mode-chip') && hubEl('#mode-chip').textContent);
    eq('전국 골프장 509곳 표시', hubEl('#kpi-total') && hubEl('#kpi-total').textContent, '509곳');
    eq('시연 예약 68곳 표시', hubEl('#kpi-partner') && hubEl('#kpi-partner').textContent, '68곳');
    eq('정보 제공 441곳 표시', hubEl('#kpi-info') && hubEl('#kpi-info').textContent, '441곳');
    ok('투자자 가이드 7단계 렌더', hubDom.document.querySelectorAll('.step').length === 7, hubDom.document.querySelectorAll('.step').length);
    ok('투자자 진행률 표시', String(hubEl('#mode-progress') && hubEl('#mode-progress').textContent).includes('0 / 7 단계 완료'), hubEl('#mode-progress') && hubEl('#mode-progress').textContent);
    const firstCheck = hubEl('[data-check="invest-1"]');
    if (firstCheck) { firstCheck.checked = true; firstCheck.onchange && firstCheck.onchange({ target: firstCheck }); }
    await sleep(200);
    ok('체크 시 진행률 갱신', String(hubEl('#mode-progress') && hubEl('#mode-progress').textContent).includes('1 / 7 단계 완료'), hubEl('#mode-progress') && hubEl('#mode-progress').textContent);
    ok('체크 상태가 저장됨', String(hubBox.localStorage.getItem('allGolfStage10Checklist') || '').includes('invest-1'), hubBox.localStorage.getItem('allGolfStage10Checklist'));
    const partnerModeButton = hubDom.document.querySelector('[data-mode="partner"]');
    if (partnerModeButton) partnerModeButton.click();
    await sleep(200);
    ok('제휴 모드 6단계로 전환', hubDom.document.querySelectorAll('.step').length === 6 && hubText().includes('제휴 신청 접수'), hubEl('#mode-progress') && hubEl('#mode-progress').textContent);

    /* 사업성 시뮬레이터 */
    const coursesField = hubEl('[data-sim="partnerCourses"]');
    ok('시뮬레이터 입력 5개', hubDom.document.querySelectorAll('[data-sim]').length === 5, hubDom.document.querySelectorAll('[data-sim]').length);
    eq('기본 계산 월 수수료', hubEl('#sim-fee-month') && hubEl('#sim-fee-month').textContent, '135,782,400원');
    if (coursesField) { coursesField.value = '100'; coursesField.oninput && coursesField.oninput({ target: coursesField }); }
    await sleep(150);
    ok('입력 변경 시 즉시 재계산', hubEl('#sim-fee-month') && hubEl('#sim-fee-month').textContent !== '135,782,400원', hubEl('#sim-fee-month') && hubEl('#sim-fee-month').textContent);
    const summaryBox = hubEl('#sim-summary');
    ok('복사용 요약에 가정·면책 포함', Boolean(summaryBox) && summaryBox.value.includes('가정') && summaryBox.value.includes('실제 실적이 아닌'), summaryBox && summaryBox.value.slice(0, 80));
    ok('화면에 면책 문구 표시', hubText().includes('가정 기반 시연 계산치'), hubEl('#sim-disclaimer') && hubEl('#sim-disclaimer').textContent);
    const copyButton = hubEl('#sim-copy');
    if (copyButton) copyButton.click();
    await sleep(200);
    ok('복사 버튼 동작(클립보드 없으면 안내)', String(hubEl('#sim-copy-status') && hubEl('#sim-copy-status').textContent).length > 0, hubEl('#sim-copy-status') && hubEl('#sim-copy-status').textContent);

    /* 안전 가드: 문구·체크 없이는 실행되지 않는다. */
    const manualAccountsBefore = await api('GET', '/api/admin/partner-accounts', adminToken);
    const manualReservationsBefore = await api('GET', '/api/admin/reservations', adminToken);
    const manualAccountCount = (manualAccountsBefore.data.accounts || []).length;
    const manualReservationCount = (manualReservationsBefore.data.reservations || []).length;
    eq('허브 초기화 버튼 잠김', hubEl('#btn-reset') && hubEl('#btn-reset').disabled, true);
    eq('허브 준비 버튼 잠김', hubEl('#btn-stage') && hubEl('#btn-stage').disabled, true);
    if (hubEl('#btn-reset')) hubEl('#btn-reset').click();
    await sleep(300);
    const statusAfterGuardClick = await api('GET', '/api/demo/stage10');
    eq('가드 없이 클릭해도 데이터 변화 없음', statusAfterGuardClick.data.staged, false);

    /* 관리자 확인 → 준비 */
    hubEl('#admin-password').value = adminPassword;
    hubEl('#admin-login').click();
    await sleep(900);
    ok('허브 관리자 확인 성공', String(hubEl('#admin-state') && hubEl('#admin-state').textContent).includes('확인됨'), hubEl('#admin-state') && hubEl('#admin-state').textContent);
    hubEl('#stage-confirm').value = 'STAGE-STAGE10-DEMO';
    hubEl('#stage-confirm').oninput && hubEl('#stage-confirm').oninput({ target: hubEl('#stage-confirm') });
    eq('문구 입력 후 준비 버튼 활성화', hubEl('#btn-stage') && hubEl('#btn-stage').disabled, false);
    hubEl('#btn-stage').click();
    await sleep(3000);
    const stagedStatus = await api('GET', '/api/demo/stage10');
    ok('허브에서 시연 데이터 준비', stagedStatus.data.staged === true && stagedStatus.data.demo.teeTimes === 84, JSON.stringify(stagedStatus.data.demo));
    ok('준비 결과 문구 표시', String(hubEl('#reset-result') && hubEl('#reset-result').textContent).includes('시연 데이터를 준비했습니다'), hubEl('#reset-result') && hubEl('#reset-result').textContent);
    const healthAfterStage = await api('GET', '/api/health');
    ok('티타임이 서버 DB에 반영(84건 이상)', healthAfterStage.data.db.teeTimes >= 84, healthAfterStage.data.db.teeTimes);
    ok('일반 계정 유지(준비 단계)', (await api('GET', '/api/admin/partner-accounts', adminToken)).data.accounts.length >= manualAccountCount);

    /* 초기화: 문구 + 체크 후에만 */
    hubEl('#reset-confirm').value = 'RESET-STAGE10-DEMO';
    hubEl('#reset-confirm').oninput && hubEl('#reset-confirm').oninput({ target: hubEl('#reset-confirm') });
    eq('체크 없으면 초기화 버튼 잠김', hubEl('#btn-reset') && hubEl('#btn-reset').disabled, true);
    hubEl('#reset-guard').checked = true;
    hubEl('#reset-guard').onchange && hubEl('#reset-guard').onchange({ target: hubEl('#reset-guard') });
    eq('문구+체크 후 초기화 버튼 활성화', hubEl('#btn-reset') && hubEl('#btn-reset').disabled, false);
    hubEl('#btn-reset').click();
    await sleep(3000);
    const resetStatus = await api('GET', '/api/demo/stage10');
    eq('허브에서 시연 데이터 초기화', resetStatus.data.staged, false);
    eq('초기화 후 시연 티타임 0', resetStatus.data.demo.teeTimes, 0);
    eq('초기화 후 시연 예약 0', resetStatus.data.demo.reservations, 0);
    ok('초기화 결과 문구 표시', String(hubEl('#reset-result') && hubEl('#reset-result').textContent).includes('초기 시연 상태로 되돌렸습니다'), hubEl('#reset-result') && hubEl('#reset-result').textContent);
    const manualAccountsAfter = await api('GET', '/api/admin/partner-accounts', adminToken);
    const manualReservationsAfter = await api('GET', '/api/admin/reservations', adminToken);
    eq('초기화 후 일반 담당자 계정 보존', (manualAccountsAfter.data.accounts || []).length, manualAccountCount);
    eq('초기화 후 일반 예약 보존', (manualReservationsAfter.data.reservations || []).length, manualReservationCount);

    /* --- 정적 모드(서버 없음): 9단계 화면도 요청 0건 ------------------------ */
    section('화면 스모크 · 정적 모드 9단계 페이지(API 요청 0건)');
    const staticDom = createDom('admin-app');
    const staticCalls = { count: 0 };
    const staticBox = {
      document: staticDom.document,
      location: { search: '', href: 'https://neved12.github.io/all-golf-test/admin/', origin: 'https://neved12.github.io', protocol: 'https:', hash: '', reload() {} },
      navigator: { userAgent: 'node-smoke' },
      localStorage: makeStorage(), sessionStorage: makeStorage(),
      fetch: () => { staticCalls.count += 1; return Promise.reject(new Error('no network')); },
      URLSearchParams, URL, AbortController,
      setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
      console, alert: message => { alerts.push(String(message)); }, confirm: () => false, prompt: () => '',
      CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
      EventSource: undefined,
      scrollTo() {}
    };
    staticBox.window = staticBox;
    staticBox.self = staticBox;
    staticBox.window.__listeners = {};
    staticBox.window.dispatchEvent = event => { (staticBox.window.__listeners[event.type] || []).forEach(handler => handler(event)); };
    staticBox.window.addEventListener = (type, handler) => { (staticBox.window.__listeners[type] = staticBox.window.__listeners[type] || []).push(handler); };
    staticBox.window.removeEventListener = () => {};
    staticBox.localStorage.setItem('allGolfAdminAuth', 'true');
    vm.createContext(staticBox);
    loadScripts(staticBox, [
      'data/national-golf-courses.js', 'data/golf-courses.js', 'data/demo-teetimes.js',
      'data/partner-application.js', 'data/shared-store.js', 'admin/national-dashboard.js', 'demo-transfer.js',
      'data/api-client.js', 'data/partner-sync.js', 'admin/admin.js'
    ]);
    await sleep(700);
    ok('정적 모드 관리자 화면 렌더', domText(staticDom).includes('전국 운영 대시보드') && domText(staticDom).includes('정적 시연'), domText(staticDom).slice(0, 160));
    staticDom.document.querySelector('[data-page="analytics"]').click();
    await sleep(400);
    ok('정적 모드 운영 통계 안내', domText(staticDom).includes('정적 시연 모드에서는 서버 운영 통계가 없습니다'), domText(staticDom).slice(-260));
    staticDom.document.querySelector('[data-page="settlements"]').click();
    await sleep(400);
    ok('정적 모드 정산 화면 안내', domText(staticDom).includes('정적 시연 모드의 예시 표'), domText(staticDom).slice(-260));
    eq('정적 모드에서 API 요청 0건', staticCalls.count, 0);

    /* 10단계: 정적 배포(GitHub Pages)에서 시연 허브도 요청 0건으로 렌더된다. */
    section('화면 스모크 · 10단계 시연 허브(정적 배포, API 요청 0건)');
    const hubStaticDom = createDom('hub-root');
    hubStaticDom.app.innerHTML = hubHtml;
    const hubStaticCalls = { count: 0 };
    const hubStaticBox = {
      document: hubStaticDom.document,
      location: { search: '', href: 'https://neved12.github.io/all-golf-test/demo/', origin: 'https://neved12.github.io', protocol: 'https:', hash: '', reload() {} },
      navigator: { userAgent: 'node-smoke' },
      localStorage: makeStorage(), sessionStorage: makeStorage(),
      fetch: () => { hubStaticCalls.count += 1; return Promise.reject(new Error('no network')); },
      URLSearchParams, URL, AbortController,
      setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
      console, alert: () => {}, confirm: () => false,
      CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
      EventSource: undefined,
      Intl, Math, JSON, Number, String, Object, Array, Date,
      scrollTo() {}
    };
    hubStaticBox.window = hubStaticBox;
    hubStaticBox.self = hubStaticBox;
    hubStaticBox.window.__listeners = {};
    hubStaticBox.window.dispatchEvent = event => { (hubStaticBox.window.__listeners[event.type] || []).forEach(handler => handler(event)); };
    hubStaticBox.window.addEventListener = (type, handler) => { (hubStaticBox.window.__listeners[type] = hubStaticBox.window.__listeners[type] || []).push(handler); };
    hubStaticBox.window.removeEventListener = () => {};
    vm.createContext(hubStaticBox);
    loadScripts(hubStaticBox, ['data/national-golf-courses.js', 'data/golf-courses.js', 'data/demo-teetimes.js', 'data/business-simulator.js', 'data/api-client.js', 'demo/demo.js']);
    await sleep(900);
    const hubStaticText = domText(hubStaticDom);
    ok('정적 허브 렌더(정적 시연 표시)', String(hubStaticDom.document.querySelector('#mode-chip') && hubStaticDom.document.querySelector('#mode-chip').textContent).includes('정적 시연') && hubStaticText.includes('사업성 시뮬레이터'), hubStaticDom.document.querySelector('#mode-chip') && hubStaticDom.document.querySelector('#mode-chip').textContent);
    eq('정적 허브 카탈로그 509곳', hubStaticDom.document.querySelector('#kpi-total') && hubStaticDom.document.querySelector('#kpi-total').textContent, '509곳');
    eq('정적 허브 시뮬레이터 계산', hubStaticDom.document.querySelector('#sim-fee-month') && hubStaticDom.document.querySelector('#sim-fee-month').textContent, '135,782,400원');
    ok('정적 허브 준비 버튼 잠김(서버 없음)', hubStaticDom.document.querySelector('#btn-stage') && hubStaticDom.document.querySelector('#btn-stage').disabled === true);
    eq('정적 허브 API 요청 0건', hubStaticCalls.count, 0);
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
  console.error('\n화면 스모크 실패:', error && error.stack || error);
  process.exitCode = 1;
});
