/* ALL:GOLF 서버 동기화 계층 (6단계)
   - 서버 연동 모드에서 승인된 제휴 골프장 목록을 받아 localStorage 캐시에 저장한다.
   - 캐시는 즉시 읽을 수 있어서 사용자 앱/골프장 관리자 화면이 새로고침 없이 반영된다.
   - 서버가 바뀐 내용을 폴링(5초) + SSE 로 감지하고 `allgolf:partnerschange` 이벤트를 보낸다.
   - 정적 시연 모드에서는 요청을 보내지 않고 캐시만 사용한다. */
(function () {
  'use strict';

  const KEY = 'allGolfServerPartnerCoursesV1';
  const SLOT_TIMES = ['06:52', '07:38', '08:24', '12:41', '13:27'];
  const POLL_MS = 5000;
  const listeners = new Set();
  let started = false;
  let pollTimer = null;
  let sse = null;
  let lastSyncAt = null;

  const API = window.ALL_GOLF_API || null;

  function readCache() {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (parsed && Array.isArray(parsed.courses)) return parsed;
    } catch { /* 손상된 캐시는 무시하고 서버에서 다시 받는다 */ }
    return { ok: true, courses: [], updatedAt: null, savedAt: null };
  }
  let payload = readCache();

  const text = value => String(value == null ? '' : value).trim();
  const baseFee = course => {
    const configured = Number(course && course.greenFee && course.greenFee.weekday);
    return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 150000;
  };

  function toCourse(record) {
    const green = record.greenFee || {};
    const approvedAt = record.approvedAt || null;
    return {
      id: record.id,
      name: text(record.name),
      region: text(record.region),
      city: text(record.city),
      area: text(record.city),
      address: text(record.address) || null,
      operationType: ['public', 'membership', 'mixed'].includes(record.operationType) ? record.operationType : 'public',
      type: ['public', 'membership', 'mixed'].includes(record.operationType) ? record.operationType : 'public',
      membershipType: null,
      holes: Number(record.holes) || null,
      courses: [],
      phone: text(record.phone) || null,
      officialWebsite: text(record.website) || null,
      officialBookingUrl: null,
      website: text(record.website) || null,
      operatingStatus: 'active',
      verified: false,
      verification: {},
      sources: [],
      source: null,
      sourceName: 'ALL:GOLF 제휴 신청 승인(서버)',
      sourceAsOf: approvedAt ? String(approvedAt).slice(0, 10) : null,
      lastVerified: approvedAt ? String(approvedAt).slice(0, 10) : null,
      lastUpdated: approvedAt ? String(approvedAt).slice(0, 7) : null,
      greenFee: green.weekday == null ? null : Number(green.weekday),
      verifiedGreenFee: null,
      cartFee: green.cart == null ? null : Number(green.cart),
      caddieFee: green.caddie == null ? null : Number(green.caddie),
      bookingType: 'demo',
      bookingStatus: 'demo',
      partner: true,
      partnered: true,
      latitude: null,
      longitude: null,
      description: '골프장 제휴 신청 승인으로 등록된 시연용 골프장입니다.',
      amenities: [],
      cancellationPolicy: null,
      dataMode: 'demo',
      partnerApplicationId: record.partnerApplicationId || null
    };
  }

  function toDemo(record) {
    const green = record.greenFee || {};
    const base = baseFee(record);
    const demoTeeTimes = SLOT_TIMES.map((time, index) => ({
      time,
      price: base + (index === 2 ? 10000 : index === 4 ? -5000 : 0),
      remaining: 1 + (index % 3),
      special: false
    }));
    return {
      dataMode: 'demo',
      generatedDemo: true,
      partnerDemo: true,
      demoGreenFee: base,
      demoTeeTimes,
      demoCartFee: Number(green.cart) > 0 ? Number(green.cart) : 100000,
      demoCaddieFee: Number(green.caddie) > 0 ? Number(green.caddie) : 150000,
      demoDeposit: 30000,
      demoNoCaddie: false,
      demoDeal: false,
      demoThreePlayerSurcharge: 10000,
      demoNotice: '시연용 예약이며 실제 골프장 예약이 아닙니다'
    };
  }

  const entries = () => (payload.courses || [])
    .filter(record => record && record.source === 'new' && record.id)
    .map(record => ({ course: toCourse(record), demo: toDemo(record) }));

  const approvedIds = () => new Set((payload.courses || []).map(record => String(record.id)));

  function entryFor(courseId) {
    const record = (payload.courses || []).find(item => String(item.id) === String(courseId));
    return record ? { course: toCourse(record), demo: toDemo(record), record } : null;
  }

  /* 서버와 같은 규칙으로 날짜별 시연 티타임을 만든다(서버가 꺼져도 화면이 유지된다). */
  function timesFor(courseId, date) {
    const found = entryFor(courseId);
    if (!found) return null;
    const base = found.demo.demoGreenFee;
    const weekend = [0, 6].includes(new Date(`${date}T00:00:00`).getDay());
    const seed = [...String(courseId)].reduce((sum, char) => sum + char.charCodeAt(0), 0)
      + [...String(date || '')].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const price0 = base + (weekend ? 20000 : 0);
    return SLOT_TIMES.map((time, index) => ({
      time,
      price: price0 + (index === 2 ? 10000 : index === 4 ? -5000 : 0),
      remaining: 1 + ((seed + index) % 3),
      special: false,
      dataMode: 'demo'
    }));
  }

  function notify(detail) {
    listeners.forEach(listener => { try { listener(detail); } catch { /* noop */ } });
    try {
      window.dispatchEvent(new CustomEvent('allgolf:partnerschange', { detail }));
    } catch { /* noop */ }
  }

  function applyServerCourses(next) {
    if (!next || !Array.isArray(next.courses)) return false;
    const normalized = {
      ok: true,
      courses: next.courses.filter(item => item && item.id && item.name),
      updatedAt: next.updatedAt || null,
      savedAt: new Date().toISOString()
    };
    const before = JSON.stringify(payload.courses || []);
    payload = normalized;
    try { localStorage.setItem(KEY, JSON.stringify(normalized)); } catch { /* 저장 불가 환경 */ }
    lastSyncAt = new Date().toISOString();
    if (JSON.stringify(normalized.courses) !== before) notify({ source: 'server' });
    return true;
  }

  async function refresh() {
    if (!API || API.state.mode !== 'server') return false;
    const result = await API.request('/api/partner-courses', { timeoutMs: 6000 });
    if (result.ok && result.data && Array.isArray(result.data.courses)) {
      return applyServerCourses(result.data);
    }
    return false;
  }

  function connectSse() {
    if (!API || API.state.mode !== 'server' || typeof EventSource !== 'function') return;
    try {
      sse = new EventSource(API.apiUrl('/api/events'));
      sse.addEventListener('partner-courses.changed', () => { refresh(); });
      sse.onerror = () => {
        /* 연결이 끊기면 닫고 5초 폴링에 맡긴다(브라우저가 오류를 반복 출력하지 않도록). */
        try { sse.close(); } catch { /* noop */ }
        sse = null;
      };
    } catch { sse = null; }
  }

  function start() {
    if (started) return;
    started = true;
    if (!API || API.state.mode !== 'server') return;
    refresh();
    if (!pollTimer) pollTimer = setInterval(refresh, POLL_MS);
    connectSse();
  }

  /* 모드 배지: 지금 화면이 서버 연동인지 정적 시연인지 항상 구분할 수 있게 한다. */
  function mountBadge() {
    if (!API || !document || !document.body) return;
    const findBadge = () => (typeof document.getElementById === 'function' ? document.getElementById('allgolf-mode-badge') : document.querySelector('#allgolf-mode-badge'));
    let badge = findBadge();
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'allgolf-mode-badge';
      badge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;font:11px/1.5 system-ui,-apple-system,"Malgun Gothic",sans-serif;padding:2px 8px;border-radius:999px;background:rgba(17,24,39,.62);color:#fff;letter-spacing:.02em;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.18)';
      document.body.appendChild(badge);
    }
    const server = API.state.mode === 'server';
    const connecting = API.state.connecting;
    badge.textContent = connecting ? '● 서버 확인 중' : server ? '● 서버 연동' : '○ 정적 시연';
    badge.title = server
      ? `서버 DB와 연결되어 있습니다.\n${API.apiUrl('') || ''}`
      : `서버 없이 이 브라우저의 시연 데이터로 동작합니다.${API.state.reason === 'server_unreachable' ? '\n설정된 서버에 연결하지 못했습니다.' : ''}`;
    badge.style.background = server ? 'rgba(5,120,87,.86)' : 'rgba(55,65,81,.62)';
  }

  if (API) {
    API.onModeChange(() => {
      mountBadge();
      if (API.state.mode === 'server') start();
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountBadge);
    else mountBadge();
    API.init().then(() => {
      mountBadge();
      if (API.state.mode === 'server') start();
    }).catch(() => mountBadge());
  }

  window.ALL_GOLF_PARTNER_SYNC = {
    KEY,
    approvedIds,
    entries,
    entryFor,
    timesFor,
    applyServerCourses,
    refresh,
    start,
    onSync(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get payload() { return payload; },
    get mode() { return API ? API.state.mode : 'static'; },
    get lastSyncAt() { return lastSyncAt; },
    isServerCourse(id) { return approvedIds().has(String(id)); }
  };
})();
