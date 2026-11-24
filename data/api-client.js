/* ALL:GOLF API 클라이언트 (6단계)
   - 서버가 함께 서빙되면(같은 출처) 자동으로 "서버 연동" 모드로 동작한다.
   - GitHub Pages 처럼 서버가 없는 정적 호스팅에서는 네트워크 요청을 전혀 보내지 않고
     "정적 시연" 모드로 동작한다(콘솔 오류 0건).
   - 원격 서버에 붙이려면 `?api=https://주소` 로 한 번 열거나 data/api-config.js 에
     window.ALL_GOLF_API_BASE 를 지정한다. 설정은 이 브라우저에 기억된다.
   - 이 파일은 실패해도 앱을 멈추지 않는다(모든 요청은 결과 객체로 돌려준다). */
(function () {
  'use strict';

  const STORAGE_BASE = 'allGolfApiBase';
  const TOKEN_KEY = 'allGolfAdminToken';
  const listeners = new Set();
  const state = {
    mode: 'static',      // 'static' | 'server'
    connecting: false,
    base: '',
    reason: '',
    health: null,
    online: false,
    checkedAt: null,
    lastError: null
  };

  const safeGet = key => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
  const safeSet = (key, value) => { try { localStorage.setItem(key, value); } catch { /* 저장 불가 환경 */ } };
  const normalize = value => String(value == null ? '' : value).trim().replace(/\/+$/, '');

  let paramBase = '';
  try { paramBase = new URLSearchParams(location.search).get('api') || ''; } catch { paramBase = ''; }
  if (paramBase) safeSet(STORAGE_BASE, paramBase);

  const isFile = () => { try { return location.protocol === 'file:'; } catch { return true; } };

  function resolveBase() {
    if (paramBase) return normalize(paramBase);
    if (window.ALL_GOLF_SERVER_MODE) return normalize(location.origin);
    if (window.ALL_GOLF_API_BASE) return normalize(window.ALL_GOLF_API_BASE);
    const stored = normalize(safeGet(STORAGE_BASE));
    if (stored) return stored;
    return '';
  }

  const serverFlag = Boolean(window.ALL_GOLF_SERVER_MODE);
  state.base = resolveBase();
  /* 우리 서버가 주입한 플래그가 있으면 즉시 서버 모드로 그린다(헬스 체크로 다시 확인). */
  if (serverFlag && state.base) state.mode = 'server';

  function emit() {
    const detail = { mode: state.mode, base: state.base, reason: state.reason, health: state.health };
    listeners.forEach(listener => { try { listener(detail); } catch { /* noop */ } });
    try {
      if (typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('allgolf:apimodechange', { detail }));
    } catch { /* noop */ }
  }

  function setMode(mode, reason) {
    const changed = state.mode !== mode || state.reason !== reason;
    state.mode = mode;
    state.reason = reason || '';
    if (changed) emit();
  }

  function apiUrl(pathname) {
    if (!state.base) return pathname;
    return `${state.base}${pathname}`;
  }

  async function rawFetch(pathname, options) {
    const opts = options || {};
    const headers = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    let controller = null;
    let timer = null;
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), opts.timeoutMs || 8000);
    }
    try {
      const response = await fetch(apiUrl(pathname), {
        method: opts.method || 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        credentials: state.base && state.base !== normalize(location.origin) ? 'omit' : 'same-origin',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return {
        ok: response.ok,
        status: response.status,
        data: data || {},
        error: response.ok ? null : ((data && data.error) || { code: `http_${response.status}`, message: '요청을 처리하지 못했습니다.' })
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function request(pathname, options) {
    if (state.mode !== 'server') {
      return { ok: false, status: 0, data: {}, error: { code: 'static_mode', message: '정적 시연 모드에서는 서버 기능을 사용할 수 없습니다.' } };
    }
    try {
      const result = await rawFetch(pathname, options);
      state.online = true;
      state.lastError = null;
      state.checkedAt = new Date().toISOString();
      return result;
    } catch (error) {
      state.online = false;
      state.lastError = { code: 'network', message: '서버에 연결할 수 없습니다.' };
      return { ok: false, status: 0, data: {}, error: state.lastError };
    }
  }

  let readyPromise = null;
  function init() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      state.connecting = true;
      emit();
      const base = resolveBase();
      state.base = base;
      if (!base || isFile()) {
        state.connecting = false;
        setMode('static', base ? 'file_protocol' : 'no_server');
        return state.mode;
      }
      try {
        const result = await rawFetch('/api/health', { timeoutMs: 2500 });
        const health = result.data || {};
        if (result.ok && health.ok === true && health.name === 'ALL:GOLF API') {
          state.health = health;
          state.online = true;
          state.checkedAt = new Date().toISOString();
          state.connecting = false;
          setMode('server', '');
          return state.mode;
        }
        state.online = false;
        state.connecting = false;
        setMode('static', 'server_unreachable');
      } catch (error) {
        state.online = false;
        state.connecting = false;
        state.lastError = { code: 'network', message: '서버에 연결할 수 없습니다.' };
        setMode('static', 'server_unreachable');
      }
      return state.mode;
    })();
    return readyPromise;
  }

  function getToken() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
  function setToken(token) { try { sessionStorage.setItem(TOKEN_KEY, String(token || '')); } catch { /* noop */ } }
  function clearToken() { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* noop */ } }

  function modeLabel() {
    if (state.connecting) return '서버 확인 중';
    return state.mode === 'server' ? '서버 연동' : '정적 시연';
  }

  function clearOverride() {
    try { localStorage.removeItem(STORAGE_BASE); } catch { /* noop */ }
    state.base = '';
    state.mode = 'static';
    state.reason = 'no_server';
    readyPromise = null;
    emit();
  }

  window.ALL_GOLF_API = {
    state,
    init,
    request,
    apiUrl,
    resolveBase,
    modeLabel,
    onModeChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    isServer() { return state.mode === 'server'; },
    getToken,
    setToken,
    clearToken,
    clearOverride,
    reload() { try { location.reload(); } catch { /* noop */ } }
  };
})();
