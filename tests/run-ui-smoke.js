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
    ok('스모크 중 예기치 않은 alert 없음', alerts.filter(message => !message.includes('건 등록') && !message.includes('저장되었습니다') && !message.includes('예약을 취소했습니다')).length === 0, alerts.join(' | '));
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
