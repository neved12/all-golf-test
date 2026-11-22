/* ALL:GOLF 테스트용 최소 DOM 환경.
   브라우저 없이 앱 코드를 그대로 실행하기 위한 것으로, 화면을 그리지는 않는다.
   - localStorage / sessionStorage / window 이벤트 / 타이머만 실제처럼 흉내낸다.
   - node tests/run-scenarios.js 로 실행한다. */
(function (global) {
  'use strict';

  global.window = global;
  global.self = global;

  /* 저장소 -------------------------------------------------------------- */
  const makeStorage = () => {
    const memory = {};
    return {
      getItem: key => (Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null),
      setItem: (key, value) => { memory[key] = String(value); },
      removeItem: key => { delete memory[key]; },
      clear: () => { Object.keys(memory).forEach(key => delete memory[key]); },
      key: index => Object.keys(memory)[index] ?? null,
      get length() { return Object.keys(memory).length; }
    };
  };
  global.localStorage = makeStorage();
  global.sessionStorage = makeStorage();

  /* 엘리먼트 ------------------------------------------------------------ */
  class Element {
    constructor(selector, tag = 'div') {
      this.selector = selector;
      this.tagName = String(tag).toUpperCase();
      this._html = '';
      this.dataset = {};
      this.value = '';
      this.textContent = '';
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
      this.readOnly = false;
      this.style = {};
      this.listeners = {};
      this._classes = new Set();
      const self = this;
      this.classList = {
        add: name => self._classes.add(name),
        remove: name => self._classes.delete(name),
        contains: name => self._classes.has(name),
        toggle: (name, force) => {
          const on = force === undefined ? !self._classes.has(name) : Boolean(force);
          if (on) self._classes.add(name); else self._classes.delete(name);
          return on;
        }
      };
    }
    get innerHTML() { return this._html; }
    set innerHTML(value) { this._html = String(value ?? ''); }
    querySelector(selector) { return global.document.querySelector(selector); }
    querySelectorAll() { return []; }
    addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); }
    removeEventListener() {}
    dispatch(type, event) { (this.listeners[type] || []).forEach(handler => handler(event || { target: this })); }
    appendChild() {}
    remove() {}
    setAttribute() {}
    setSelectionRange() {}
    select() {}
    focus() {}
    click() { if (typeof this.onclick === 'function') this.onclick({ target: this, stopPropagation() {}, preventDefault() {} }); }
    scrollIntoView() {}
  }

  const registry = new Map();
  const element = selector => {
    if (!registry.has(selector)) registry.set(selector, new Element(selector));
    return registry.get(selector);
  };
  global.Element = Element;
  global.document = {
    querySelector: element,
    querySelectorAll: () => [],
    createElement: tag => new Element(`created:${tag}`, tag),
    body: new Element('body', 'body'),
    documentElement: new Element('html', 'html'),
    addEventListener() {}
  };

  /* 창 / 이벤트 --------------------------------------------------------- */
  const windowListeners = {};
  global.addEventListener = (type, handler) => { (windowListeners[type] = windowListeners[type] || []).push(handler); };
  global.dispatchEvent = event => (windowListeners[event?.type] || []).forEach(handler => handler(event));
  global.CustomEvent = class CustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  };

  /* 타이머 -------------------------------------------------------------- */
  const timeouts = [];
  global.setTimeout = (handler) => { timeouts.push(handler); return timeouts.length; };
  global.clearTimeout = () => {};
  global.setInterval = () => 0;
  global.clearInterval = () => {};
  global.requestAnimationFrame = handler => { timeouts.push(handler); return timeouts.length; };
  global.__flushTimers = () => { while (timeouts.length) { const handler = timeouts.shift(); try { handler(); } catch (error) { global.__timerErrors.push(String(error && error.message || error)); } } };
  global.__timerErrors = [];

  /* 브라우저 API 대체 ----------------------------------------------------- */
  global.navigator = { userAgent: 'all-golf-test', share: null, clipboard: null };
  global.location = { search: '', href: 'https://demo.allgolf.local/index.html', origin: 'https://demo.allgolf.local', pathname: '/index.html', hash: '' };
  global.scrollY = 0;
  global.scrollTo = () => {};
  global.URL = { createObjectURL: () => 'blob:demo', revokeObjectURL: () => {} };
  global.Blob = class Blob { constructor(parts = [], options = {}) { this.parts = parts; this.type = options.type || ''; this.size = String(parts.join('')).length; } };
  global.__alerts = [];
  global.alert = message => { global.__alerts.push(String(message)); };
  global.__confirmResult = true;
  global.confirm = () => global.__confirmResult;

  if (typeof global.URLSearchParams === 'undefined') {
    global.URLSearchParams = class URLSearchParams {
      constructor(init) {
        this._map = new Map();
        if (typeof init === 'string') {
          init.replace(/^\?/, '').split('&').filter(Boolean).forEach(pair => {
            const [key, value = ''] = pair.split('=');
            this._map.set(decodeURIComponent(key), decodeURIComponent(value));
          });
        } else if (init && typeof init === 'object') {
          Object.keys(init).forEach(key => { if (init[key] != null) this._map.set(key, String(init[key])); });
        }
      }
      set(key, value) { this._map.set(String(key), String(value)); return this; }
      append(key, value) { this._map.set(String(key), String(value)); return this; }
      get(key) { return this._map.has(String(key)) ? this._map.get(String(key)) : null; }
      has(key) { return this._map.has(String(key)); }
      delete(key) { this._map.delete(String(key)); }
      toString() { return [...this._map.entries()].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&'); }
    };
  }

  /* 숫자 포맷: 브라우저의 Intl 없이도 '170,000원' 형태를 확인할 수 있게 한다. */
  const nativeNumberFormat = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = function (locale, options) {
    try {
      const formatted = nativeNumberFormat.call(this, locale, options);
      if (/,/.test(formatted) || Math.abs(this) < 1000) return formatted;
    } catch { /* ignore */ }
    return String(this).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
