/* ALL:GOLF 서버 카탈로그 동기화 (7단계)
   - 서버 연동 모드에서 골프장 담당자가 등록한 티타임·요금·특가를 날짜 단위로 받아 캐시한다.
   - 고객 앱은 캐시를 즉시 읽어 화면을 그리고(app.js 의 rawTimesFor), 변경이 오면
     `allgolf:catalogchange` 이벤트로 다시 그린다.
   - 서버가 없거나 정적 호스팅이면 아무 요청도 보내지 않고 기존 시연 데이터를 쓴다.
   - 예약 재고(차감·잠금)는 아직 서버로 이전하지 않았다(8단계). 이 모듈은 "보여 주는 정보"만
     서버에서 받아오고, 예약 수는 브라우저 시연 데이터로만 계산한다. */
(function () {
  'use strict';

  const KEY = 'allGolfServerCatalogV1';
  const TTL_MS = 15000;
  const POLL_MS = 15000;
  const API = window.ALL_GOLF_API || null;
  const SHARED = window.ALL_GOLF_STORE || null;

  const emptyCache = () => ({ version: 1, dates: {}, managedCourseIds: [], savedAt: null });
  let cache = readCache();
  const inflight = new Map();
  let pollTimer = null;
  let sse = null;
  let lastSyncAt = null;
  let started = false;
  const listeners = new Set();

  function readCache() {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (parsed && parsed.version === 1 && parsed.dates && typeof parsed.dates === 'object') {
        return { ...emptyCache(), ...parsed, managedCourseIds: Array.isArray(parsed.managedCourseIds) ? parsed.managedCourseIds : [] };
      }
    } catch { /* 손상된 캐시는 무시하고 서버에서 다시 받는다 */ }
    return emptyCache();
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* 저장 불가 환경 */ }
  }

  function emit(detail) {
    listeners.forEach(listener => { try { listener(detail); } catch { /* noop */ } });
    try {
      window.dispatchEvent(new CustomEvent('allgolf:catalogchange', { detail }));
    } catch { /* noop */ }
  }

  function isServer() {
    return Boolean(API && API.state && API.state.mode === 'server');
  }

  function normalizeTeeTimes(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter(item => item && item.id && item.time)
      .map(item => ({
        id: String(item.id),
        courseId: String(item.courseId || ''),
        date: item.date,
        time: item.time,
        session: item.session,
        course: item.course || '전체',
        capacityTeams: Number(item.capacityTeams) || 0,
        maxPlayers: Number(item.maxPlayers) || 4,
        remaining: Math.max(0, Number(item.remaining) || 0),
        price: Number(item.price || item.greenFee || 0),
        regular: Number(item.regular || item.greenFee || 0),
        greenFee: Number(item.greenFee || item.price || 0),
        status: item.status || 'open',
        closed: Boolean(item.closed),
        special: Boolean(item.special),
        serverManaged: true,
        source: 'server',
        version: item.version,
        updatedAt: item.updatedAt || null,
        priceByPlayers: item.priceByPlayers || null,
        notice: item.notice || '골프장이 서버에 등록한 시연 티타임입니다.'
      }));
  }

  /* 서버 응답을 캐시와 화면 계산용 저장소(shared-store)에 반영한다.
     같은 내용이면 이벤트를 보내지 않아 재렌더 루프를 막는다. */
  function applyPayload(date, payload) {
    if (!payload || !Array.isArray(payload.courses)) return false;
    const previous = JSON.stringify(cache.dates[date] || null);
    const courses = {};
    payload.courses.forEach(course => {
      if (!course || !course.courseId) return;
      courses[String(course.courseId)] = {
        courseId: String(course.courseId),
        courseName: course.courseName || '',
        teeTimes: normalizeTeeTimes(course.teeTimes),
        offers: Array.isArray(course.offers) ? course.offers : [],
        rates: course.rates || null
      };
    });
    cache.dates[date] = { courses, savedAt: new Date().toISOString(), inventoryLinked: payload.inventoryLinked === true };
    if (Array.isArray(payload.managedCourseIds)) {
      const merged = new Set([...(cache.managedCourseIds || []), ...payload.managedCourseIds.map(String)]);
      cache.managedCourseIds = [...merged];
    }
    cache.savedAt = new Date().toISOString();
    lastSyncAt = cache.savedAt;
    persist();
    if (SHARED && typeof SHARED.applyServerOperations === 'function') {
      Object.values(courses).forEach(course => {
        SHARED.applyServerOperations({ courseId: course.courseId, rates: course.rates, offers: course.offers });
      });
    }
    const changed = previous !== JSON.stringify(cache.dates[date]);
    if (changed) emit({ date, source: 'server' });
    return changed;
  }

  function ensureDate(date, options) {
    const opts = options || {};
    if (!date || !isServer()) return Promise.resolve(false);
    const cached = cache.dates[date];
    if (!opts.force && cached && cached.savedAt && Date.now() - Date.parse(cached.savedAt) < TTL_MS) {
      return Promise.resolve(true);
    }
    if (inflight.has(date)) return inflight.get(date);
    const promise = API.request(`/api/public/catalog?date=${encodeURIComponent(date)}`, { timeoutMs: 6000 })
      .then(result => {
        if (result && result.ok && result.data && Array.isArray(result.data.courses)) {
          applyPayload(date, result.data);
          return true;
        }
        return false;
      })
      .catch(() => false)
      .finally(() => { inflight.delete(date); });
    inflight.set(date, promise);
    return promise;
  }

  /* 날짜 캐시가 있으면 배열(없으면 null). 골프장이 서버에서 관리 중이면 빈 배열. */
  function teeTimesFor(courseId, date) {
    const entry = cache.dates[date];
    if (!entry) return null;
    const key = String(courseId);
    const course = entry.courses && entry.courses[key];
    if (course) return course.teeTimes;
    if ((cache.managedCourseIds || []).includes(key)) return [];
    return null;
  }

  function courseEntry(courseId) {
    const key = String(courseId);
    const dates = Object.keys(cache.dates).sort().reverse();
    for (const date of dates) {
      const course = cache.dates[date].courses && cache.dates[date].courses[key];
      if (course) return course;
    }
    return null;
  }

  function ratesFor(courseId) {
    const entry = courseEntry(courseId);
    return entry ? entry.rates : null;
  }

  function offersFor(courseId, date) {
    if (date) {
      const entry = cache.dates[date];
      const course = entry && entry.courses && entry.courses[String(courseId)];
      return course ? course.offers : [];
    }
    return Object.values(cache.dates).flatMap(entry => {
      const course = entry.courses && entry.courses[String(courseId)];
      return course ? course.offers : [];
    });
  }

  function isManaged(courseId) {
    return (cache.managedCourseIds || []).includes(String(courseId));
  }

  function cachedDates() {
    return Object.keys(cache.dates);
  }

  function refreshCachedDates() {
    if (!isServer()) return;
    const dates = cachedDates().slice(0, 7);
    dates.forEach(date => ensureDate(date, { force: true }));
  }

  function connectSse() {
    if (!isServer() || typeof EventSource !== 'function') return;
    if (sse) { try { sse.close(); } catch { /* noop */ } sse = null; }
    try {
      sse = new EventSource(API.apiUrl('/api/events'));
      sse.addEventListener('catalog.changed', event => {
        let detail = null;
        try { detail = JSON.parse(event.data); } catch { detail = null; }
        if (detail && detail.date && cache.dates[detail.date]) ensureDate(detail.date, { force: true });
        else refreshCachedDates();
      });
      sse.onerror = () => { try { sse.close(); } catch { /* noop */ } sse = null; };
    } catch { sse = null; }
  }

  function start() {
    if (!isServer()) return;
    if (!started) {
      started = true;
      if (!pollTimer) pollTimer = setInterval(refreshCachedDates, POLL_MS);
    }
    refreshCachedDates();
    connectSse();
  }

  function todaysDate() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  if (API) {
    API.onModeChange(() => { if (isServer()) start(); });
    API.init().then(() => {
      if (isServer()) {
        ensureDate(todaysDate());
        start();
      }
    }).catch(() => { /* 정적 모드 유지 */ });
  }

  window.ALL_GOLF_SERVER_CATALOG = {
    KEY,
    ensureDate,
    teeTimesFor,
    ratesFor,
    offersFor,
    isManaged,
    applyPayload,
    cachedDates,
    refreshCachedDates,
    start,
    lastSyncAt: () => lastSyncAt,
    isServer,
    onSync(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get state() {
      return {
        enabled: isServer(),
        dates: cachedDates(),
        managedCourseIds: (cache.managedCourseIds || []).slice(),
        lastSyncAt,
        inventoryLinked: false
      };
    }
  };
})();
