/* ALL:GOLF 서버 예약 연동 (8단계)
   - 서버 연동 모드에서는 예약을 서버 예약 API 로 만들고, 재고(잔여 팀)도 서버가 계산한 값을 쓴다.
   - 정적 호스팅(GitHub Pages)에서는 어떤 요청도 보내지 않고 기존 localStorage 시연 예약으로 동작한다.
   - 서버 예약은 shared-store 의 예약 목록에 source:'server' 로 합쳐 넣어 "내 예약" 화면이 같은 코드로 그려진다.
   - 실제 결제 승인·실골프장 예약은 아니다(시연). */
(function () {
  'use strict';

  const API = window.ALL_GOLF_API || null;
  const STORE = window.ALL_GOLF_STORE || null;
  const PHONE_KEY = 'allGolfReservationPhone';
  const SESSION_KEY = 'allGolfBookingSession';
  const SYNC_TTL_MS = 20000;

  let lastSyncAt = null;
  let inflightSync = null;
  const listeners = new Set();

  const safeGet = (storage, key) => { try { return storage.getItem(key) || ''; } catch { return ''; } };
  const safeSet = (storage, key, value) => { try { storage.setItem(key, String(value)); } catch { /* 저장 불가 환경 */ } };
  const digits = value => String(value == null ? '' : value).replace(/\D/g, '');

  function bookingSessionId() {
    let value = safeGet(window.sessionStorage, SESSION_KEY);
    if (!value) {
      value = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      safeSet(window.sessionStorage, SESSION_KEY, value);
    }
    return value;
  }

  function health() {
    return (API && API.state && API.state.health) || null;
  }

  /* 서버가 8단계 예약 API 를 제공하는 경우에만 재고 연동으로 본다. */
  function supported() {
    const info = health();
    return Boolean(info && Number(info.stage) >= 8 && info.features && info.features.reservations === true);
  }

  function isServerMode() {
    return Boolean(API && API.state && API.state.mode === 'server');
  }

  function linked() {
    return isServerMode() && supported();
  }

  function emit(detail) {
    listeners.forEach(listener => { try { listener(detail); } catch { /* noop */ } });
  }

  function idempotencyKey() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch { /* fall through */ }
    return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  async function call(pathname, options) {
    if (!linked()) {
      return { ok: false, status: 0, data: {}, error: { code: 'static_mode', message: '정적 시연 모드에서는 서버 예약을 사용할 수 없습니다.' } };
    }
    return API.request(pathname, options || {});
  }

  function failureMessage(result) {
    if (!result) return '요청을 처리하지 못했습니다.';
    if (result.error && result.error.message) return result.error.message;
    return '요청을 처리하지 못했습니다.';
  }

  /* 서버 예약 → 앱 화면 형식(localStorage 예약과 같은 필드) */
  function toDisplay(reservation) {
    return {
      id: reservation.id,
      number: reservation.number,
      courseId: reservation.courseId,
      courseName: reservation.courseName,
      date: reservation.date || reservation.dateISO,
      dateISO: reservation.dateISO || reservation.date,
      time: reservation.time,
      teeTimeId: reservation.teeTimeId,
      session: reservation.session,
      people: Number(reservation.people) || 0,
      companions: Array.isArray(reservation.companions) ? reservation.companions.slice() : [],
      booker: reservation.booker || '',
      phone: reservation.phone || '',
      request: reservation.request || '',
      baseGreenFee: reservation.baseGreenFee,
      playerSurcharge: reservation.playerSurcharge,
      regularGreenFee: reservation.regularGreenFee,
      appliedGreenFee: reservation.appliedGreenFee,
      discountAmount: reservation.discountAmount,
      greenFee: reservation.greenFee,
      greenTotal: reservation.greenTotal,
      cart: reservation.cart,
      caddie: reservation.caddie,
      totalEstimated: reservation.totalEstimated,
      paidDeposit: reservation.paidDeposit,
      online: reservation.paidDeposit,
      onsite: reservation.onsite,
      specialOfferId: reservation.specialOfferId || null,
      specialOfferName: reservation.specialOfferName || null,
      specialOfferSnapshot: reservation.specialOfferSnapshot || null,
      cancellationPolicySnapshot: reservation.cancellationPolicySnapshot || null,
      paymentStatus: reservation.paymentStatus || 'demo_paid',
      status: reservation.status === 'cancelled' ? 'cancelled' : reservation.status,
      createdAt: reservation.createdAt,
      cancelledAt: reservation.cancelledAt || null,
      cancelReason: reservation.cancelReason || null,
      cancellationFee: reservation.cancellationFee,
      refundAmount: reservation.refundAmount,
      refundStatus: reservation.refundStatus || null,
      source: 'server',
      demo: true
    };
  }

  /* 서버 예약 목록을 로컬 표시 목록에 합친다(서버 예약만 교체, 브라우저 시연 예약은 유지). */
  function mergeIntoLocal(serverItems) {
    if (!STORE || typeof STORE.getReservations !== 'function') return [];
    const local = STORE.getReservations() || [];
    const others = local.filter(item => item && item.source !== 'server');
    const merged = [...(serverItems || []).map(toDisplay), ...others]
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    STORE.setReservations(merged);
    return merged;
  }

  function rememberPhone(phone) {
    const value = digits(phone);
    if (value.length >= 10) safeSet(window.localStorage, PHONE_KEY, value);
    return value;
  }

  function savedPhone() {
    return digits(safeGet(window.localStorage, PHONE_KEY));
  }

  /* 이 브라우저에서 예약한 연락처의 서버 예약을 다시 받아 목록에 반영한다. */
  async function syncMine(options) {
    if (!linked()) return { ok: false, reason: 'static_mode', count: 0 };
    const phone = savedPhone();
    if (phone.length < 10) return { ok: true, count: 0, skipped: true };
    const opts = options || {};
    if (!opts.force && lastSyncAt && Date.now() - Date.parse(lastSyncAt) < SYNC_TTL_MS) {
      return { ok: true, count: null, cached: true };
    }
    if (inflightSync) return inflightSync;
    inflightSync = call(`/api/public/reservations?phone=${encodeURIComponent(phone)}`, { timeoutMs: 8000 })
      .then(result => {
        if (!result.ok) return { ok: false, status: result.status, error: result.error, count: 0 };
        const items = (result.data && result.data.reservations) || [];
        mergeIntoLocal(items);
        lastSyncAt = new Date().toISOString();
        emit({ reason: 'sync', count: items.length });
        return { ok: true, count: items.length };
      })
      .catch(() => ({ ok: false, count: 0 }))
      .finally(() => { inflightSync = null; });
    return inflightSync;
  }

  /* 임시확보: 결제 확인 화면을 여는 순간 1팀을 서버에 잡아 둔다. */
  async function hold(input) {
    const result = await call('/api/public/holds', {
      method: 'POST',
      body: { ...input, sessionId: input.sessionId || bookingSessionId() },
      timeoutMs: 10000
    });
    if (!result.ok) {
      return { ok: false, status: result.status, code: (result.error && result.error.code) || 'hold_failed', message: failureMessage(result) };
    }
    return {
      ok: true,
      reused: Boolean(result.data.reused),
      hold: result.data.hold,
      tee: result.data.tee || null
    };
  }

  async function release(holdId) {
    if (!holdId || !linked()) return { ok: false, skipped: true };
    const result = await call(`/api/public/holds/${encodeURIComponent(holdId)}?sessionId=${encodeURIComponent(bookingSessionId())}`, { method: 'DELETE', timeoutMs: 8000 });
    return { ok: Boolean(result.ok), status: result.status };
  }

  /* 예약 확정: Hold 가 있으면 소비, 없으면 즉석에서 재고를 원자적으로 차감한다. */
  async function confirm(input) {
    const key = input.idempotencyKey || idempotencyKey();
    const result = await call('/api/public/reservations', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: { ...input, sessionId: input.sessionId || bookingSessionId() },
      timeoutMs: 12000
    });
    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        code: (result.error && result.error.code) || 'reservation_failed',
        message: failureMessage(result),
        errors: (result.error && result.error.details && result.error.details.errors) || null
      };
    }
    const reservation = result.data.reservation;
    rememberPhone(input.phone || (reservation && reservation.phone) || '');
    const local = STORE ? STORE.getReservations() || [] : [];
    const others = local.filter(item => item && item.number !== reservation.number);
    STORE && STORE.setReservations([toDisplay(reservation), ...others]);
    lastSyncAt = new Date().toISOString();
    emit({ reason: 'confirmed', number: reservation.number });
    return {
      ok: true,
      idempotent: Boolean(result.data.idempotent),
      reservation: toDisplay(reservation),
      raw: reservation,
      inventory: result.data.inventory || null
    };
  }

  async function lookup(number, phone) {
    const result = await call(`/api/public/reservations/${encodeURIComponent(number)}?phone=${encodeURIComponent(digits(phone))}`, { timeoutMs: 8000 });
    if (!result.ok) return { ok: false, status: result.status, message: failureMessage(result) };
    return { ok: true, reservation: result.data.reservation, quote: result.data.cancellationQuote };
  }

  /* 서버 예약 취소: 환불 계산·재고 복구는 서버가 처리한다. */
  async function cancel(number, phone, reason) {
    const result = await call(`/api/public/reservations/${encodeURIComponent(number)}/cancel`, {
      method: 'POST',
      body: { phone: digits(phone), reason: reason || '사용자 취소' },
      timeoutMs: 10000
    });
    if (!result.ok) return { ok: false, status: result.status, message: failureMessage(result), raw: result.data };
    const reservation = result.data.reservation;
    const local = STORE ? STORE.getReservations() || [] : [];
    const next = local.map(item => (item.number === reservation.number ? { ...item, ...toDisplay(reservation) } : item));
    if (!next.some(item => item.number === reservation.number)) next.unshift(toDisplay(reservation));
    STORE && STORE.setReservations(next);
    emit({ reason: 'cancelled', number: reservation.number });
    return {
      ok: true,
      alreadyCancelled: Boolean(result.data.alreadyCancelled),
      reservation: toDisplay(reservation),
      refund: result.data.refund || null
    };
  }

  function changeQuote(reservation) {
    if (!reservation) return null;
    if (STORE && typeof STORE.calculateCancellation === 'function' && reservation.source !== 'server') return STORE.calculateCancellation(reservation);
    return reservation.cancellation || null;
  }

  if (API) {
    API.onModeChange(detail => {
      if (detail && detail.mode === 'server' && supported()) syncMine({ force: true });
    });
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('allgolf:serverreservationschange', () => { syncMine({ force: true }); });
    window.addEventListener('allgolf:apimodechange', () => { if (linked()) syncMine({ force: true }); });
  }

  window.ALL_GOLF_SERVER_RESERVATIONS = {
    PHONE_KEY,
    linked,
    supported,
    isServerMode,
    bookingSessionId,
    health,
    hold,
    release,
    confirm,
    lookup,
    cancel,
    listMine: () => (STORE ? (STORE.getReservations() || []).filter(item => item.source === 'server') : []),
    mergeIntoLocal,
    rememberPhone,
    savedPhone,
    syncMine,
    toDisplay,
    changeQuote,
    lastSyncAt: () => lastSyncAt,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    state() {
      return { linked: linked(), supported: supported(), mode: API && API.state ? API.state.mode : 'static', savedPhone: Boolean(savedPhone()) };
    }
  };
})();
