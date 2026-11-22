/* =============================================================================
   ALL:GOLF 사용자 앱 (모바일 우선)
   - 실골프장 마스터(data/)와 시연용 재고(demo-teetimes.js)는 분리한다.
   - 이 파일의 가격·티타임·잔여 팀은 모두 시연 값이며 실제 판매가 아니다.
   - localStorage 키(allGolfReservations, allGolfFavorites, allGolfLastReservation)와
     data/shared-store.js 의 allGolfOperationsV1 구조는 그대로 유지한다.
   ============================================================================= */

/* 1. 데이터 ------------------------------------------------------------------ */
const masterCourses = Array.isArray(window.ALL_GOLF_COURSES) ? window.ALL_GOLF_COURSES : [];
const demoById = window.ALL_GOLF_DEMO_COURSES || {};
const courses = masterCourses.map(course => {
  const demo = demoById[course.id];
  if (!demo) {
    return {
      ...course, area: course.city, bookable: false, demo: false, demoPrice: null, price: null,
      cart: null, caddie: null, deposit: null, noCaddie: false, deal: false, times: [], rating: null, reviews: null
    };
  }
  return {
    ...course, ...demo, area: course.city, bookable: true, demo: true,
    demoPrice: demo.demoGreenFee, price: demo.demoGreenFee, cart: demo.demoCartFee, caddie: demo.demoCaddieFee,
    deposit: demo.demoDeposit, noCaddie: demo.demoNoCaddie, deal: demo.demoDeal, times: demo.demoTeeTimes,
    rating: null, reviews: null
  };
});
const demoCourses = courses.filter(course => course.demo);
const regionOptions = window.ALL_GOLF_REGIONS || [{ code: '전체', label: '전체' }];
const shared = window.ALL_GOLF_STORE;
const root = document.querySelector('#app');
const storeKey = 'allGolfReservations';

/* 2. 상태 -------------------------------------------------------------------- */
const now = new Date();
const todayISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const weekdayLabels = ['일', '월', '화', '수', '목', '금', '토'];

let page = 'home';
let course = courses.find(item => item.id === 'woojeong') || demoCourses[0] || courses[0];
let tee = null;
let people = 4;
let region = '전체';
let city = '';
let date = '';
let calendarDate = todayISO;
let dateAnchor = todayISO;
let filters = [];
let sort = 'recommend';
let operationFilter = 'all';
let holesFilter = 'all';
let availabilityFilter = 'all';
let visibleCount = 30;
let myTab = 'upcoming';
let query = '';
let minPrice = '';
let maxPrice = '';
let timePart = 'all';
let detailSession = 'all';      // 상세 화면 시간대 필터(전체/1부/2부/3부)
let filtersOpen = false;        // 검색 결과 상세 필터 접힘 상태
let favDate = todayISO;         // 찜한 골프장 화면의 기준 날짜
let currentReservationId = null;// 예약 상세 화면에서 보고 있는 예약
let shareIncoming = null;       // 공유 링크로 들어온 조건 안내
let bookingDraft = { booker: '', phone: '', request: '', companions: [], terms: false, refund: false };
let activeHold = null;
let holdTicker = null;
let modalCleanup = null;
let lastViewedCourseId = null;

const bookingSessionId = sessionStorage.getItem('allGolfBookingSession')
  || `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
sessionStorage.setItem('allGolfBookingSession', bookingSessionId);

const RECENT_SEARCH_KEY = 'allGolfRecentSearches';
const RECENT_VIEW_KEY = 'allGolfRecentViews';
const MAX_RECENT = 6;

/* 3. 유틸 -------------------------------------------------------------------- */
const demoNotice = '시연용 예약이며 실제 골프장 예약이 아닙니다';
const fullDemoNotice = '본 서비스는 시연용입니다. 실제 골프장 예약·결제·환불은 이루어지지 않습니다.';

const won = value => value == null ? '가격 확인 필요' : `${Number(value).toLocaleString('ko-KR')}원`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const readJSON = (key, fallback) => { try { const parsed = JSON.parse(localStorage.getItem(key) || 'null'); return parsed ?? fallback; } catch { return fallback; } };

const formatCalendarDate = iso => {
  const d = new Date(`${iso}T00:00:00`);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${weekdayLabels[d.getDay()]})`;
};
const shortDate = iso => {
  const d = new Date(`${iso}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}(${weekdayLabels[d.getDay()]})`;
};
const currentDateShort = () => date.replace(/^\d{4}년 /, '').replace(' 일', '');
const shiftISO = (iso, days) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const nextWeekendISO = () => {
  const d = new Date(`${todayISO}T00:00:00`);
  const days = (6 - d.getDay() + 7) % 7;
  return shiftISO(todayISO, days);
};
const dateOptions = (anchor = dateAnchor, count = 5) => Array.from({ length: count }, (_, index) => {
  const d = new Date(`${anchor}T00:00:00`);
  d.setDate(d.getDate() + index);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { iso, label: formatCalendarDate(iso), short: shortDate(iso) };
});
const citiesFor = selected => [...new Set(courses.filter(item => selected === '전체' || item.region === selected).map(item => item.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
const holeLabel = item => item.holes ? `${item.holes}홀` : '홀 수 확인 필요';
const typeLabel = item => {
  const type = item.operationType || item.type;
  if (type === 'public') return '대중제';
  if (type === 'membership' || type === 'member') return '회원제';
  if (type === 'mixed') return '혼합형';
  return '운영 형태 확인 필요';
};
const isWeekendISO = iso => [0, 6].includes(new Date(`${iso}T00:00:00`).getDay());
const timeMinutes = time => {
  const [hour, minute] = String(time || '00:00').split(':').map(Number);
  return hour * 60 + minute;
};
const sessionLabel = value => value === 'all' ? '전체' : value;

/* 시연 티타임 (기존 데이터 경로 그대로) */
const demoTimesForDate = (item, iso) => window.ALL_GOLF_DEMO_FOR_DATE ? window.ALL_GOLF_DEMO_FOR_DATE(item.id, iso) : item.times;
const rawTimesFor = (item, iso = calendarDate) => item?.demo
  ? (shared ? shared.getTeeTimes(item.id, iso, demoTimesForDate(item, iso)) : demoTimesForDate(item, iso))
  : [];
const timesFor = (item, iso = calendarDate) => rawTimesFor(item, iso).map(entry => {
  const dayPrice = shared?.getGreenFeeForDate ? shared.getGreenFeeForDate(item.id, iso, entry.price) : Number(entry.price);
  const priced = { ...entry, price: dayPrice, regular: dayPrice };
  if (shared?.applySpecialOffer) return shared.applySpecialOffer(item.id, iso, priced);
  return { ...priced, regularPrice: dayPrice, appliedPrice: dayPrice, specialOffer: null };
});
const openTimesFor = (item, iso = calendarDate) => timesFor(item, iso).filter(entry => !entry.closed && entry.remaining > 0);
const activeOffers = () => shared?.getSpecialOffers ? shared.getSpecialOffers().filter(offer => offer.status === 'active' && offer.visible !== false) : [];
const ratesFor = item => shared ? shared.getRates(item.id) : { cartFee: null, caddieFee: null };
const effectiveCart = item => ratesFor(item).cartFee ?? item.demoCartFee;
const effectiveCaddie = item => ratesFor(item).caddieFee ?? item.demoCaddieFee;

/* 요금 계산: 1인 그린피 × 인원 + 3인 추가금 + 카트·캐디(팀) + 예약금 */
const paymentFor = (item, timeSlot, count) => {
  const baseAppliedGreenFee = Number(timeSlot.appliedPrice ?? timeSlot.price);
  const baseRegularGreenFee = Number(timeSlot.regularPrice ?? timeSlot.regular ?? timeSlot.price);
  const playerSurcharge = shared?.getPlayerSurcharge
    ? shared.getPlayerSurcharge(item.id, count, item.demoThreePlayerSurcharge || 0)
    : (Number(count) === 3 ? Number(item.demoThreePlayerSurcharge || 0) : 0);
  const appliedGreenFee = baseAppliedGreenFee + playerSurcharge;
  const regularGreenFee = baseRegularGreenFee + playerSurcharge;
  const greenTotal = appliedGreenFee * count;
  const cart = Number(effectiveCart(item) || 0);
  const caddie = Number(effectiveCaddie(item) || 0);
  const totalEstimated = greenTotal + cart + caddie;
  const paidDeposit = shared?.calculateDeposit
    ? shared.calculateDeposit(item.id, totalEstimated, count, item.deposit)
    : Number(item.deposit || 0) * count;
  return {
    baseAppliedGreenFee, baseRegularGreenFee, playerSurcharge, regularGreenFee, appliedGreenFee,
    discountPerPerson: Math.max(0, baseRegularGreenFee - baseAppliedGreenFee),
    discountTotal: Math.max(0, (baseRegularGreenFee - baseAppliedGreenFee) * count),
    greenTotal, regularGreenTotal: regularGreenFee * count, cart, caddie, totalEstimated,
    paidDeposit, onsite: Math.max(0, totalEstimated - paidDeposit)
  };
};

const getReservations = () => shared ? shared.getReservations() : readJSON(storeKey, []);
const setReservations = items => shared ? shared.setReservations(items) : localStorage.setItem(storeKey, JSON.stringify(items));
const findReservation = reference => getReservations().find(item => item.number === reference || item.id === reference) || null;

/* 찜 */
const favorites = () => {
  try {
    const stored = JSON.parse(localStorage.getItem('allGolfFavorites') || '[]');
    return [...new Set(stored.filter(id => courses.some(item => item.id === id)))];
  } catch { return []; }
};
const toggleFavorite = id => {
  const current = favorites();
  const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id];
  localStorage.setItem('allGolfFavorites', JSON.stringify([...new Set(next)]));
  toast(current.includes(id) ? '찜을 해제했습니다.' : '찜한 골프장에 담았습니다.');
  render();
};

/* 최근 검색 / 최근 본 골프장 (앱에서만 쓰는 새 키. 기존 데이터는 건드리지 않는다) */
const recentSearches = () => readJSON(RECENT_SEARCH_KEY, [])
  .filter(entry => entry && typeof entry === 'object')
  .slice(0, MAX_RECENT);
const pushRecentSearch = entry => {
  const key = [entry.query || '', entry.region || '전체', entry.city || '', entry.date || '', entry.people || ''].join('|');
  const rest = recentSearches().filter(item => [item.query || '', item.region || '전체', item.city || '', item.date || '', item.people || ''].join('|') !== key);
  localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify([{ ...entry, at: new Date().toISOString() }, ...rest].slice(0, MAX_RECENT)));
};
const clearRecentSearches = () => localStorage.setItem(RECENT_SEARCH_KEY, '[]');
const recentViews = () => readJSON(RECENT_VIEW_KEY, [])
  .filter(id => courses.some(item => item.id === id))
  .slice(0, MAX_RECENT);
const pushRecentView = id => {
  if (!id || lastViewedCourseId === id) return;
  lastViewedCourseId = id;
  const rest = recentViews().filter(item => item !== id);
  localStorage.setItem(RECENT_VIEW_KEY, JSON.stringify([id, ...rest].slice(0, MAX_RECENT)));
  const badge = document.querySelector('#notification-badge');
  if (badge) updateNotificationBadge();
};

/* 연락처 */
const phoneDigits = value => String(value || '').replace(/\D/g, '').slice(0, 11);
const formatPhone = value => {
  const digits = phoneDigits(value);
  if (digits.length < 4) return digits;
  if (digits.length < 8) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
};
const isValidPhone = value => /^01[016789]-\d{3,4}-\d{4}$/.test(formatPhone(value));

/* 공유 링크 */
const shareLink = ({ courseId, dateISO, people: count, time }) => {
  const params = new URLSearchParams();
  if (courseId) params.set('course', courseId);
  if (dateISO) params.set('date', dateISO);
  if (count) params.set('people', String(count));
  if (time) params.set('time', time);
  const base = `${location.origin}${location.pathname}`;
  return `${base}?${params.toString()}`;
};
const copyText = async text => {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand('copy');
    field.remove();
    return ok;
  } catch { return false; }
};

/* 일정 저장(.ics) — 브라우저에서 바로 내려받는 표준 캘린더 파일 */
const pad = value => String(value).padStart(2, '0');
const icsDateTime = (iso, time) => `${iso.replace(/-/g, '')}T${String(time || '00:00').replace(':', '')}00`;
const icsEnd = (iso, time, minutes = 270) => {
  const start = new Date(`${iso}T${time || '00:00'}:00`);
  start.setMinutes(start.getMinutes() + minutes);
  return `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}T${pad(start.getHours())}${pad(start.getMinutes())}00`;
};
const icsEscape = value => String(value || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
const icsForReservation = reservation => {
  const startISO = reservation.dateISO || todayISO;
  const summary = `[시연] ${reservation.courseName || '골프 라운딩'} ${reservation.time || ''}`.trim();
  const description = [
    'ALL:GOLF 시연용 예약입니다. 실제 골프장 예약이 아닙니다.',
    `예약번호: ${reservation.number || '-'}`,
    `인원: ${reservation.people || 0}명`,
    reservation.companions?.length ? `동반자: ${reservation.companions.join(', ')}` : '',
    reservation.booker ? `예약자: ${reservation.booker}` : ''
  ].filter(Boolean).join('\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ALL:GOLF//Demo Reservation//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${reservation.id || reservation.number || Date.now()}@allgolf.demo`,
    `DTSTAMP:${icsDateTime(todayISO, '09:00')}Z`,
    `DTSTART:${icsDateTime(startISO, reservation.time)}`,
    `DTEND:${icsEnd(startISO, reservation.time)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `LOCATION:${icsEscape(courses.find(item => item.id === reservation.courseId)?.address || '')}`,
    `DESCRIPTION:${icsEscape(description)}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
};
const downloadFile = (fileName, content, mime = 'text/calendar;charset=utf-8') => {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch { return false; }
};
const saveReservationToCalendar = reservation => {
  if (!reservation) return;
  const ok = downloadFile(`ALLGOLF-${reservation.number || 'reservation'}.ics`, icsForReservation(reservation));
  toast(ok ? '캘린더 파일(.ics)을 내려받았습니다.' : '일정 파일을 만들 수 없습니다.');
};

/* 토스트 */
let toastTimer = null;
function toast(message) {
  const layer = document.querySelector('#toast');
  if (!layer) return;
  layer.textContent = message;
  layer.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => layer.classList.remove('show'), 2200);
}

/* 4. 예약 상태 분류 ----------------------------------------------------------
   예약 날짜·시간을 기준으로 다가오는/지난 예약을 나눈다(상태값에만 기대지 않는다). */
const roundStart = reservation => new Date(`${reservation.dateISO || todayISO}T${reservation.time || '00:00'}:00`);
const isPastReservation = reservation => {
  if (['cancelled', 'cancel_requested', 'completed', 'no_show'].includes(reservation.status)) return true;
  const start = roundStart(reservation);
  if (Number.isNaN(start.getTime())) return false;
  return start.getTime() + 5 * 60 * 60 * 1000 < Date.now();  // 라운드 종료(약 4시간 30분) 이후는 지난 예약
};
const isCancelledReservation = reservation => ['cancelled', 'cancel_requested'].includes(reservation.status);
const reservationStatusLabel = reservation => {
  if (isCancelledReservation(reservation)) return '취소 완료';
  if (reservation.status === 'completed') return '라운드 완료';
  if (reservation.status === 'no_show') return '노쇼';
  if (isPastReservation(reservation)) return '지난 예약';
  return '예약 완료';
};
const dDayLabel = reservation => {
  if (isCancelledReservation(reservation) || isPastReservation(reservation)) return '';
  const diff = Math.ceil((new Date(`${reservation.dateISO}T00:00:00`) - new Date(`${todayISO}T00:00:00`)) / 86400000);
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  return `D-${diff}`;
};
/* 5. 공통 조각 --------------------------------------------------------------- */
function updateNotificationBadge() {
  const badge = document.querySelector('#notification-badge');
  if (!badge) return;
  const unread = shared?.getNotifications ? shared.getNotifications().filter(item => !item.read).length : 0;
  badge.hidden = unread === 0;
  badge.textContent = unread > 9 ? '9+' : String(unread);
}
function sectionHead(kicker, title, actionLabel, actionAttrs = '') {
  return `<div class="section-head"><div>${kicker ? `<div class="kicker">${kicker}</div>` : ''}<h2>${title}</h2></div>${actionLabel ? `<button class="text-link" ${actionAttrs}>${actionLabel}</button>` : ''}</div>`;
}
function emptyState(text, actionHtml = '') {
  return `<div class="empty">${text}${actionHtml}</div>`;
}
function noticeBox(text) {
  return `<p class="notice">${text}</p>`;
}

/* 6. 홈 ---------------------------------------------------------------------- */
function home() {
  const featured = ['woojeong', 'emerson', 'princess'].map(id => courses.find(item => item.id === id)).filter(Boolean);
  const savedCourses = favorites().map(id => courses.find(item => item.id === id)).filter(Boolean).slice(0, 3);
  const offers = activeOffers().slice(0, 3);
  const searches = recentSearches().slice(0, 4);
  const views = recentViews().map(id => courses.find(item => item.id === id)).filter(Boolean).slice(0, 4);

  return `
  <p class="greeting">안녕하세요, 김골퍼님 👋</p>
  <div class="direct-title"><span>골프장 다이렉트 예약</span><small>현재 예약과 가격은 시연용 · 실제 예약 불가</small></div>
  <h1 class="hero-title">필드로 나가는 가장 빠른 길,<br><em>전국 골프장을 찾아보세요.</em></h1>

  <section class="quick-search">
    <b>어디서 라운딩 하세요?</b>
    <form class="searchbox" id="search-form">
      <span aria-hidden="true">🔍</span>
      <input id="home-query" value="${esc(query)}" placeholder="지역 또는 골프장 검색" enterkeyhint="search">
      <button type="submit">검색</button>
    </form>
    <div class="search-options">
      <button data-sheet>📍 ${region}</button>
      <button data-sheet>📅 ${currentDateShort()}</button>
      <button data-sheet>👥 ${people}명</button>
    </div>
    <div class="chips home-quick">
      <button class="chip" data-quick="오늘">오늘</button>
      <button class="chip" data-quick="내일">내일</button>
      <button class="chip" data-quick="주말">이번 주말</button>
      <button class="chip ${filters.includes('2인 가능') ? 'active' : ''}" data-quick="2인 가능">2인 가능</button>
      <button class="chip ${filters.includes('특가') ? 'active' : ''}" data-quick="특가">특가</button>
    </div>
  </section>

  ${searches.length ? `<section class="section recent-section">
    ${sectionHead('최근 검색', '찾던 조건으로 바로가기', '전체 지우기', 'data-clear-recents')}
    <div class="chips recent-chips">${searches.map((entry, index) => `<button class="chip recent-chip" data-recent-search="${index}">${esc(entry.query || entry.region || '전체')}${entry.query && entry.region && entry.region !== '전체' ? ` · ${esc(entry.region)}` : ''} <span>${esc(entry.date ? shortDate(entry.date) : '')}</span></button>`).join('')}</div>
  </section>` : ''}

  <section class="section live-first">
    ${sectionHead('시연용 티타임', '예약 흐름 미리보기', '전체보기', 'data-go="list"')}
    <div class="time-card-list">${featured.slice(0, 2).map(homeCard).join('')}</div>
  </section>

  <section class="section deal-section">
    ${sectionHead('🔥 시연용 특가', '오늘의 특가', '전체보기', 'data-go="benefits"')}
    <div class="deal-list">${offers.length ? offers.map(specialCard).join('') : '<div class="empty compact-empty">현재 판매 중인 시연 특가가 없습니다.</div>'}</div>
  </section>

  <section class="cancel-alert">
    <div><b>🔔 원하는 티타임이 없나요?</b><span>골프장과 시간대를 등록하면 취소 티타임이 열릴 때 앱 안에서 알려드립니다.</span></div>
    <button data-wait-pick>빈자리 알림 등록</button>
  </section>

  <section class="section">
    ${sectionHead('이번 주말', '주말 라운드는 어디서?', '전체보기', 'data-go="list"')}
    <div class="time-card-list">${featured.slice(1).map(homeCard).join('')}</div>
  </section>

  ${savedCourses.length ? `<section class="section favorite-home">
    ${sectionHead('찜한 골프장', '관심 골프장', '전체보기', 'data-go="favorites"')}
    <div class="favorite-home-list">${savedCourses.map(favoriteHomeCard).join('')}</div>
  </section>` : ''}

  ${views.length ? `<section class="section recent-views">
    ${sectionHead('최근 본 골프장', '이어서 둘러보기', '전체보기', 'data-go="list"')}
    <div class="chips recent-chips">${views.map(item => `<button class="chip recent-chip" data-course="${item.id}">${esc(item.name)} <span>${won(openTimesFor(item)[0]?.price)}</span></button>`).join('')}</div>
  </section>` : ''}

  <section class="quick-grid main-services">
    <button class="quick" data-go="list"><i>⛳</i>골프장 예약<small>실시간 티타임</small></button>
    <button class="quick ready" data-go="join"><i>🤝</i>조인<small>준비 중</small></button>
    <button class="quick ready" data-go="lesson"><i>🏌</i>골프레슨<small>준비 중</small></button>
    <button class="quick ready" data-go="travel"><i>✈</i>골프여행<small>준비 중</small></button>
  </section>
  <p class="footer-note">${fullDemoNotice} 조인·레슨·골프여행은 준비 중인 메뉴입니다.</p>`;
}

function specialCard(offer) {
  const target = courses.find(item => item.id === offer.courseId);
  if (!target) return '';
  const slot = timesFor(target, offer.roundDate).find(item => item.id === offer.teeTimeId);
  const bookable = Boolean(slot?.specialOffer && !slot.closed && slot.remaining > 0);
  const remaining = slot?.specialOffer?.remainingOfferTeams ?? 0;
  return `<article class="deal-card ${bookable ? '' : 'soldout-deal'}"><div><span class="deal-label">${bookable ? `특가 ${offer.discountRate}% 할인` : '특가 매진'}</span><b>${esc(target.name)}</b><p>${esc(offer.roundDate)} · ${esc(offer.time)} · ${bookable ? `잔여 ${remaining}팀` : '예약 마감'}</p><strong><s>${won(offer.regularPrice)}</s> ${won(offer.specialPrice)} / 1인</strong><small>시연용 특가 · 실제 판매가 아님</small></div><button ${bookable ? `data-special-course="${target.id}" data-special-date="${offer.roundDate}" data-special-tee="${offer.teeTimeId}"` : 'disabled'}>${bookable ? '예약하기' : '매진'}</button></article>`;
}

function homeCard(item) {
  const slots = openTimesFor(item);
  const first = slots[0] || timesFor(item)[0];
  if (!first) return '';
  return `<article class="time-card" data-course="${item.id}">
    <div class="time-card-main">
      <div><span class="live-dot">시연용 티타임</span><h3>${esc(item.name)}</h3><p>${currentDateShort()} · ${first.time} · ${people}명 · ${holeLabel(item)}</p></div>
      <div class="price"><small>시연용 1인 가격</small><strong>${won(first.price)}</strong></div>
    </div>
    <div class="time-card-bottom"><span>시연 수량 ${first.remaining}팀 · 실제 판매 아님</span><button data-course="${item.id}">시연 예약</button></div>
  </article>`;
}

function favoriteHomeCard(item) {
  const first = openTimesFor(item)[0];
  return `<article class="favorite-home-card"><div><b>${esc(item.name)}</b><span>${esc(item.region)} · ${holeLabel(item)} · ${item.demo ? '시연 예약 가능' : 'ALL:GOLF 예약 연동 없음'}</span>${first ? `<span class="fav-price">${won(first.price)} / 1인 · ${first.time}부터</span>` : ''}</div><button data-course="${item.id}">상세보기</button></article>`;
}

/* 7. 검색 결과 --------------------------------------------------------------- */
function matchesCourse(item) {
  const text = `${item.name} ${item.region} ${item.city} ${item.address || ''} ${typeLabel(item)}`.toLocaleLowerCase('ko');
  if (region !== '전체' && item.region !== region) return false;
  if (city && item.city !== city) return false;
  if (operationFilter !== 'all' && item.operationType !== operationFilter) return false;
  if (holesFilter !== 'all' && (holesFilter === '36plus' ? Number(item.holes) < 36 : Number(item.holes) !== Number(holesFilter))) return false;
  if (availabilityFilter === 'bookable' && !item.bookable) return false;
  if (minPrice || maxPrice || timePart !== 'all') {
    const available = timesFor(item).filter(slot => !slot.closed && slot.remaining > 0
      && (!minPrice || slot.price >= Number(minPrice))
      && (!maxPrice || slot.price <= Number(maxPrice))
      && (timePart === 'all' || slot.session === timePart));
    if (!available.length) return false;
  }
  if (query && !text.replace(/\s/g, '').includes(query.toLocaleLowerCase('ko').replace(/\s/g, ''))) return false;
  if (filters.includes('2인 가능') && !item.bookable) return false;
  if (filters.includes('노캐디') && !item.noCaddie) return false;
  if (filters.includes('특가') && !timesFor(item).some(slot => slot.specialOffer)) return false;
  if (filters.includes('18홀') && item.holes !== 18) return false;
  return true;
}
const activeFilterCount = () => [minPrice, maxPrice, timePart !== 'all', operationFilter !== 'all', holesFilter !== 'all', availabilityFilter !== 'all', filters.length].filter(Boolean).length;

function list() {
  let results = courses.filter(matchesCourse);
  if (sort !== 'recommend') {
    const metrics = new Map(results.map(item => {
      const slots = openTimesFor(item);
      return [item.id, {
        price: Math.min(Infinity, ...slots.map(slot => slot.price)),
        time: slots[0]?.time || '99:99',
        discount: Math.max(0, ...slots.map(slot => slot.specialOffer?.discountRate || 0))
      }];
    }));
    results = results.slice().sort((a, b) => {
      const x = metrics.get(a.id), y = metrics.get(b.id);
      if (sort === 'price') return x.price - y.price;
      if (sort === 'price-desc') return y.price - x.price;
      if (sort === 'time') return x.time.localeCompare(y.time);
      if (sort === 'time-desc') return y.time.localeCompare(x.time);
      return y.discount - x.discount;
    });
  }
  const visible = results.slice(0, visibleCount);
  const filterNames = ['2인 가능', '노캐디', '18홀', '특가', '오늘 예약', '주말'];

  return `
  <div class="result-top"><button class="back" data-go="home" aria-label="뒤로">‹</button><h1>검색 결과</h1></div>
  <div class="list-sticky">
    <button class="sticky-condition" data-sheet>${esc(region)}${city ? ` · ${esc(city)}` : ''} · ${currentDateShort()} · ${people}명 <b>조건 변경</b></button>
    <button class="filter-toggle ${filtersOpen ? 'open' : ''}" data-toggle-filters>상세 필터${activeFilterCount() ? ` <em>${activeFilterCount()}</em>` : ''}</button>
  </div>
  <div class="filter-panel ${filtersOpen ? 'open' : ''}">
    <div class="chips region-filters">${regionOptions.map(item => `<button class="chip ${region === item.code ? 'active' : ''}" data-region-filter="${item.code}">${item.label}</button>`).join('')}</div>
    <div class="result-filters national-filters">
      <label>시·군<select id="result-city"><option value="">전체 시·군</option>${citiesFor(region).map(value => `<option value="${esc(value)}" ${city === value ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select></label>
      <label>운영형태<select id="operation-filter"><option value="all">전체</option><option value="public" ${operationFilter === 'public' ? 'selected' : ''}>대중제</option><option value="membership" ${operationFilter === 'membership' ? 'selected' : ''}>회원제</option><option value="mixed" ${operationFilter === 'mixed' ? 'selected' : ''}>혼합형</option></select></label>
      <label>홀 수<select id="holes-filter"><option value="all">전체</option><option value="9" ${holesFilter === '9' ? 'selected' : ''}>9홀</option><option value="18" ${holesFilter === '18' ? 'selected' : ''}>18홀</option><option value="27" ${holesFilter === '27' ? 'selected' : ''}>27홀</option><option value="36plus" ${holesFilter === '36plus' ? 'selected' : ''}>36홀 이상</option></select></label>
      <label>조회 범위<select id="availability-filter"><option value="all">전체 골프장</option><option value="bookable" ${availabilityFilter === 'bookable' ? 'selected' : ''}>시연 예약 가능</option></select></label>
    </div>
    <div class="compare-filters">
      <label>최소 1인 가격<input id="min-price" type="number" inputmode="numeric" min="0" value="${esc(minPrice)}" placeholder="원"></label>
      <label>최대 1인 가격<input id="max-price" type="number" inputmode="numeric" min="0" value="${esc(maxPrice)}" placeholder="원"></label>
      <label>시간대<select id="time-part"><option value="all">전체</option>${['1부', '2부', '3부'].map(value => `<option value="${value}" ${timePart === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
    </div>
    <div class="sort-row">
      <div class="chips">${[['recommend', '추천순'], ['price', '낮은 가격순'], ['price-desc', '높은 가격순'], ['time', '빠른 시간순'], ['time-desc', '늦은 시간순'], ['discount', '할인율순']].map(([id, label]) => `<button class="chip ${sort === id ? 'active' : ''}" data-sort="${id}">${label}</button>`).join('')}</div>
      <button class="filter-reset" data-reset-search>초기화</button>
    </div>
    <div class="chips">${filterNames.map(name => `<button class="chip ${filters.includes(name) ? 'active' : ''}" data-filter="${name}">${name}</button>`).join('')}</div>
  </div>
  <p class="result-count"><b>${results.length}</b>개 골프장 · ${currentDateShort()} 기준 시연 티타임</p>
  <section class="result-group">
    <div class="course-list">${visible.map(listCard).join('') || emptyState('검색 결과가 없습니다.<br>검색어 또는 필터를 변경해보세요.')}</div>
    ${visible.length < results.length ? `<button class="load-more" data-load-more>더 보기 (${results.length - visible.length}곳)</button>` : ''}
  </section>`;
}

function listCard(item) {
  const saved = favorites().includes(item.id);
  const slots = openTimesFor(item);
  const eligible = slots.filter(slot => (!minPrice || slot.price >= Number(minPrice))
    && (!maxPrice || slot.price <= Number(maxPrice))
    && (timePart === 'all' || slot.session === timePart));
  const pool = eligible.length ? eligible : slots;
  const cheapest = pool.slice().sort((a, b) => a.price - b.price)[0];
  const highlights = pool.slice(0, 3);
  return `<article class="list-card">
    <div class="list-image" aria-hidden="true">⛳</div>
    <div class="list-info">
      <div class="card-title"><h3 data-course="${item.id}">${esc(item.name)}</h3><button class="heart ${saved ? 'saved' : ''}" data-favorite="${item.id}" aria-label="찜하기">${saved ? '♥' : '♡'}</button></div>
      <p>${esc(item.region)} · ${esc(item.city)} · ${holeLabel(item)} · ${typeLabel(item)}</p>
      <div class="list-price">${cheapest?.specialOffer ? `<strong><s>${won(cheapest.regularPrice)}</s> ${won(cheapest.price)} / 1인</strong><span class="special-badge">특가 ${cheapest.specialOffer.discountRate}%</span>` : `<strong>${won(cheapest?.price)} / 1인</strong><span>시연 가격</span>`}</div>
      ${highlights.length ? `<div class="slot-chips">${highlights.map(slot => `<button class="slot-chip" data-slot-course="${item.id}" data-slot-date="${calendarDate}" data-slot-time="${slot.id}"><b>${slot.time}</b>${won(slot.price).replace('원', '')}<i>${slot.remaining}팀</i></button>`).join('')}</div>` : ''}
      <small class="demo-warning">${demoNotice}</small>
      <div class="card-actions"><button class="outline" data-course="${item.id}">상세보기</button><button data-reserve-course="${item.id}">시연 예약</button></div>
    </div>
  </article>`;
}

/* 8. 골프장 상세 -------------------------------------------------------------
   순서: 대표 이미지 → 핵심 정보 → 날짜·티타임 → 소개·시설 → 요금·규정 */
function detail() {
  const saved = favorites().includes(course.id);
  pushRecentView(course.id);
  const allTimes = timesFor(course);
  const sessionTimes = detailSession === 'all' ? allTimes : allTimes.filter(slot => slot.session === detailSession);
  const rates = ratesFor(course);
  const courseNames = course.courses?.length ? course.courses.map(name => `${name} 코스`).join(' · ') : '코스 정보 확인 중';
  const actualGreen = course.verifiedGreenFee == null ? '가격 확인 필요' : won(course.verifiedGreenFee);
  const header = `<div class="detail-top"><button class="back" data-go="list" aria-label="뒤로">‹</button><div class="detail-course-title"><h1>${esc(course.name)}</h1><button class="heart compact-favorite ${saved ? 'saved' : ''}" data-favorite="${course.id}" aria-label="찜하기">${saved ? '♥' : '♡'}</button></div><div class="detail-actions"><button data-share-course="${course.id}" aria-label="공유하기">⤴</button></div></div>`;

  if (!course.bookable) {
    return `${header}
    <div class="course-hero photo-slide info-hero"><span>전국 골프장 정보</span><small>${esc(course.region)} ${esc(course.city)} · ${holeLabel(course)}</small></div>
    <section class="course-overview"><b>${esc(course.name)}</b><span class="info-badge">ALL:GOLF 예약 미지원</span><span>📍 ${esc(course.address || `${course.region} ${course.city} · 상세 주소 확인 필요`)} · ${holeLabel(course)} · ${typeLabel(course)}</span><p>현재는 골프장 정보만 제공합니다. 확인되지 않은 가격이나 티타임은 표시하지 않습니다.</p><div class="detail-links"><button data-map>지도보기</button><button data-share-course="${course.id}">공유하기</button></div></section>
    <section class="course-info-card" id="course-info"><h2>골프장 정보</h2><dl><div><dt>주소</dt><dd>${esc(course.address || '확인 필요')}</dd></div><div><dt>운영형태</dt><dd>${typeLabel(course)}</dd></div><div><dt>총 홀 수</dt><dd>${holeLabel(course)}</dd></div><div><dt>코스명</dt><dd>${esc(courseNames)}</dd></div><div><dt>대표 전화</dt><dd>${esc(course.phone || '확인 필요')}</dd></div><div><dt>예약 지원</dt><dd>현재 ALL:GOLF 예약 미지원</dd></div></dl>${course.officialWebsite ? `<a class="official-link" href="${course.officialWebsite}" target="_blank" rel="noopener noreferrer">공식 홈페이지</a>` : ''}</section>
    <section class="course-info-card"><h2>정보 출처</h2><p>${esc(course.sourceName || '공개 자료')}</p><p>자료 기준일 ${esc(course.sourceAsOf || course.lastVerified || '확인 필요')}</p>${course.source ? `<a class="official-link" href="${course.source}" target="_blank" rel="noopener noreferrer">출처 확인</a>` : ''}<small class="source-disclaimer">출처 기준일 이후 운영 정보가 변경되었을 수 있습니다. 방문 전 골프장 공식 채널에서 확인해주세요.</small></section>
    <section class="info-box"><h3>예약 안내</h3><p>이 골프장은 전국 정보 검색 대상이며 ALL:GOLF의 실제 또는 시연 예약 재고가 연결되어 있지 않습니다.</p></section>`;
  }

  const openSlots = sessionTimes.filter(slot => !slot.closed && slot.remaining > 0);
  const cheapest = openSlots.slice().sort((a, b) => a.price - b.price)[0];
  return `${header}
  <div class="course-hero photo-slide"><span>시연용 예약 화면</span><small>${esc(course.region)} ${esc(course.city)} · ${holeLabel(course)}</small></div>

  <section class="course-overview key-info">
    <div class="key-row"><b>${esc(course.name)}</b><span class="demo-chip">시연용</span></div>
    <span>📍 ${esc(course.address || `${course.region} ${course.city} · 상세 주소 확인 필요`)}</span>
    <div class="key-chips"><span>${typeLabel(course)}</span><span>${holeLabel(course)}</span><span>${esc(course.city)}</span></div>
    <div class="detail-links"><button data-map>지도보기</button><button data-share-course="${course.id}">공유하기</button><button data-go="favorites">찜한 골프장</button></div>
  </section>

  <div class="detail-tabs"><button class="active" data-scroll="tee-times">예약</button><button data-scroll="course-info">소개·시설</button><button data-scroll="course-layout">코스</button><button data-scroll="fee-info">이용요금</button></div>

  <section class="tee-section" id="tee-times">
    <div class="tee-date-head"><h2 class="tee-title">예약 날짜</h2><button type="button" class="calendar-button" data-sheet aria-label="달력에서 날짜 선택">📅</button></div>
    <div class="date-row">${dateOptions().map(item => `<button type="button" class="date ${date === item.label ? 'active' : ''}" data-date="${item.label}" data-iso="${item.iso}"><strong>${Number(item.iso.slice(5, 7))}/${Number(item.iso.slice(8, 10))}</strong><span>${weekdayLabels[new Date(`${item.iso}T00:00:00`).getDay()]}</span></button>`).join('')}</div>
    <div class="chips session-chips">${['all', '1부', '2부', '3부'].map(value => `<button class="chip ${detailSession === value ? 'active' : ''}" data-session="${value}">${value === 'all' ? '전체' : value}</button>`).join('')}</div>
    <h3 class="tee-subtitle">시연용 티타임 <small>${sessionTimes.length}개 · ${people}명 기준</small></h3>
    <div class="time-list">${sessionTimes.length ? sessionTimes.map(slot => {
      const tooSmall = Number(slot.maxPlayers || 4) < people;
      return `<div class="time ${slot.closed ? 'closed-time' : ''} ${tooSmall ? 'unavailable' : ''}">
        <div class="time-main"><span class="time-session">${slot.session || ''}</span><b>${slot.time}</b>${slot.specialOffer ? `<em class="special-badge">특가 ${slot.specialOffer.discountRate}%</em>` : ''}
        <small>${slot.specialOffer ? `<s>${won(slot.regularPrice)}</s> <strong class="deal-price">${won(slot.price)}</strong>` : won(slot.price)} / 1인 · ${slot.closed ? '예약 마감' : `잔여 ${slot.remaining}팀`}${tooSmall ? ` · ${slot.maxPlayers}인 전용` : ''}</small></div>
        <button class="time-reserve ${slot.closed ? 'wait-tee' : ''}" ${slot.closed || tooSmall ? `data-wait-tee="${slot.id}"` : `data-tee-id="${slot.id}"`}>${slot.closed || tooSmall ? '대기' : '예약'}</button>
      </div>`;
    }).join('') : emptyState(`${sessionLabel(detailSession)} 시간대에 시연 티타임이 없습니다.`, '<button class="primary small-primary" data-wait-pick>빈자리 알림 등록</button>')}</div>
    <button class="secondary wait-open" data-wait-open="${course.id}">원하는 시간이 없나요? 예약 대기 등록</button>
  </section>

  <section class="course-info-card" id="course-info"><h2>소개·시설</h2><p>${esc(course.description || '골프장 소개 확인 필요')}</p><dl><div><dt>주소</dt><dd>${esc(course.address || '확인 필요')}</dd></div><div><dt>운영형태</dt><dd>${typeLabel(course)}</dd></div><div><dt>총 홀 수</dt><dd>${holeLabel(course)}</dd></div><div><dt>코스명</dt><dd>${esc(courseNames)}</dd></div><div><dt>대표 전화</dt><dd>${esc(course.phone || '확인 필요')}</dd></div></dl>${course.officialWebsite ? `<a class="official-link" href="${course.officialWebsite}" target="_blank" rel="noopener noreferrer">공식 홈페이지</a>` : ''}</section>

  <section class="course-info-card" id="course-layout"><h2>코스 정보</h2><p>${esc(courseNames)}</p></section>

  <section class="course-info-card" id="fee-info"><h2>이용요금</h2><dl><div><dt>실제 그린피</dt><dd>${actualGreen}</dd></div><div><dt>시연 그린피</dt><dd>${won(course.demoGreenFee)} / 1인<small>시연 가격 · 실제 판매가 아님</small></dd></div><div><dt>카트비</dt><dd>${rates.cartFee == null ? won(course.demoCartFee) : won(rates.cartFee)} / 팀</dd></div><div><dt>캐디피</dt><dd>${rates.caddieFee == null ? won(course.demoCaddieFee) : won(rates.caddieFee)} / 팀</dd></div><div><dt>3인 플레이</dt><dd>${Number(course.demoThreePlayerSurcharge || 0) ? `1인당 ${won(course.demoThreePlayerSurcharge)} 추가` : '추가금 없음'}</dd></div></dl></section>

  <section class="info-box"><h3>이용 안내</h3><div><span>취소 규정</span><b>${esc(course.cancellationPolicy || '골프장 확인 필요')}</b></div><p class="demo-warning">${demoNotice} · 티타임·가격·잔여팀은 기능 확인을 위한 가상 데이터입니다.</p><small class="source-disclaimer">정보 출처 ${esc(course.sourceName || '공개 자료')} · 기준일 ${esc(course.sourceAsOf || course.lastVerified || '확인 필요')}</small></section>

  <div class="detail-booking-dock"><span>시연 최저가<small>실제 판매가 아님</small><b>${cheapest ? `${won(cheapest.price)}~` : '가격 확인 필요'}</b></span><button data-scroll="tee-times">티타임 보기</button></div>`;
}

/* 9. 예약 / 결제 ------------------------------------------------------------ */
function booking() {
  if (!tee) return `<div class="empty">티타임을 먼저 선택해주세요.<br><button class="primary small-primary" data-go="detail">골프장으로 돌아가기</button></div>`;
  tee = timesFor(course).find(item => item.id === tee.id) || tee;
  const maxPeople = Number(tee.maxPlayers || 4);
  const p = paymentFor(course, tee, people);
  const refundPolicy = { ...shared.DEFAULT_CANCELLATION_POLICY, ...ratesFor(course).cancellationPolicy };
  const policyText = `7일 전 ${refundPolicy.sevenPlus}% · 4~6일 전 ${refundPolicy.fourToSix}% · 2~3일 전 ${refundPolicy.twoToThree}% · 1일 전 ${refundPolicy.oneDay}% · 당일 ${refundPolicy.sameDay}%`;
  const companionFields = Array.from({ length: Math.max(0, people - 1) }, (_, index) => `<label>동반자 ${index + 1} <small>선택</small><input class="field companion-name" data-companion-index="${index}" value="${esc(bookingDraft.companions[index] || '')}" placeholder="동반자 이름"></label>`).join('');

  return `<div class="detail-top"><button class="back" data-go="detail" aria-label="뒤로">‹</button><h1>예약 확인</h1></div>
  <article class="booking-summary">
    <h2>${esc(course.name)}</h2>
    <p>${esc(date)} · <b>${tee.time}</b>${tee.session ? ` · ${tee.session}` : ''} · ${holeLabel(course)}</p>
    <div class="summary-people"><span>예약 인원</span><select id="booking-people">${[2, 3, 4].filter(value => value <= maxPeople).map(value => `<option value="${value}" ${people === value ? 'selected' : ''}>${value}명</option>`).join('')}</select></div>
    ${tee.specialOffer ? `<p class="summary-deal">특가 ${tee.specialOffer.discountRate}% 적용 · 정상가 <s>${won(tee.regularPrice)}</s></p>` : ''}
  </article>

  <section class="payment-box compact-payment">
    <div class="pay-total"><span>총 예상 이용금액</span><b>${won(p.totalEstimated)}</b></div>
    <div class="pay-deposit"><span>지금 결제(시연 예약금)</span><b>${won(p.paidDeposit)}</b></div>
    <details class="pay-details"><summary>요금 내역 보기</summary>
      ${tee.specialOffer ? `<div><span>정상 그린피</span><b><s>${won(p.regularGreenFee)}</s> / 1인</b></div><div class="deal-payment"><span>특가 할인</span><b>-${won(p.discountTotal)} (${tee.specialOffer.discountRate}%)</b></div>` : ''}
      <div><span>그린피</span><b>${won(p.appliedGreenFee - p.playerSurcharge)} × ${people}명</b></div>
      ${p.playerSurcharge ? `<div class="player-surcharge"><span>${people}인 플레이 추가금</span><b>${won(p.playerSurcharge)} / 1인</b></div>` : ''}
      <div><span>카트비</span><b>${won(p.cart)} / 팀</b></div>
      <div><span>캐디피</span><b>${won(p.caddie)} / 팀</b></div>
      <div><span>현장 결제 예정</span><b>${won(p.onsite)}</b></div>
    </details>
    <p class="pay-note">평일·주말과 인원 정책을 반영한 시연 금액입니다. 실제 결제는 발생하지 않습니다.</p>
  </section>

  <section class="form-section">
    <label>예약자 이름<input class="field required" id="booker" value="${esc(bookingDraft.booker)}" placeholder="이름을 입력하세요" autocomplete="name"></label>
    <label>휴대전화번호<input class="field required" id="phone" type="tel" inputmode="tel" maxlength="13" value="${esc(bookingDraft.phone)}" placeholder="010-0000-0000" autocomplete="tel"></label>
    <small class="field-error" id="phone-error" hidden>휴대전화번호 형식을 확인해주세요. (예: 010-1234-5678)</small>
    <div class="companion-section"><h3>동반자 정보 <small>${Math.max(0, people - 1)}명 · 선택 입력</small></h3>${companionFields}</div>
    <label>요청사항 <small>선택</small><input class="field" id="request" value="${esc(bookingDraft.request)}" placeholder="요청사항을 입력하세요"></label>
  </section>

  <details class="policy-details"><summary>취소·환불 규정 보기</summary><p>예약금 환불률: ${policyText}</p><p>${refundPolicy.cutoffHoursBefore == null ? '취소 가능 기한 제한 없음' : `티오프 ${refundPolicy.cutoffHoursBefore}시간 전까지 취소 가능`} · 실제 골프장 정책이 아닙니다.</p></details>

  <label class="agree"><input type="checkbox" id="terms" ${bookingDraft.terms ? 'checked' : ''}> 예약 및 취소 규정에 동의합니다. (필수)</label>
  <label class="agree"><input type="checkbox" id="refund" ${bookingDraft.refund ? 'checked' : ''}> 시연용 취소·환불 정책에 동의합니다. (필수)</label>

  <div class="booking-bar"><span>시연 예약금<b>${won(p.paidDeposit)}</b></span><button class="primary disabled" id="pay" disabled>시연 결제하기</button></div>
  <p class="demo-warning center">${fullDemoNotice}</p>`;
}

function captureBookingDraft() {
  bookingDraft = {
    booker: document.querySelector('#booker')?.value.trim() || bookingDraft.booker,
    phone: document.querySelector('#phone')?.value.trim() || bookingDraft.phone,
    request: document.querySelector('#request')?.value.trim() || bookingDraft.request,
    companions: [...document.querySelectorAll('.companion-name')].map(input => input.value.trim()),
    terms: document.querySelector('#terms')?.checked ?? bookingDraft.terms,
    refund: document.querySelector('#refund')?.checked ?? bookingDraft.refund
  };
}
function releaseActiveHold() {
  if (activeHold && shared?.releaseTeeHold) shared.releaseTeeHold(activeHold.id, bookingSessionId);
  activeHold = null;
  if (holdTicker) { clearInterval(holdTicker); holdTicker = null; }
}
function reserve() {
  captureBookingDraft();
  const name = bookingDraft.booker;
  const phone = formatPhone(bookingDraft.phone);
  const request = bookingDraft.request;
  const companions = bookingDraft.companions.filter(Boolean);
  if (!name) { toast('예약자 이름을 입력해주세요.'); document.querySelector('#booker')?.focus(); return; }
  if (!isValidPhone(phone)) { toast('휴대전화번호 형식을 확인해주세요.'); document.querySelector('#phone')?.focus(); return; }

  tee = timesFor(course).find(item => item.id === tee.id) || tee;
  const p = paymentFor(course, tee, people);
  const holdResult = shared?.acquireTeeHold ? shared.acquireTeeHold(course.id, calendarDate, tee.id, bookingSessionId) : { ok: true, hold: null };
  if (!holdResult.ok) {
    modal(`<h2>잠시 예약할 수 없습니다</h2><p>${holdResult.reason === 'held_by_other' ? '다른 사용자가 이 티타임의 결제를 진행 중입니다. 잠시 후 다시 시도해주세요.' : '방금 마감된 티타임입니다. 다른 시간을 선택해주세요.'}</p><button class="primary" id="close-modal">확인</button>`);
    return;
  }
  activeHold = holdResult.hold;
  const closePayment = () => { releaseActiveHold(); modal(); };

  modal(`<h2>시연 결제 확인</h2><p>${esc(course.name)}<br>${esc(date)} ${tee.time} · <b>${people}명</b></p>
    <div class="hold-notice"><b>티타임 임시 확보</b><span>중복 예약을 막기 위해 5분 동안 확보합니다.</span><span class="hold-countdown" id="hold-countdown">남은 시간 05:00</span></div>
    <strong>시연 예약금 ${won(p.paidDeposit)}</strong>
    <p class="modal-note">${demoNotice}</p>
    <div class="modal-actions"><button class="home-button" id="close-modal">돌아가기</button><button class="primary" id="confirm-reserve">시연 결제 완료</button></div>`);

  const countdown = document.querySelector('#hold-countdown');
  const expiresAt = activeHold ? new Date(activeHold.expiresAt).getTime() : Date.now() + 5 * 60 * 1000;
  const tick = () => {
    const left = Math.max(0, expiresAt - Date.now());
    const minutes = String(Math.floor(left / 60000)).padStart(2, '0');
    const seconds = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
    if (countdown) countdown.textContent = `남은 시간 ${minutes}:${seconds}`;
    if (left <= 0) {
      clearInterval(holdTicker); holdTicker = null; activeHold = null;
      const confirmButton = document.querySelector('#confirm-reserve');
      if (confirmButton) { confirmButton.disabled = true; confirmButton.textContent = '시간 만료'; }
      if (countdown) countdown.textContent = '임시 확보 시간이 끝났습니다.';
    }
  };
  tick();
  if (holdTicker) clearInterval(holdTicker);
  holdTicker = setInterval(tick, 1000);

  document.querySelector('#close-modal').onclick = closePayment;
  document.querySelector('.modal-backdrop').onclick = closePayment;
  document.querySelector('#confirm-reserve').onclick = event => {
    if (event.target.disabled) return;
    event.target.disabled = true;
    event.target.textContent = '처리 중...';
    setTimeout(() => {
      const selectedTeeId = tee.id;
      const latestTee = timesFor(course).find(item => item.id === selectedTeeId);
      if (!latestTee || latestTee.closed || latestTee.remaining < 1) {
        releaseActiveHold();
        modal('<h2>예약 불가</h2><p>방금 마감된 티타임입니다. 다른 시간을 선택해주세요.</p><button class="primary" id="close-modal">확인</button>');
        return;
      }
      const selectedTee = { ...latestTee };
      const special = selectedTee.specialOffer ? { ...selectedTee.specialOffer } : null;
      const latestPayment = paymentFor(course, selectedTee, people);
      const policySnapshot = { ...ratesFor(course).cancellationPolicy };
      const committed = activeHold && shared?.commitTeeHold ? shared.commitTeeHold(activeHold.id, bookingSessionId) : { ok: !shared || shared.reserveTee(course.id, calendarDate, selectedTee.time) };
      releaseActiveHold();
      if (!committed.ok) {
        modal('<h2>예약 불가</h2><p>임시 확보 시간이 끝났거나 다른 예약이 먼저 완료되었습니다. 다시 선택해주세요.</p><button class="primary" id="close-modal">확인</button>');
        return;
      }
      const serial = String(Date.now()).slice(-5);
      const ymd = calendarDate.replaceAll('-', '').slice(2);
      const item = {
        id: `r-${Date.now()}`, number: `AG-${ymd}-${serial}`, courseId: course.id, courseName: course.name,
        date, dateISO: calendarDate, time: selectedTee.time, teeTimeId: selectedTee.id || `${course.id}::${calendarDate}::${selectedTee.time}`,
        people, companions, holes: course.holes, booker: name, phone, request,
        baseGreenFee: latestPayment.baseAppliedGreenFee, playerSurcharge: latestPayment.playerSurcharge,
        regularGreenFee: latestPayment.regularGreenFee, appliedGreenFee: latestPayment.appliedGreenFee,
        discountAmount: latestPayment.discountTotal, greenFee: latestPayment.appliedGreenFee, greenTotal: latestPayment.greenTotal,
        cart: latestPayment.cart, caddie: latestPayment.caddie, totalEstimated: latestPayment.totalEstimated,
        paidDeposit: latestPayment.paidDeposit, online: latestPayment.paidDeposit, onsite: latestPayment.onsite,
        pricingSnapshot: { dateType: isWeekendISO(calendarDate) ? 'weekend' : 'weekday', people, playerSurcharge: latestPayment.playerSurcharge },
        specialOfferId: special?.id || null, specialOfferName: special?.name || null,
        specialOfferSnapshot: special ? { id: special.id, name: special.name, regularPrice: special.regularPrice, specialPrice: special.specialPrice, discountRate: special.discountRate, roundDate: special.roundDate, time: special.time } : null,
        cancellationPolicySnapshot: policySnapshot, paymentStatus: 'demo_paid', status: 'confirmed', demo: true, createdAt: new Date().toISOString()
      };
      setReservations([item, ...getReservations()]);
      localStorage.setItem('allGolfLastReservation', item.id);
      pushRecentSearch({ query, region, city, date: calendarDate, people });
      bookingDraft = { booker: '', phone: '', request: '', companions: [], terms: false, refund: false };
      currentReservationId = item.id;
      modal();
      go('complete');
    }, 350);
  };
}

function complete() {
  const reservation = findReservation(localStorage.getItem('allGolfLastReservation')) || findReservation(currentReservationId);
  if (!reservation) return `<div class="empty">최근 예약 내역이 없습니다.<br><button class="primary small-primary" data-go="home">홈으로</button></div>`;
  return `<section class="complete">
    <div class="complete-check">✓</div>
    <div class="kicker">시연용 예약</div>
    <h1>시연용 예약이 완료되었습니다.</h1>
    <p>${esc(reservation.courseName)}<br>${esc(reservation.date)} · ${esc(reservation.time)}<br><b>${reservation.people}명 플레이</b> · ${reservation.holes ? `${reservation.holes}홀` : '홀 수 확인 필요'}</p>
    ${reservation.companions?.length ? `<div class="complete-companions"><span>동반자</span><b>${esc(reservation.companions.join(' · '))}</b></div>` : ''}
    <article class="confirm-number"><span>시연 예약번호</span><b>${esc(reservation.number)}</b></article>
    <p class="muted">${fullDemoNotice}<br>실제 골프장에 예약이 접수되거나 알림톡이 발송되지는 않습니다.</p>
    <div class="complete-actions"><button class="primary" data-reservation-open="${reservation.number}">예약 상세 보기</button></div>
    <button class="secondary" data-ics="${reservation.number}">📅 일정 저장(.ics)</button>
    <button class="home-button" data-go="home">홈으로</button>
  </section>`;
}
/* 10. 내 예약 ---------------------------------------------------------------- */
function my() {
  const all = getReservations();
  const upcoming = all.filter(item => !isCancelledReservation(item) && !isPastReservation(item));
  const past = all.filter(item => !isCancelledReservation(item) && isPastReservation(item));
  const cancelled = all.filter(isCancelledReservation);
  const items = myTab === 'upcoming' ? upcoming : myTab === 'past' ? past : cancelled;

  return `<div class="my-top"><h1>내 예약</h1><p>예약 내역과 대기·알림을 한곳에서 확인하세요.</p></div>
  <div class="my-quick">
    <button data-go="favorites">♥ 찜한 골프장 ${favorites().length}</button>
    <button data-go="waitlist">⏳ 예약 대기 ${shared.getWaitlist().filter(item => item.status === 'active').length}</button>
    <button data-go="notifications">🔔 알림 ${shared.getNotifications().filter(item => !item.read).length}</button>
  </div>
  <div class="tabs">
    <button class="${myTab === 'upcoming' ? 'active' : ''}" data-mytab="upcoming">다가오는 ${upcoming.length}</button>
    <button class="${myTab === 'past' ? 'active' : ''}" data-mytab="past">지난 ${past.length}</button>
    <button class="${myTab === 'cancelled' ? 'active' : ''}" data-mytab="cancelled">취소 ${cancelled.length}</button>
  </div>
  <div class="reservation-list">${items.map(resCard).join('') || emptyState(myTab === 'cancelled' ? '취소된 예약이 없습니다.' : myTab === 'past' ? '지난 예약이 없습니다.' : '다가오는 예약이 없습니다.', '<button class="primary small-primary" data-go="list">골프장 찾기</button>')}</div>`;
}

function resCard(reservation) {
  const cancelled = isCancelledReservation(reservation);
  const past = isPastReservation(reservation);
  const dday = dDayLabel(reservation);
  return `<article class="reservation-card">
    <div class="res-head"><span class="status ${cancelled ? 'cancelled' : past ? 'past' : ''}">${reservation.demo ? '시연용 · ' : ''}${reservationStatusLabel(reservation)}</span>${dday ? `<b class="dday">${dday}</b>` : ''}</div>
    <h3>${esc(reservation.courseName || reservation.course || '골프장')}</h3>
    <p>${esc(reservation.date)} · <b>${esc(reservation.time)}</b> · ${reservation.people}명 플레이</p>
    ${reservation.companions?.length ? `<p class="companion-summary">동반자 ${esc(reservation.companions.join(' · '))}</p>` : ''}
    <div class="res-meta">
      <span>예약번호 <b>${esc(reservation.number || '-')}</b></span>
      <span>시연 예약금 <b>${won(reservation.paidDeposit ?? reservation.online ?? reservation.deposit)}</b></span>
      ${cancelled ? `<span>시연 환불 ${won(reservation.refundAmount || 0)} · ${reservation.refundStatus === 'demo_refunded' ? '환불 완료' : '처리 확인 필요'}</span>` : ''}
    </div>
    <div class="res-actions">
      <button class="secondary" data-reservation-open="${reservation.number || reservation.id}">예약 상세</button>
      ${cancelled ? `<button class="secondary" data-rebook="${reservation.courseId}">다시 예약</button>` : `<button class="secondary" data-ics="${reservation.number || reservation.id}">📅 일정 저장</button>`}
    </div>
  </article>`;
}

/* 11. 예약 상세 (재조회) ----------------------------------------------------- */
function reservationPage() {
  const reservation = findReservation(currentReservationId);
  if (!reservation) return `<div class="detail-top"><button class="back" data-go="my" aria-label="뒤로">‹</button><h1>예약 상세</h1></div>${emptyState('예약 정보를 찾을 수 없습니다.', '<button class="primary small-primary" data-go="my">내 예약으로</button>')}`;
  const target = courses.find(item => item.id === reservation.courseId);
  const cancelled = isCancelledReservation(reservation);
  const cancelInfo = shared?.calculateCancellation ? shared.calculateCancellation(reservation) : null;
  const greenPerPerson = Number(reservation.appliedGreenFee ?? reservation.greenFee ?? 0);
  const surcharge = Number(reservation.playerSurcharge || 0);
  const greenSubtotal = Number(reservation.greenTotal || (greenPerPerson * Number(reservation.people || 0)));
  const total = Number(reservation.totalEstimated || 0);
  const deposit = Number(reservation.paidDeposit ?? reservation.online ?? 0);
  const onsite = Number(reservation.onsite ?? Math.max(0, total - deposit));
  const deadlineText = cancelInfo?.deadlineAt
    ? new Date(cancelInfo.deadlineAt).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '별도 기한 없음 · 날짜별 환불률 적용';

  return `<div class="detail-top"><button class="back" data-go="my" aria-label="뒤로">‹</button><h1>예약 상세</h1><div class="detail-actions"><button data-share-reservation="${reservation.number || reservation.id}" aria-label="공유하기">⤴</button></div></div>
  <article class="reservation-detail-card">
    <div class="res-head"><span class="status ${cancelled ? 'cancelled' : ''}">${reservationStatusLabel(reservation)}</span>${dDayLabel(reservation) ? `<b class="dday">${dDayLabel(reservation)}</b>` : ''}</div>
    <h2>${esc(reservation.courseName)}</h2>
    <p class="res-when">${esc(reservation.date)} · <b>${esc(reservation.time)}</b><br>${reservation.people}명 플레이 · ${reservation.holes ? `${reservation.holes}홀` : '홀 수 확인 필요'}</p>
    ${reservation.companions?.length ? `<p class="res-line"><span>동반자</span><b>${esc(reservation.companions.join(' · '))}</b></p>` : ''}
    <p class="res-line"><span>예약번호</span><b>${esc(reservation.number || '-')}</b></p>
    <p class="res-line"><span>예약자</span><b>${esc(reservation.booker || '-')} · ${esc(reservation.phone || '-')}</b></p>
    ${reservation.request ? `<p class="res-line"><span>요청사항</span><b>${esc(reservation.request)}</b></p>` : ''}
    ${target?.address ? `<p class="res-line"><span>주소</span><b>${esc(target.address)}</b></p>` : ''}
  </article>

  <section class="payment-box">
    <h3 class="box-title">요금 내역</h3>
    ${reservation.specialOfferSnapshot ? `<div><span>정상 그린피</span><b><s>${won(reservation.specialOfferSnapshot.regularPrice + surcharge)}</s> / 1인</b></div><div class="deal-payment"><span>특가 ${reservation.specialOfferSnapshot.discountRate}% 할인</span><b>-${won(reservation.discountAmount || (reservation.specialOfferSnapshot.regularPrice - reservation.specialOfferSnapshot.specialPrice) * reservation.people)}</b></div>` : ''}
    <div><span>그린피</span><b>${won(greenPerPerson)} × ${reservation.people}명 = ${won(greenSubtotal)}</b></div>
    ${surcharge ? `<div class="player-surcharge"><span>${reservation.people}인 플레이 추가금</span><b>${won(surcharge)} / 1인 포함</b></div>` : ''}
    <div><span>카트비</span><b>${won(reservation.cart)} / 팀</b></div>
    <div><span>캐디피</span><b>${won(reservation.caddie)} / 팀</b></div>
    <hr>
    <div><span>총 예상 이용금액</span><b>${won(total)}</b></div>
    <div class="mint"><span>결제한 시연 예약금</span><b>${won(deposit)}</b></div>
    <div><span>현장 결제 예정</span><b>${won(onsite)}</b></div>
  </section>

  <section class="cancel-card ${cancelled ? 'done' : ''}">
    <h3 class="box-title">${cancelled ? '취소·환불 완료' : '취소 기한과 환불 예상'}</h3>
    ${cancelled
      ? `<p class="res-line"><span>취소일</span><b>${reservation.cancelledAt ? new Date(reservation.cancelledAt).toLocaleString('ko-KR') : '-'}</b></p>
         <p class="res-line"><span>환불 금액</span><b>${won(reservation.refundAmount || 0)}</b></p>
         <p class="res-line"><span>취소 수수료</span><b>${won(reservation.cancellationFee || 0)}</b></p>`
      : `<p class="res-line"><span>취소 가능 기한</span><b>${deadlineText}</b></p>
         <p class="res-line"><span>지금 취소하면</span><b>환불 ${won(cancelInfo?.refundAmount || 0)} (${cancelInfo?.refundRate || 0}%)</b></p>
         <p class="res-line"><span>예상 취소 수수료</span><b>${won(cancelInfo?.cancellationFee || 0)}</b></p>
         <small class="source-disclaimer">시연용 정책으로 계산한 금액이며 실제 환불이 아닙니다.</small>`}
  </section>

  <div class="detail-action-grid">
    <button class="secondary" data-ics="${reservation.number || reservation.id}">📅 일정 저장(.ics)</button>
    <button class="secondary" data-share-reservation="${reservation.number || reservation.id}">🔗 공유</button>
    <button class="secondary" data-rebook="${reservation.courseId}">🔁 같은 골프장 재예약</button>
    ${cancelled ? '' : `<button class="secondary danger" data-cancel="${reservation.number || reservation.id}">예약 취소</button>`}
  </div>
  <p class="demo-warning center">${fullDemoNotice}</p>`;
}

/* 12. 찜한 골프장 (날짜 연동) ------------------------------------------------- */
function favoritesPage() {
  const saved = favorites().map(id => courses.find(item => item.id === id)).filter(Boolean);
  return `<div class="result-top"><button class="back" data-go="my" aria-label="뒤로">‹</button><h1>찜한 골프장</h1></div>
  <p class="page-desc">선택한 날짜의 시연 티타임과 가격을 바로 확인하세요.</p>
  <div class="date-row">${dateOptions(favDate).map(item => `<button type="button" class="date ${favDate === item.iso ? 'active' : ''}" data-fav-date="${item.iso}"><strong>${Number(item.iso.slice(5, 7))}/${Number(item.iso.slice(8, 10))}</strong><span>${weekdayLabels[new Date(`${item.iso}T00:00:00`).getDay()]}</span></button>`).join('')}</div>
  <div class="favorite-list">${saved.map(favoriteCard).join('') || emptyState('아직 찜한 골프장이 없습니다.<br>마음에 드는 골프장의 ♡ 를 눌러보세요.', '<button class="primary small-primary" data-go="list">골프장 찾기</button>')}</div>`;
}

function favoriteCard(item) {
  const slots = openTimesFor(item, favDate);
  const cheapest = slots.slice().sort((a, b) => a.price - b.price)[0];
  const highlights = slots.slice(0, 3);
  return `<article class="favorite-card">
    <div class="favorite-card-head"><div><h3>${esc(item.name)}</h3><p>${esc(item.region)} · ${esc(item.city)} · ${holeLabel(item)}</p></div><button class="heart saved" data-favorite="${item.id}" aria-label="찜 해제">♥</button></div>
    ${item.bookable && cheapest ? `<div class="favorite-info"><b>${won(cheapest.price)} / 1인부터 · 시연용</b><span>${shortDate(favDate)} 기준 티타임 ${slots.length}개</span></div>
      <div class="slot-chips">${highlights.map(slot => `<button class="slot-chip" data-slot-course="${item.id}" data-slot-date="${favDate}" data-slot-time="${slot.id}"><b>${slot.time}</b>${won(slot.price).replace('원', '')}<i>${slot.remaining}팀</i></button>`).join('')}</div>`
      : `<div class="favorite-info none"><b>${item.bookable ? '선택한 날짜에 티타임이 없습니다' : '현재 ALL:GOLF 예약 미지원'}</b><span>${item.bookable ? '다른 날짜를 선택하거나 대기 등록을 이용하세요.' : '공식 골프장 정보만 제공됩니다.'}</span></div>`}
    <div class="card-actions"><button class="outline favorite-detail" data-course="${item.id}">상세보기</button>${item.bookable ? `<button class="favorite-detail" data-wait-open="${item.id}">빈자리 알림</button>` : ''}</div>
  </article>`;
}

/* 13. 예약 대기 ------------------------------------------------------------- */
function waitlistPage() {
  const items = shared.getWaitlist();
  const notes = shared.getNotifications();
  return `<div class="detail-top"><button class="back" data-go="my" aria-label="뒤로">‹</button><h1>내 예약 대기</h1></div>
  <p class="notice">${fullDemoNotice} 빈자리 알림은 예약 확정이 아니며, 알림을 받은 뒤 예약을 완료해야 합니다.</p>
  <button class="primary wide" data-wait-pick>+ 새 대기 등록</button>
  <div class="reservation-list">${items.map(item => {
    const target = courses.find(entry => entry.id === item.courseId);
    const alertNote = notes.find(note => note.waitId === item.id);
    return `<article class="reservation-card">
      <div class="res-head"><span class="status ${item.status === 'active' ? '' : 'past'}">${({ active: '대기 중', cancelled: '취소', completed: '예약 완료로 정리', expired: '만료' })[item.status] || item.status}</span>${alertNote ? '<b class="dday">빈자리 알림</b>' : ''}</div>
      <h3>${esc(target?.name || '골프장')}</h3>
      <p>${esc(item.date)} · ${esc(item.fromTime)}~${esc(item.toTime)} · ${item.people}명 · 최대 ${won(item.maxPrice)} / 1인</p>
      ${item.teeTimeId ? `<p class="companion-summary">지정 티타임 대기</p>` : ''}
      ${alertNote ? `<p class="wait-alert">희망 조건의 티타임이 열렸습니다. <button class="text-link" data-notification="${alertNote.id}">예약으로 이어가기</button></p>` : ''}
      <div class="res-actions">
        ${item.status === 'active' ? `<button class="secondary" data-wait-edit="${item.id}">조건 수정</button><button class="secondary" data-wait-cancel="${item.id}">대기 취소</button>` : ''}
        ${alertNote ? `<button class="secondary" data-notification="${alertNote.id}">알림 보기</button>` : ''}
      </div>
    </article>`;
  }).join('') || emptyState('등록한 대기가 없습니다.', '<button class="primary small-primary" data-wait-pick>대기 등록</button>')}</div>`;
}

function openWaitModal(courseId = null, teeId = null, waitId = null) {
  const existing = waitId ? shared.getWaitlist().find(item => item.id === waitId) : null;
  const selected = courses.find(item => item.id === (courseId || existing?.courseId)) || null;
  const slot = teeId && selected ? timesFor(selected, existing?.date || calendarDate).find(item => item.id === teeId) : null;
  const dateValue = existing?.date || calendarDate;
  const peopleValue = Number(existing?.people || (people === 3 ? 3 : 4));
  const courseField = selected
    ? `<p class="wait-course-fixed">${esc(selected.name)} <button class="text-link" data-wait-repick>골프장 변경</button></p>`
    : `<label>골프장<input id="wait-course" list="wait-course-list" placeholder="골프장 이름을 입력하세요" autocomplete="off"><datalist id="wait-course-list">${courses.filter(item => item.bookable).map(item => `<option value="${esc(item.name)}">${esc(item.region)} · ${esc(item.city)}</option>`).join('')}</datalist></label>`;

  modal(`<h2>${existing ? '대기 조건 수정' : '빈자리 알림 등록'}</h2>
    <p>희망 조건의 취소 티타임이 생기면 이 브라우저의 알림함에 표시합니다. 문자·카카오톡은 발송되지 않습니다.</p>
    ${courseField}
    <label>희망 날짜<input id="wait-date" type="date" min="${todayISO}" value="${dateValue}" ${slot ? 'readonly' : ''}></label>
    ${slot ? `<p class="wait-slot">대기 티타임 <b>${slot.time}</b> · 현재 잔여 ${slot.remaining}팀</p>` : `<div class="wait-range"><label>시작<input id="wait-from" type="time" value="${existing?.fromTime || '06:00'}"></label><label>종료<input id="wait-to" type="time" value="${existing?.toTime || '18:00'}"></label></div>`}
    <label>신청자 이름<input id="wait-name" maxlength="40" value="${esc(existing?.applicantName || bookingDraft.booker || '')}" placeholder="이름"></label>
    <label>휴대전화번호<input id="wait-phone" inputmode="tel" maxlength="13" value="${esc(existing?.applicantPhone ? formatPhone(existing.applicantPhone) : formatPhone(bookingDraft.phone))}" placeholder="010-0000-0000"></label>
    <label>인원<select id="wait-people"><option value="3" ${peopleValue === 3 ? 'selected' : ''}>3명</option><option value="4" ${peopleValue === 4 ? 'selected' : ''}>4명</option></select></label>
    <label>최대 1인 가격<input id="wait-price" type="number" min="0" inputmode="numeric" value="${existing?.maxPrice || slot?.price || 200000}"></label>
    <p class="modal-note">${fullDemoNotice} 신청자 정보는 현재 브라우저에만 저장됩니다.</p>
    <div class="modal-actions"><button class="home-button" id="close-modal">닫기</button><button class="primary" id="wait-save">${existing ? '조건 저장' : '대기 등록'}</button></div>`);

  const resolveCourse = () => {
    if (selected) return selected;
    const typed = document.querySelector('#wait-course')?.value.trim() || '';
    return courses.find(item => item.name === typed) || courses.find(item => item.bookable && item.name.includes(typed) && typed.length > 1) || null;
  };
  document.querySelector('#wait-repick')?.addEventListener('click', () => openWaitModal(null, null, waitId));
  document.querySelector('#wait-save').onclick = () => {
    const target = resolveCourse();
    if (!target) { toast('골프장을 선택해주세요.'); return; }
    const phoneValue = formatPhone(document.querySelector('#wait-phone').value);
    if (!isValidPhone(phoneValue)) { toast('휴대전화번호 형식을 확인해주세요.'); return; }
    if (existing) shared.cancelWait(existing.id);
    const result = shared.saveWait({
      courseId: target.id,
      date: document.querySelector('#wait-date').value,
      teeTimeId: slot?.id,
      fromTime: slot?.time || document.querySelector('#wait-from').value,
      toTime: slot?.time || document.querySelector('#wait-to').value,
      people: Number(document.querySelector('#wait-people').value),
      maxPrice: Number(document.querySelector('#wait-price').value),
      applicantName: document.querySelector('#wait-name').value.trim(),
      applicantPhone: phoneValue
    });
    if (!result.ok) {
      if (existing) shared.saveWait({ ...existing });   // 수정 실패 시 기존 대기 복원
      alert(result.message);
      return;
    }
    modal();
    toast(existing ? '대기 조건을 수정했습니다.' : '대기를 등록했습니다.');
    go('waitlist');
  };
}

function notificationsPage() {
  const items = shared.getNotifications();
  return `<div class="detail-top"><button class="back" data-go="my" aria-label="뒤로">‹</button><h1>알림함</h1></div>
  <p class="notice">앱을 열었을 때 확인하는 시연용 알림입니다. 문자·알림톡은 발송되지 않습니다.</p>
  ${items.map(item => `<article class="reservation-card notification-card">
    <div class="res-head"><span class="status ${item.read ? 'past' : ''}">${item.read ? '읽음' : '새 알림'}</span></div>
    <h3>${esc(courses.find(entry => entry.id === item.courseId)?.name || '골프장')}</h3>
    <p>${esc(item.date)} ${esc(item.time)} · ${won(item.price)} / 1인</p>
    <p>${esc(item.message)}<br><small>${esc(String(item.createdAt).slice(0, 16).replace('T', ' '))}</small></p>
    <div class="res-actions"><button class="secondary" data-notification="${item.id}">티타임 보기 · 예약하기</button></div>
  </article>`).join('') || emptyState('알림이 없습니다.')}`;
}

/* 14. 혜택 (예약과 분리) ----------------------------------------------------- */
function benefits() {
  const offers = activeOffers();
  return `<div class="benefit-head"><div class="kicker">ALL:GOLF 시연용 혜택</div><h1>혜택</h1><p>쿠폰·이벤트는 모두 샘플이며 실제로 적용되지 않습니다. 예약과 별개로 둘러보세요.</p></div>
  <section class="benefit-section"><div class="section-head"><div><h2>내 쿠폰 <em>3장</em></h2><small class="sample-tag">샘플</small></div><button class="text-link" data-benefit="coupons">쿠폰 전체보기</button></div><div class="coupon-stack"><article><span class="coupon-badge">첫 예약</span><b>10,000원 할인</b><small>샘플 쿠폰 · 실제 결제 없음</small></article><article><span class="coupon-badge">평일 한정</span><b>평일 라운드 5% 할인</b><small>샘플 쿠폰 · 실제 결제 없음</small></article><article><span class="coupon-badge">친구 초대</span><b>20,000원 할인</b><small>샘플 쿠폰 · 실제 결제 없음</small></article></div></section>
  <section class="benefit-section"><div class="section-head"><div><div class="kicker">한정 수량</div><h2>오늘의 특가</h2></div></div><div class="deal-list">${offers.length ? offers.map(specialCard).join('') : '<div class="empty compact-empty">현재 판매 중인 시연 특가가 없습니다.</div>'}</div></section>
  <section class="benefit-section member-benefit"><div class="section-head"><div><div class="kicker">회원 전용</div><h2>ALL:GOLF 회원 혜택</h2></div></div><ul><li><b>첫 예약 할인</b><span>첫 예약 시 10,000원 자동 할인 (샘플)</span></li><li><b>조인 수수료 할인</b><span>회원 전용 조인 제휴 혜택 · 준비 중</span></li><li><b>취소티 우선 알림</b><span>원하는 티타임을 빠르게 만나보세요</span></li></ul></section>
  <section class="benefit-section"><div class="section-head"><h2>진행 중인 이벤트</h2><span class="soon">샘플</span></div><div class="event-grid"><article class="event-card invite"><span>초대 이벤트</span><h3>친구 초대 이벤트</h3><p>친구가 첫 예약을 완료하면<br>나도 친구도 20,000원 할인 (샘플)</p><button data-benefit="invite">자세히 보기</button></article><article class="event-card summer"><span>8월 한정</span><h3>여름 라운드 특가</h3><p>제휴 골프장 최대 30% 할인 (샘플)</p><button data-benefit="summer">혜택 확인</button></article></div></section>
  <section class="benefit-section"><div class="section-head"><h2>제휴 혜택</h2><span class="soon">준비 중</span></div><div class="partner-benefit"><article><i>⛳</i><b>골프장 제휴 할인</b><span>준비 중입니다</span></article><article><i>👟</i><b>골프용품 할인</b><span>준비 중입니다</span></article><article><i>✈</i><b>골프여행 특별가</b><span>준비 중입니다</span></article></div></section>
  <p class="footer-note">${fullDemoNotice}</p>`;
}

/* 15. 준비 중 화면 ----------------------------------------------------------- */
function readyPage(kind) {
  const config = {
    join: { icon: '🤝', title: '조인', desc: '함께 라운드할 동반자를 찾는 기능입니다.', detail: '조인 매칭, 수수료 정산, 팀 채팅은 다음 단계에서 제공될 예정입니다.' },
    lesson: { icon: '🏌', title: '골프레슨', desc: '프로 레슨 예약 기능입니다.', detail: '레슨 검색·예약·결제는 다음 단계에서 제공될 예정입니다.' },
    travel: { icon: '✈', title: '골프여행', desc: '골프 패키지 상품입니다.', detail: '항공·숙박이 포함된 골프여행 상품은 다음 단계에서 제공될 예정입니다.' }
  }[kind] || { icon: '⏳', title: '준비 중', desc: '', detail: '' };
  return `<div class="detail-top"><button class="back" data-go="home" aria-label="뒤로">‹</button><h1>${config.title}</h1></div>
  <section class="ready-page">
    <div class="ready-icon">${config.icon}</div>
    <span class="ready-badge">준비 중</span>
    <h2>${config.title}은 준비 중입니다</h2>
    <p>${config.desc}<br>${config.detail}</p>
    <div class="ready-actions">
      <button class="primary" data-go="list">골프장 예약하기</button>
      <button class="secondary" data-go="home">홈으로</button>
    </div>
    <p class="demo-warning">예약·찜·대기·알림 기능은 지금 바로 사용할 수 있습니다.</p>
  </section>`;
}
function simplePage(title, text) { return readyPage(title); }
/* 16. 화면 이동 / 모달 / 시트 ------------------------------------------------ */
const go = next => {
  if (next === 'home') {
    calendarDate = todayISO;
    dateAnchor = todayISO;
    date = formatCalendarDate(todayISO);
    tee = null;
  }
  page = next;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};
function modal(html = '') {
  const layer = document.querySelector('#modal');
  if (modalCleanup) { modalCleanup(); modalCleanup = null; }
  layer.innerHTML = html ? `<div class="modal-backdrop"></div><div class="modal-box">${html}</div>` : '';
  if (html) {
    layer.querySelector('.modal-backdrop').onclick = () => modal();
    layer.querySelector('#close-modal')?.addEventListener('click', () => modal());
  }
}
const sheetRegion = document.querySelector('#sheet-region');
const sheetCity = document.querySelector('#sheet-city');
function renderSheetDates() {
  const holder = document.querySelector('#sheet-date');
  if (!holder) return;
  holder.innerHTML = dateOptions().map(({ iso, label }) => `<button type="button" class="${iso === calendarDate ? 'selected' : ''}" data-date="${iso}">${label.replace(/^\d{4}년 /, '')}</button>`).join('');
  holder.querySelectorAll('button').forEach(button => {
    button.onclick = () => {
      holder.querySelectorAll('button').forEach(item => item.classList.remove('selected'));
      button.classList.add('selected');
      document.querySelector('#calendar-date').value = button.dataset.date;
    };
  });
}
function updateSheetCities(selected) {
  const previous = sheetCity.value;
  sheetCity.innerHTML = '<option value="">전체 시·군</option>' + citiesFor(selected).map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
  if (citiesFor(selected).includes(previous)) sheetCity.value = previous;
}
function openSheet() {
  sheetRegion.querySelectorAll('button').forEach(button => button.classList.toggle('selected', button.dataset.region === region));
  document.querySelectorAll('#sheet-people button').forEach(button => button.classList.toggle('selected', Number(button.dataset.people) === people));
  updateSheetCities(region);
  sheetCity.value = city;
  document.querySelector('#calendar-date').value = calendarDate;
  renderSheetDates();
  document.querySelector('#sheet').classList.add('open');
}
function closeSheet() { document.querySelector('#sheet').classList.remove('open'); }

function shareCourseModal(courseId) {
  const item = courses.find(entry => entry.id === courseId) || course;
  const url = shareLink({ courseId: item.id, dateISO: calendarDate, people });
  const text = `${item.name} · ${formatCalendarDate(calendarDate)} · ${people}명`;
  modal(`<h2>공유하기</h2><p>${esc(item.name)}<br>${esc(formatCalendarDate(calendarDate))} · ${people}명</p>
    <div class="share-link"><input id="share-url" readonly value="${esc(url)}"></div>
    <p class="modal-note">링크를 받은 사람은 같은 조건(골프장·날짜·인원)으로 앱을 열게 됩니다.</p>
    <div class="modal-actions"><button class="home-button" id="copy-share">링크 복사</button><button class="primary" id="native-share">공유하기</button></div>
    <button class="home-button" id="close-modal">닫기</button>`);
  document.querySelector('#copy-share').onclick = async () => {
    const ok = await copyText(url);
    toast(ok ? '링크를 복사했습니다.' : '복사가 되지 않았습니다. 링크를 길게 눌러 복사해주세요.');
  };
  document.querySelector('#native-share').onclick = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: 'ALL:GOLF', text, url }); return; } catch { /* 사용자가 취소 */ }
    }
    const ok = await copyText(url);
    toast(ok ? '공유 링크를 복사했습니다.' : '공유를 지원하지 않는 환경입니다.');
  };
}
function shareReservationModal(reference) {
  const reservation = findReservation(reference);
  if (!reservation) { toast('예약을 찾을 수 없습니다.'); return; }
  const url = shareLink({ courseId: reservation.courseId, dateISO: reservation.dateISO, people: reservation.people, time: reservation.time });
  const text = `[ALL:GOLF 시연 예약] ${reservation.courseName} · ${reservation.date} · ${reservation.time} · ${reservation.people}명 · 예약번호 ${reservation.number}`;
  modal(`<h2>예약 공유</h2><p>${esc(text)}</p>
    <div class="share-link"><input id="share-url" readonly value="${esc(url)}"></div>
    <div class="modal-actions"><button class="home-button" id="copy-share">링크 복사</button><button class="primary" id="native-share">공유하기</button></div>
    <button class="home-button" id="ics-from-modal">📅 일정 저장(.ics)</button>
    <button class="home-button" id="close-modal">닫기</button>`);
  document.querySelector('#copy-share').onclick = async () => {
    const ok = await copyText(url);
    toast(ok ? '링크를 복사했습니다.' : '복사가 되지 않았습니다.');
  };
  document.querySelector('#native-share').onclick = async () => {
    if (navigator.share) { try { await navigator.share({ title: 'ALL:GOLF', text, url }); return; } catch { /* 취소 */ } }
    const ok = await copyText(`${text}\n${url}`);
    toast(ok ? '공유 내용을 복사했습니다.' : '공유를 지원하지 않는 환경입니다.');
  };
  document.querySelector('#ics-from-modal').onclick = () => saveReservationToCalendar(reservation);
}

/* 공유 조건 배너 */
function shareBanner() {
  if (!shareIncoming) return '';
  const target = courses.find(item => item.id === shareIncoming.courseId);
  const parts = [target?.name || shareIncoming.courseId, shareIncoming.dateISO ? formatCalendarDate(shareIncoming.dateISO) : '', shareIncoming.people ? `${shareIncoming.people}명` : ''].filter(Boolean);
  return `<div class="share-banner">🔗 공유받은 조건 · ${esc(parts.join(' · '))} <button data-dismiss-share>닫기</button></div>`;
}

/* 17. 이벤트 바인딩 ---------------------------------------------------------- */
function bind() {
  document.querySelectorAll('.bottom-nav [data-go], .brand[data-go]').forEach(element => { element.onclick = () => go(element.dataset.go); });
  root.querySelectorAll('[data-go]').forEach(element => { element.onclick = () => go(element.dataset.go); });
  root.querySelectorAll('[data-course]').forEach(element => {
    element.onclick = event => {
      event.stopPropagation();
      course = courses.find(item => item.id === element.dataset.course) || course;
      tee = null;
      go('detail');
    };
  });
  root.querySelectorAll('[data-reserve-course]').forEach(element => {
    element.onclick = event => {
      event.stopPropagation();
      const selected = courses.find(item => item.id === element.dataset.reserveCourse);
      if (!selected?.bookable) return;
      course = selected;
      tee = null;
      go('detail');
      requestAnimationFrame(() => document.querySelector('#tee-times')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    };
  });
  root.querySelectorAll('[data-slot-course]').forEach(element => {
    element.onclick = event => {
      event.stopPropagation();
      const selected = courses.find(item => item.id === element.dataset.slotCourse);
      if (!selected) return;
      course = selected;
      calendarDate = element.dataset.slotDate || calendarDate;
      dateAnchor = calendarDate;
      date = formatCalendarDate(calendarDate);
      const slot = timesFor(course, calendarDate).find(item => item.id === element.dataset.slotTime);
      if (!slot || slot.closed) { toast('선택한 티타임이 마감되었습니다.'); return; }
      if (Number(slot.maxPlayers || 4) < people) { toast(`${slot.maxPlayers}인까지 예약할 수 있는 티타임입니다.`); return; }
      tee = slot;
      go('booking');
    };
  });
  root.querySelectorAll('[data-tee-id]').forEach(element => {
    element.onclick = () => {
      tee = timesFor(course).find(item => item.id === element.dataset.teeId);
      if (!tee || tee.closed) return;
      go('booking');
    };
  });
  root.querySelectorAll('[data-special-course]').forEach(element => {
    element.onclick = () => {
      const selected = courses.find(item => item.id === element.dataset.specialCourse);
      if (!selected) return;
      course = selected;
      calendarDate = element.dataset.specialDate;
      dateAnchor = calendarDate;
      date = formatCalendarDate(calendarDate);
      tee = timesFor(course, calendarDate).find(item => item.id === element.dataset.specialTee) || null;
      if (!tee || tee.closed) { toast('특가 티타임이 마감되었습니다.'); return; }
      go('booking');
    };
  });
  const bookingPeople = root.querySelector('#booking-people');
  if (bookingPeople) {
    bookingPeople.onchange = () => {
      captureBookingDraft();
      people = Number(bookingPeople.value);
      render();
    };
  }
  root.querySelectorAll('[data-date]').forEach(element => {
    element.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      date = element.dataset.date;
      calendarDate = element.dataset.iso || calendarDate;
      tee = null;
      const scrollY = window.scrollY;
      render();
      requestAnimationFrame(() => window.scrollTo({ top: scrollY }));
    };
  });
  root.querySelectorAll('[data-fav-date]').forEach(element => {
    element.onclick = () => { favDate = element.dataset.favDate; render(); };
  });
  root.querySelectorAll('[data-sheet]').forEach(element => { element.onclick = openSheet; });
  root.querySelectorAll('[data-toggle-filters]').forEach(element => {
    element.onclick = () => { filtersOpen = !filtersOpen; render(); };
  });
  root.querySelectorAll('[data-session]').forEach(element => {
    element.onclick = () => { detailSession = element.dataset.session; render(); };
  });
  root.querySelectorAll('[data-sort]').forEach(element => { element.onclick = () => { sort = element.dataset.sort; render(); }; });
  ['min-price', 'max-price', 'time-part'].forEach(id => {
    const element = root.querySelector(`#${id}`);
    if (element) {
      element.onchange = () => {
        minPrice = root.querySelector('#min-price').value;
        maxPrice = root.querySelector('#max-price').value;
        timePart = root.querySelector('#time-part').value;
        visibleCount = 30;
        render();
      };
    }
  });
  root.querySelectorAll('[data-region-filter]').forEach(element => {
    element.onclick = () => { region = element.dataset.regionFilter; city = ''; visibleCount = 30; render(); };
  });
  const cityFilter = root.querySelector('#result-city');
  if (cityFilter) cityFilter.onchange = () => { city = cityFilter.value; render(); };
  const operationSelect = root.querySelector('#operation-filter');
  if (operationSelect) operationSelect.onchange = () => { operationFilter = operationSelect.value; render(); };
  const holesSelect = root.querySelector('#holes-filter');
  if (holesSelect) holesSelect.onchange = () => { holesFilter = holesSelect.value; visibleCount = 30; render(); };
  const availabilitySelect = root.querySelector('#availability-filter');
  if (availabilitySelect) availabilitySelect.onchange = () => { availabilityFilter = availabilitySelect.value; visibleCount = 30; render(); };
  root.querySelectorAll('[data-filter]').forEach(element => {
    element.onclick = () => {
      filters = filters.includes(element.dataset.filter) ? filters.filter(item => item !== element.dataset.filter) : [...filters, element.dataset.filter];
      render();
    };
  });
  root.querySelectorAll('[data-reset-search]').forEach(element => {
    element.onclick = () => {
      sort = 'recommend'; filters = []; query = ''; region = '전체'; city = '';
      operationFilter = 'all'; holesFilter = 'all'; availabilityFilter = 'all';
      minPrice = ''; maxPrice = ''; timePart = 'all'; visibleCount = 30; render();
    };
  });
  root.querySelectorAll('[data-load-more]').forEach(element => { element.onclick = () => { visibleCount += 30; render(); }; });
  root.querySelectorAll('[data-scroll]').forEach(element => {
    element.onclick = () => document.querySelector(`#${element.dataset.scroll}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  root.querySelectorAll('[data-favorite]').forEach(element => {
    element.onclick = event => { event.stopPropagation(); toggleFavorite(element.dataset.favorite); };
  });
  root.querySelectorAll('[data-mytab]').forEach(element => { element.onclick = () => { myTab = element.dataset.mytab; render(); }; });
  root.querySelectorAll('[data-cancel]').forEach(element => { element.onclick = () => cancelReservation(element.dataset.cancel); });
  root.querySelectorAll('[data-share-course]').forEach(element => { element.onclick = () => shareCourseModal(element.dataset.shareCourse); });
  root.querySelectorAll('[data-share-reservation]').forEach(element => { element.onclick = () => shareReservationModal(element.dataset.shareReservation); });
  root.querySelectorAll('[data-map]').forEach(element => {
    element.onclick = () => modal(`<h2>지도보기</h2><p>${esc(course.address || '주소 확인 필요')}</p><p class="modal-note">지도 연동은 준비 중입니다.</p><button class="primary" id="close-modal">확인</button>`);
  });
  root.querySelectorAll('[data-alert],[data-wait-open]').forEach(element => {
    element.onclick = () => openWaitModal(element.dataset.waitOpen || course.id);
  });
  root.querySelectorAll('[data-wait-pick]').forEach(element => { element.onclick = () => openWaitModal(null); });
  root.querySelectorAll('[data-wait-tee]').forEach(element => {
    element.onclick = () => openWaitModal(course.id, element.dataset.waitTee);
  });
  root.querySelectorAll('[data-wait-edit]').forEach(element => {
    element.onclick = () => {
      const entry = shared.getWaitlist().find(item => item.id === element.dataset.waitEdit);
      if (entry) openWaitModal(entry.courseId, entry.teeTimeId || null, entry.id);
    };
  });
  root.querySelectorAll('[data-wait-cancel]').forEach(element => {
    element.onclick = () => {
      if (confirm('대기 신청을 취소할까요?')) { shared.cancelWait(element.dataset.waitCancel); toast('대기를 취소했습니다.'); render(); }
    };
  });
  root.querySelectorAll('[data-notification]').forEach(element => {
    element.onclick = () => {
      const note = shared.getNotifications().find(item => item.id === element.dataset.notification);
      if (!note) return;
      shared.markNotificationRead(note.id);
      const wait = shared.getWaitlist().find(item => item.id === note.waitId);
      if (wait) people = Number(wait.people) || people;
      course = courses.find(item => item.id === note.courseId) || course;
      calendarDate = note.date;
      dateAnchor = note.date;
      date = formatCalendarDate(note.date);
      tee = timesFor(course, note.date).find(item => item.id === note.teeTimeId) || null;
      if (tee && !tee.closed && tee.remaining > 0) go('booking');
      else go('detail');
    };
  });
  root.querySelectorAll('[data-benefit]').forEach(element => {
    element.onclick = () => modal(`<h2>혜택 안내</h2><p>지금은 시연용 혜택 데이터입니다. 실제 서비스에서는 회원 등급과 사용 조건에 따라 적용됩니다.</p><button class="primary" id="close-modal">확인</button>`);
  });
  root.querySelectorAll('[data-reservation-open]').forEach(element => {
    element.onclick = () => { currentReservationId = element.dataset.reservationOpen; page = 'reservations'; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  });
  root.querySelectorAll('[data-ics]').forEach(element => {
    element.onclick = () => saveReservationToCalendar(findReservation(element.dataset.ics));
  });
  root.querySelectorAll('[data-rebook]').forEach(element => {
    element.onclick = () => {
      course = courses.find(item => item.id === element.dataset.rebook) || course;
      calendarDate = todayISO;
      dateAnchor = todayISO;
      date = formatCalendarDate(todayISO);
      tee = null;
      go('detail');
      requestAnimationFrame(() => document.querySelector('#tee-times')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    };
  });
  root.querySelectorAll('[data-dismiss-share]').forEach(element => {
    element.onclick = () => { shareIncoming = null; render(); };
  });
  root.querySelectorAll('[data-clear-recents]').forEach(element => {
    element.onclick = () => { clearRecentSearches(); toast('최근 검색을 지웠습니다.'); render(); };
  });
  root.querySelectorAll('[data-recent-search]').forEach(element => {
    element.onclick = () => {
      const entry = recentSearches()[Number(element.dataset.recentSearch)];
      if (!entry) return;
      query = entry.query || '';
      region = entry.region || '전체';
      city = entry.city || '';
      people = Number(entry.people) || people;
      if (entry.date) { calendarDate = entry.date; dateAnchor = entry.date; date = formatCalendarDate(entry.date); }
      page = 'list';
      render();
      window.scrollTo({ top: 0 });
    };
  });

  const form = root.querySelector('#search-form');
  if (form) {
    form.addEventListener('submit', event => {
      event.preventDefault();
      query = root.querySelector('#home-query').value.trim();
      operationFilter = 'all'; holesFilter = 'all'; availabilityFilter = 'all'; filters = []; sort = 'recommend'; visibleCount = 30;
      pushRecentSearch({ query, region, city, date: calendarDate, people });
      page = 'list';
      render();
      window.scrollTo({ top: 0 });
    });
  }
  root.querySelectorAll('[data-quick]').forEach(element => {
    element.onclick = () => {
      const value = element.dataset.quick;
      if (value === '2인 가능' || value === '특가') {
        filters = filters.includes(value) ? filters.filter(item => item !== value) : [...filters, value];
      }
      if (value === '오늘') calendarDate = todayISO;
      if (value === '내일') calendarDate = shiftISO(todayISO, 1);
      if (value === '주말') calendarDate = nextWeekendISO();
      dateAnchor = calendarDate;
      date = formatCalendarDate(calendarDate);
      pushRecentSearch({ query, region, city, date: calendarDate, people });
      go('list');
    };
  });

  /* 예약 폼: 연락처 자동 서식 + 형식 검증 */
  const phoneInput = root.querySelector('#phone');
  if (phoneInput) {
    phoneInput.addEventListener('input', () => {
      const caretAtEnd = phoneInput.selectionStart === phoneInput.value.length;
      phoneInput.value = formatPhone(phoneInput.value);
      if (caretAtEnd) phoneInput.setSelectionRange(phoneInput.value.length, phoneInput.value.length);
      const error = root.querySelector('#phone-error');
      if (error) error.hidden = isValidPhone(phoneInput.value) || !phoneInput.value;
    });
  }
  const pay = root.querySelector('#pay');
  if (pay) {
    const update = () => {
      const bookerOk = Boolean(root.querySelector('#booker').value.trim());
      const phoneOk = isValidPhone(root.querySelector('#phone').value);
      const ok = bookerOk && phoneOk && root.querySelector('#terms').checked && root.querySelector('#refund').checked;
      const error = root.querySelector('#phone-error');
      if (error) error.hidden = phoneOk || !root.querySelector('#phone').value;
      pay.disabled = !ok;
      pay.classList.toggle('disabled', !ok);
    };
    root.querySelectorAll('.required,#terms,#refund').forEach(element => element.addEventListener('input', update));
    root.querySelectorAll('#terms,#refund').forEach(element => element.addEventListener('change', update));
    pay.onclick = reserve;
    update();
  }
  document.querySelectorAll('#modal #close-modal').forEach(element => { element.onclick = () => modal(); });
}

/* 18. 렌더 ------------------------------------------------------------------- */
const navFor = current => {
  if (['home'].includes(current)) return 'home';
  if (['list', 'detail', 'booking', 'complete', 'reservations'].includes(current)) return 'list';
  if (['my', 'favorites', 'waitlist', 'notifications'].includes(current)) return 'my';
  if (['bench', 'benefits'].includes(current)) return 'benefits';
  if (['join', 'lesson', 'travel'].includes(current)) return 'join';
  return current;
};
function render() {
  const content = page === 'home' ? home()
    : page === 'benefits' ? benefits()
    : page === 'favorites' ? favoritesPage()
    : page === 'list' ? list()
    : page === 'detail' ? detail()
    : page === 'booking' ? booking()
    : page === 'complete' ? complete()
    : page === 'my' ? my()
    : page === 'reservations' ? reservationPage()
    : page === 'waitlist' ? waitlistPage()
    : page === 'notifications' ? notificationsPage()
    : page === 'join' ? readyPage('join')
    : page === 'lesson' ? readyPage('lesson')
    : page === 'travel' ? readyPage('travel')
    : readyPage('join');
  root.innerHTML = shareBanner() + content;
  const active = navFor(page);
  document.querySelectorAll('.bottom-nav button').forEach(button => button.classList.toggle('active', button.dataset.go === active));
  updateNotificationBadge();
  bind();
}

/* 19. 취소 ------------------------------------------------------------------ */
function cancelReservation(reference) {
  const target = findReservation(reference);
  if (!target) return;
  const refund = shared?.calculateCancellation ? shared.calculateCancellation(target) : {
    paidDeposit: Number(target.paidDeposit ?? target.online ?? target.deposit ?? 0),
    cancellationFee: 0,
    refundAmount: Number(target.paidDeposit ?? target.online ?? target.deposit ?? 0),
    canCancel: true
  };
  modal(`<h2>예약 취소 확인</h2><div class="cancel-summary">
    <p><b>${esc(target.number)}</b><br>${esc(target.courseName || target.course)}<br>${esc(target.dateISO || target.date)} · ${esc(target.time)}</p>
    ${refund.deadlineAt ? `<p>취소 가능 기한: ${new Date(refund.deadlineAt).toLocaleString('ko-KR')}</p>` : ''}
    <div><span>결제한 예약금</span><b>${won(refund.paidDeposit)}</b></div>
    <div><span>예상 취소수수료</span><b>${won(refund.cancellationFee)}</b></div>
    <div><span>예상 시연 환불금액</span><b>${won(refund.refundAmount)}</b></div>
    <small>시연용 취소·환불 정책에 따른 계산이며 실제 환불이 아닙니다.${refund.canCancel === false ? ' 취소 가능 기한이 지났습니다.' : ''}</small>
  </div><div class="modal-actions"><button class="home-button" id="close-modal">취소하지 않기</button><button class="primary" id="confirm-cancel" ${refund.canCancel === false ? 'disabled' : ''}>예약 취소하기</button></div>`);
  document.querySelector('#close-modal').onclick = () => modal();
  document.querySelector('#confirm-cancel').onclick = () => {
    const result = shared?.cancelReservation ? shared.cancelReservation(reference, '사용자 취소') : { ok: false };
    if (!result.ok) {
      alert(result.reason === 'deadline_passed' ? '취소 가능 기한이 지났습니다.' : '예약 취소에 실패했습니다.');
      return;
    }
    myTab = 'cancelled';
    currentReservationId = result.reservation?.id || currentReservationId;
    modal();
    toast('예약을 취소했습니다. 취소 티타임이 다시 열렸습니다.');
    go('reservations');
  };
}

/* 20. 부트 ------------------------------------------------------------------ */
function boot() {
  date = formatCalendarDate(calendarDate);

  /* 지역 / 인원 시트 초기화 */
  sheetRegion.innerHTML = regionOptions.map(item => `<button class="${item.code === '전체' ? 'selected' : ''}" data-region="${item.code}">${item.label}</button>`).join('');
  sheetRegion.querySelectorAll('button').forEach(button => {
    button.onclick = () => {
      sheetRegion.querySelectorAll('button').forEach(item => item.classList.remove('selected'));
      button.classList.add('selected');
      updateSheetCities(button.dataset.region);
    };
  });
  updateSheetCities('전체');
  document.querySelectorAll('#sheet-people button').forEach(button => {
    button.onclick = () => {
      document.querySelectorAll('#sheet-people button').forEach(item => item.classList.remove('selected'));
      button.classList.add('selected');
    };
  });
  document.querySelector('#calendar-date').value = todayISO;

  document.querySelector('#sheet-close').onclick = closeSheet;
  document.querySelector('#sheet').onclick = event => { if (event.target.id === 'sheet') closeSheet(); };
  document.querySelector('#sheet-search').onclick = () => {
    const selectedRegion = document.querySelector('#sheet-region .selected');
    region = selectedRegion?.dataset.region || '전체';
    city = sheetCity.value;
    const direct = document.querySelector('#calendar-date')?.value;
    if (direct) { calendarDate = direct; dateAnchor = direct; date = formatCalendarDate(direct); }
    const selectedPeople = document.querySelector('#sheet-people .selected');
    people = Number(selectedPeople?.dataset.people || 4);
    pushRecentSearch({ query, region, city, date: calendarDate, people });
    closeSheet();
    page = 'list';
    render();
    window.scrollTo({ top: 0 });
  };

  document.querySelector('#open-notifications').onclick = () => go('notifications');
  document.querySelector('#open-settings').onclick = () => toast('설정은 준비 중입니다.');

  /* 공유 링크로 들어온 조건 */
  const params = new URLSearchParams(location.search);
  let incoming = false;
  if (params.get('course')) {
    const target = courses.find(item => item.id === params.get('course'));
    if (target) { course = target; incoming = true; }
  }
  if (params.get('date')) {
    calendarDate = params.get('date');
    dateAnchor = calendarDate;
    date = formatCalendarDate(calendarDate);
    incoming = true;
  }
  if (params.get('people')) {
    people = Math.min(4, Math.max(2, Number(params.get('people')) || 4));
    incoming = true;
  }
  if (params.get('time')) {
    tee = timesFor(course, calendarDate).find(item => item.time === params.get('time') || item.id === params.get('time')) || null;
    incoming = true;
  }
  if (incoming) shareIncoming = { courseId: course?.id, dateISO: calendarDate, people };
  if (params.get('number')) currentReservationId = params.get('number');
  if (params.get('page') === 'reservations' && currentReservationId) page = 'reservations';
  else if (['detail', 'booking', 'my'].includes(params.get('page'))) {
    page = params.get('page');
    if (page === 'booking' && !tee) page = 'detail';
  }

  window.addEventListener('storage', event => {
    if (event.key === shared?.OPS_KEY || event.key === shared?.RESERVATION_KEY) render();
  });
  window.addEventListener('allgolf:datachange', render);
  window.addEventListener('allgolf:reservationschange', () => { if (page === 'my' || page === 'reservations' || page === 'waitlist') render(); });

  render();
}
boot();
