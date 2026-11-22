/* ALL:GOLF 시나리오 회귀 테스트 (앱 코드를 그대로 실행)
   실행: node tests/run-scenarios.js
   - 4인 예약 / 3인 추가금 / 특가 예약 / 취소 후 대기 알림 / 연락처 검증 / 일정 저장 / 재방문 기능을 확인한다.
   - 브라우저 없이 app.js, data/*, scripts 를 이어 붙여 실행하므로 계산·저장 로직을 실제 코드로 검증한다. */
(function () {
  'use strict';

  const results = [];
  const passed = () => results.filter(item => item.ok).length;
  const failed = () => results.filter(item => !item.ok).length;
  const ok = (name, condition, detail = '') => results.push({ name, ok: Boolean(condition), detail: String(detail) });
  const eq = (name, actual, expected) => ok(name, actual === expected, `기대 ${JSON.stringify(expected)} / 실제 ${JSON.stringify(actual)}`);
  const section = title => results.push({ name: `# ${title}`, ok: true, detail: '', heading: true });

  function resetState() {
    localStorage.clear();
    sessionStorage.clear();
    page = 'home';
    people = 4;
    region = '전체';
    city = '';
    query = '';
    filters = [];
    sort = 'recommend';
    operationFilter = 'all';
    holesFilter = 'all';
    availabilityFilter = 'all';
    minPrice = '';
    maxPrice = '';
    timePart = 'all';
    calendarDate = todayISO;
    dateAnchor = todayISO;
    date = formatCalendarDate(todayISO);
    tee = null;
    activeHold = null;
    currentReservationId = null;
    shareIncoming = null;
    lastViewedCourseId = null;
    detailSession = 'all';
    filtersOpen = false;
    bookingDraft = { booker: '', phone: '', request: '', companions: [], terms: false, refund: false };
    course = courses.find(item => item.id === 'woojeong') || demoCourses[0] || courses[0];
  }

  function fillForm(name, phone) {
    document.querySelector('#booker').value = name;
    document.querySelector('#phone').value = phone;
    document.querySelector('#request').value = '';
    document.querySelector('#terms').checked = true;
    document.querySelector('#refund').checked = true;
  }

  function prepare(target, iso, slot, count) {
    course = target;
    calendarDate = iso;
    dateAnchor = iso;
    date = formatCalendarDate(iso);
    people = count;
    tee = timesFor(target, iso).find(item => item.id === slot.id) || slot;
  }

  function payAndConfirm() {
    const confirmButton = document.querySelector('#confirm-reserve');
    confirmButton.disabled = false;                 // 이전 시나리오의 DOM 대체 객체 상태를 되돌린다
    confirmButton.onclick({ target: confirmButton });
    __flushTimers();
    return getReservations()[0];
  }

  function book(target, iso, slot, count, name, phone) {
    resetState();
    prepare(target, iso, slot, count);
    fillForm(name, phone);
    const payment = paymentFor(target, tee, count);
    reserve();
    const reservation = payAndConfirm();
    return { reservation, payment };
  }

  /* ------------------------------------------------------------------ */
  function scenarioData() {
    section('데이터 보존');
    ok('전국 골프장 목록 로드', courses.length >= 200, `${courses.length}곳`);
    ok('시연 예약 가능 골프장 존재', courses.some(item => item.bookable));
    ok('정보 전용 골프장에는 가상 티타임을 만들지 않음', rawTimesFor({ demo: false, id: 'no-demo-course', times: [] }).length === 0);
    ok('지역 목록 유지', Array.isArray(window.ALL_GOLF_REGIONS) && window.ALL_GOLF_REGIONS.length > 10, `${window.ALL_GOLF_REGIONS?.length}개`);
    ok('기존 예약 저장 키 유지', shared.RESERVATION_KEY === 'allGolfReservations', shared.RESERVATION_KEY);
    ok('기존 운영 저장 키 유지', shared.OPS_KEY === 'allGolfOperationsV1', shared.OPS_KEY);
  }

  function scenarioFourPlayers() {
    section('4인 예약');
    const target = courses.find(item => item.id === 'woojeong');
    const iso = shiftISO(todayISO, 7);
    const slot = openTimesFor(target, iso)[0];
    ok('4인 예약용 티타임 확보', Boolean(slot), slot?.time);
    const before = timesFor(target, iso).find(item => item.id === slot.id).remaining;
    const { reservation, payment } = book(target, iso, slot, 4, '김골퍼', '010-1234-5678');
    ok('예약 생성', Boolean(reservation), reservation?.number);
    eq('예약 인원 4명', reservation.people, 4);
    eq('4인 추가금 없음', reservation.playerSurcharge, 0);
    eq('그린피 합계 = 1인가 × 4', reservation.greenTotal, payment.appliedGreenFee * 4);
    eq('총액 = 그린피 + 카트 + 캐디', reservation.totalEstimated, payment.greenTotal + payment.cart + payment.caddie);
    eq('예약금 = 1인 예약금 × 4', reservation.paidDeposit, Number(target.demoDeposit) * 4);
    eq('현장 결제 = 총액 - 예약금', reservation.onsite, reservation.totalEstimated - reservation.paidDeposit);
    eq('예약 상태', reservation.status, 'confirmed');
    const after = timesFor(target, iso).find(item => item.id === slot.id);
    eq('재고 1팀 차감', after.remaining, before - 1);
    ok('예약 번호 형식', /^AG-\d{6}-\d{5}$/.test(reservation.number), reservation.number);
    ok('localStorage 예약 저장', JSON.parse(localStorage.getItem('allGolfReservations') || '[]').length === 1);
    return { target, iso, slot, reservation };
  }

  function scenarioThreePlayers() {
    section('3인 추가금');
    const target = courses.find(item => item.demo && Number(item.demoThreePlayerSurcharge) > 0);
    ok('3인 추가금이 설정된 골프장 존재', Boolean(target), target?.name);
    const iso = shiftISO(todayISO, 8);
    const slot = openTimesFor(target, iso)[0];
    const { reservation, payment } = book(target, iso, slot, 3, '박쓰리', '010-2222-3333');
    ok('3인 예약 생성', Boolean(reservation), reservation?.number);
    eq('3인 추가금 반영', reservation.playerSurcharge, Number(target.demoThreePlayerSurcharge));
    eq('1인 그린피에 추가금 포함', payment.appliedGreenFee, Number(slot.price) + Number(target.demoThreePlayerSurcharge));
    eq('팀 총액 = (그린피+추가금) × 3 + 카트 + 캐디', reservation.totalEstimated, (Number(slot.price) + Number(target.demoThreePlayerSurcharge)) * 3 + payment.cart + payment.caddie);
    eq('예약금 = 3인분', reservation.paidDeposit, Number(target.demoDeposit) * 3);
  }

  function scenarioSpecialOffer() {
    section('특가 예약');
    resetState();
    const target = courses.find(item => item.demo && openTimesFor(item, shiftISO(todayISO, 9)).length);
    const iso = shiftISO(todayISO, 9);
    const slot = openTimesFor(target, iso)[0];
    const regular = Number(slot.price);
    const special = Math.round(regular * 0.8);
    const saved = shared.saveSpecialOffer({
      courseId: target.id, roundDate: iso, teeTimeId: slot.id, time: slot.time, name: '회귀 테스트 특가',
      regularPrice: regular, specialPrice: special, teamLimit: slot.remaining,
      saleStartAt: new Date(Date.now() - 3600000).toISOString(),
      saleEndAt: new Date(Date.now() + 86400000).toISOString()
    });
    ok('특가 등록', saved.ok === true, saved.ok ? saved.offer.id : saved.message);
    const applied = timesFor(target, iso).find(item => item.id === slot.id);
    ok('특가가 티타임 가격에 적용', Boolean(applied.specialOffer), applied.specialOffer?.discountRate);
    prepare(target, iso, slot, 4);
    fillForm('이특가', '010-4444-5555');
    reserve();
    const reservation = payAndConfirm();
    ok('특가 예약 생성', Boolean(reservation), reservation?.number);
    eq('특가 ID 저장', reservation.specialOfferId, saved.offer.id);
    eq('특가 1인 가격 적용', reservation.appliedGreenFee, special);
    ok('할인 금액 계산', reservation.discountAmount > 0, reservation.discountAmount);
    eq('총액은 특가 기준', reservation.totalEstimated, special * 4 + reservation.cart + reservation.caddie);
  }

  function scenarioWaitAndCancel() {
    section('취소 후 빈자리 알림');
    resetState();
    const target = courses.find(item => item.id === 'woojeong');
    const iso = shiftISO(todayISO, 6);
    const slot = openTimesFor(target, iso).find(item => item.remaining === 1) || openTimesFor(target, iso)[0];
    prepare(target, iso, slot, 4);
    fillForm('최대기', '010-7777-8888');
    reserve();
    const reservation = payAndConfirm();
    ok('마감용 예약 생성', Boolean(reservation), reservation?.number);
    const closed = timesFor(target, iso).find(item => item.id === slot.id);
    ok('예약으로 티타임 마감', closed.closed === true || closed.remaining === 0, `remaining=${closed.remaining}`);

    calendarDate = iso;
    date = formatCalendarDate(iso);
    openWaitModal(target.id, slot.id);
    document.querySelector('#wait-date').value = iso;
    document.querySelector('#wait-name').value = '최대기';
    document.querySelector('#wait-phone').value = '010-7777-8888';
    document.querySelector('#wait-people').value = '4';
    document.querySelector('#wait-price').value = '400000';
    document.querySelector('#wait-save').onclick();
    const wait = shared.getWaitlist()[0];
    ok('대기 등록', Boolean(wait) && wait.status === 'active', wait?.status);

    cancelReservation(reservation.number);
    document.querySelector('#confirm-cancel').onclick();
    __flushTimers();
    const cancelled = getReservations().find(item => item.number === reservation.number);
    eq('예약 취소 상태', cancelled.status, 'cancelled');
    ok('취소 시 재고 복구', timesFor(target, iso).find(item => item.id === slot.id).remaining > 0);
    const note = shared.getNotifications().find(item => item.waitId === wait.id);
    ok('대기자에게 빈자리 알림 생성', Boolean(note), note?.message);
    const waitHtml = waitlistPage();
    ok('대기 화면에 빈자리 알림 표시', waitHtml.includes('빈자리 알림') && waitHtml.includes('예약으로 이어가기'));
    const noteHtml = notificationsPage();
    ok('알림함에 알림 노출', noteHtml.includes('data-notification=') && noteHtml.includes(target.name));
    ok('알림에서 예약으로 이어지는 버튼 존재', /data-notification="[^"]+"/.test(noteHtml));
  }

  function scenarioPhoneValidation() {
    section('연락처·필수값 검증');
    resetState();
    const target = courses.find(item => item.id === 'woojeong');
    const iso = shiftISO(todayISO, 11);
    const slot = openTimesFor(target, iso)[0];
    prepare(target, iso, slot, 4);
    fillForm('김골퍼', '1234');
    reserve();
    eq('형식이 틀린 연락처는 예약되지 않음', getReservations().length, 0);
    ok('연락처 오류 안내', document.querySelector('#toast').textContent.includes('휴대전화번호'), document.querySelector('#toast').textContent);
    eq('연락처 자동 서식', formatPhone('01012345678'), '010-1234-5678');
    eq('10자리 연락처 서식', formatPhone('0101234567'), '010-123-4567');
    ok('정상 연락처 통과', isValidPhone('010-1234-5678'));
    ok('잘못된 연락처 거부', !isValidPhone('02-123-4567'));
  }

  function scenarioCalendarAndShare() {
    section('일정 저장·공유');
    resetState();
    const target = courses.find(item => item.id === 'woojeong');
    const iso = shiftISO(todayISO, 5);
    const slot = openTimesFor(target, iso)[0];
    const { reservation } = book(target, iso, slot, 4, '한공유', '010-5555-6666');
    const ics = icsForReservation(reservation);
    ok('ICS 헤더 포함', ics.startsWith('BEGIN:VCALENDAR') && ics.includes('END:VCALENDAR'));
    ok('ICS 일정 시작 시각', ics.includes(`DTSTART:${iso.replace(/-/g, '')}T${slot.time.replace(':', '')}00`), ics.match(/DTSTART:[^\r\n]+/)?.[0]);
    ok('ICS 요약에 골프장 이름', ics.includes('SUMMARY:') && ics.includes(target.name));
    ok('ICS 예약번호 포함', ics.includes(reservation.number));
    const link = shareLink({ courseId: target.id, dateISO: iso, people: 4, time: slot.time });
    ok('공유 링크에 골프장·날짜·인원 포함', link.includes(`course=${target.id}`) && link.includes(`date=${iso}`) && link.includes('people=4'), link);
  }

  function scenarioRevisit() {
    section('재방문 기능');
    resetState();
    const target = courses.find(item => item.id === 'emerson') || demoCourses[0];
    toggleFavorite(target.id);
    ok('찜 저장', favorites().includes(target.id));
    ok('찜 목록 화면에 노출', favoritesPage().includes(target.name));
    favDate = shiftISO(todayISO, 3);
    ok('찜 화면에서 선택 날짜 티타임 노출', favoriteCard(target).includes('data-slot-time='), favoriteCard(target).slice(0, 120));
    pushRecentSearch({ query: '천안', region: '충남', city: '', date: todayISO, people: 4 });
    ok('최근 검색 저장', recentSearches()[0]?.query === '천안', JSON.stringify(recentSearches()[0]));
    ok('홈에 최근 검색 노출', home().includes('최근 검색'));
    pushRecentView(target.id);
    ok('최근 본 골프장 저장', recentViews().includes(target.id), JSON.stringify(recentViews()));
    const reopened = my();
    ok('내 예약 화면 탭 구성', reopened.includes('다가오는') && reopened.includes('지난') && reopened.includes('취소'));
  }

  function scenarioReservationDetail() {
    section('예약 상세 재조회');
    resetState();
    const target = courses.find(item => item.demo && Number(item.demoThreePlayerSurcharge) > 0);
    const iso = shiftISO(todayISO, 4);
    const slot = openTimesFor(target, iso)[0];
    const { reservation } = book(target, iso, slot, 3, '정상세', '010-9999-0000');
    currentReservationId = reservation.number;
    page = 'reservations';
    render();
    const html = root.innerHTML;
    ok('예약번호 표시', html.includes(reservation.number));
    ok('요금 내역 표시', html.includes('요금 내역') && html.includes('그린피'));
    ok('3인 추가금 표시', html.includes('3인 플레이 추가금'));
    ok('취소 기한 표시', html.includes('취소 가능 기한'));
    ok('환불 예상 표시', html.includes('지금 취소하면'));
    ok('일정 저장·재예약 버튼', html.includes('data-ics=') && html.includes('data-rebook='));

    /* 지난 예약 구분 */
    const past = { ...reservation, id: 'past-1', number: 'AG-PAST', dateISO: shiftISO(todayISO, -10), date: formatCalendarDate(shiftISO(todayISO, -10)), status: 'confirmed', time: '07:30' };
    setReservations([past, reservation]);
    myTab = 'past';
    const pastHtml = my();
    ok('날짜 기준 지난 예약 분류', pastHtml.includes('AG-PAST'), pastHtml.slice(0, 60));
    myTab = 'upcoming';
    ok('다가오는 예약 분류', my().includes(reservation.number));
  }

  function scenarioReadyScreens() {
    section('미완성 메뉴 정리');
    ok('조인 준비 중 화면', readyPage('join').includes('준비 중'));
    ok('레슨 준비 중 화면', readyPage('lesson').includes('준비 중'));
    ok('여행 준비 중 화면', readyPage('travel').includes('준비 중'));
    resetState();
    page = 'home';
    render();
    ok('홈에서 조인·레슨·여행 준비 중 표시', (home().match(/준비 중/g) || []).length >= 3);
    ok('혜택 쿠폰은 샘플로 구분', benefits().includes('샘플'));
  }


  /* ---------------------------------------------------------------- */
  /* 5단계: 골프장 제휴 신청·승인 */
  function scenarioPartnerApplication() {
    section('5단계 · 제휴 신청 접수');
    resetState();
    const api = window.ALL_GOLF_PARTNER_STORE;
    ok('제휴 신청 저장소 로드', Boolean(api));
    if (!api) return;
    ok('기본 제휴 골프장 68곳 유지', api.defaultPartnerIds().length === 68, api.defaultPartnerIds().length);
    ok('비제휴 골프장 176곳 신청 대상', api.availableCourses().length === 176, api.availableCourses().length);
    const target = api.availableCourses()[0];
    ok('비제휴 골프장은 제휴 아님', Boolean(target) && !api.isPartnerCourse(target.id), target?.name);
    ok('비제휴 골프장은 시연 예약 불가', courses.find(item => item.id === target.id)?.bookable === false);

    const invalid = api.submit({ courseMode: 'existing', courseId: target.id, managerName: '김', managerPhone: '1234', managerEmail: 'not-an-email', agree: false });
    ok('담당자 형식·동의 검증', invalid.ok === false && Boolean(invalid.errors.managerPhone) && Boolean(invalid.errors.managerEmail) && Boolean(invalid.errors.agree), invalid.message);
    const missing = api.submit({ courseMode: 'existing', courseId: '', managerName: '김담당', managerPhone: '010-1111-2222', managerEmail: 'a@b.co', agree: true });
    ok('골프장 미선택 검증', missing.ok === false && Boolean(missing.errors.courseId), missing.message);

    const first = api.submit({ courseMode: 'existing', courseId: target.id, managerName: '김담당', managerPhone: '010-1234-5678', managerEmail: 'partner@example.com', agree: true, weekdayGreenFee: '160000', cartFee: '110000', memo: '주말 2인 플레이 가능' });
    ok('기존 골프장 제휴 신청 접수', first.ok === true, first.message);
    ok('접수번호 형식', /^PA-\d{6}-\d{4}$/.test(first.application?.id || ''), first.application?.id);
    eq('신청 상태 검토 대기', first.application?.status, 'pending');
    eq('담당자 휴대전화 보존', first.application?.manager?.phone, '010-1234-5678');

    const duplicate = api.submit({ courseMode: 'existing', courseId: target.id, managerName: '김담당', managerPhone: '010-1234-5678', managerEmail: 'partner@example.com', agree: true });
    ok('같은 골프장 중복 신청 차단', duplicate.ok === false && /이미 검토 중인 신청/.test(duplicate.message), duplicate.message);
    eq('접수번호로 상태 조회', api.statusOf(first.application.id)?.status, 'pending');
    eq('검토 대기 건수 집계', api.stats().pending, 1);

    const created = api.submit({ courseMode: 'new', courseName: '테스트 힐스 CC', region: '경기', city: '용인', holes: '18', managerName: '박신청', managerPhone: '010-2222-3333', managerEmail: 'new@example.com', agree: true, weekdayGreenFee: '175000' });
    ok('신규 골프장 신청 접수', created.ok === true, created.message);
    ok('신규 골프장 내부 ID 생성', /^ap-/.test(created.application?.newCourseId || ''), created.application?.newCourseId);
    const duplicateName = api.submit({ courseMode: 'new', courseName: '테스트 힐스 CC', region: '경기', city: '용인', managerName: '박신청', managerPhone: '010-2222-3333', managerEmail: 'new@example.com', agree: true });
    ok('같은 이름 신규 신청 차단', duplicateName.ok === false && /이미 검토 중인 신청/.test(duplicateName.message), duplicateName.message);
    const registered = api.availableCourses()[0];
    const duplicateMaster = api.submit({ courseMode: 'new', courseName: registered.name, region: registered.region, city: registered.city, managerName: '박신청', managerPhone: '010-2222-3333', managerEmail: 'new@example.com', agree: true });
    ok('이미 등록된 골프장명은 신규 신청 차단', duplicateMaster.ok === false && /이미 등록된 골프장/.test(duplicateMaster.message), duplicateMaster.message);
    ok('승인 전 신규 골프장은 사용자 앱에 없음', !courses.some(item => item.name === '테스트 힐스 CC'));
    eq('홀 수 형식 오류 안내', api.submit({ courseMode: 'new', courseName: '홀수 테스트 CC', region: '경기', city: '이천', holes: '5', managerName: '박신청', managerPhone: '010-2222-3333', managerEmail: 'new@example.com', agree: true }).errors.holes ? true : false, true);
  }

  function scenarioPartnerApproval() {
    section('5단계 · 승인·반려 반영');
    resetState();
    const api = window.ALL_GOLF_PARTNER_STORE;
    if (!api) return ok('제휴 신청 저장소 로드', false);
    const existing = api.availableCourses()[0];
    const request = api.submit({ courseMode: 'existing', courseId: existing.id, managerName: '김담당', managerPhone: '010-1234-5678', managerEmail: 'partner@example.com', agree: true, weekdayGreenFee: '160000' });
    const newRequest = api.submit({ courseMode: 'new', courseName: '승인 힐스 CC', region: '경기', city: '여주', holes: '18', managerName: '박신청', managerPhone: '010-2222-3333', managerEmail: 'new@example.com', agree: true, weekdayGreenFee: '175000' });
    const rejected = api.submit({ courseMode: 'new', courseName: '반려 CC', region: '강원', city: '춘천', managerName: '이반려', managerPhone: '010-4444-5555', managerEmail: 're@example.com', agree: true });

    ok('반려 사유 없으면 거부', api.reject(rejected.application.id, {}).ok === false);
    const rejectedResult = api.reject(rejected.application.id, { reason: '사업자 정보 확인 불가' });
    ok('반려 처리', rejectedResult.ok === true && rejectedResult.application.status === 'rejected');
    eq('반려 사유 저장', api.statusOf(rejected.application.id)?.decision?.reason, '사업자 정보 확인 불가');
    ok('반려된 골프장은 제휴 아님', !api.isPartnerCourse(rejected.application.newCourseId));
    ok('반려 후 재처리 차단', api.approve(rejected.application.id, {}).ok === false);

    const approved = api.approve(request.application.id, { memo: '서류 확인 완료' });
    ok('기존 골프장 승인', approved.ok === true, approved.message);
    ok('승인 후 제휴 골프장 전환', api.isPartnerCourse(existing.id));
    eq('관리자 제휴 현황도 제휴 완료', JSON.parse(localStorage.getItem('allGolfPartnershipStatusV1') || '{}')[existing.id]?.status, 'complete');
    refreshPartnerCourses();
    const reflected = courses.find(item => item.id === existing.id);
    ok('사용자 앱 예약 가능 전환', reflected?.bookable === true && reflected?.partnered === true);
    ok('전환 후 시연 티타임 생성', openTimesFor(reflected, shiftISO(todayISO, 3)).length > 0);
    ok('제휴 예약 필터에 포함', courses.filter(item => item.bookable).some(item => item.id === existing.id));

    ok('신규 골프장 승인', api.approve(newRequest.application.id, {}).ok === true);
    refreshPartnerCourses();
    const created = courses.find(item => item.id === newRequest.application.newCourseId);
    ok('신규 골프장이 사용자 앱에 등록', Boolean(created) && created.name === '승인 힐스 CC');
    ok('신규 골프장 예약 가능', created?.bookable === true);
    eq('신청한 평일 그린피 반영', created?.demoGreenFee, 175000);
    ok('신규 골프장 티타임 생성', openTimesFor(created, shiftISO(todayISO, 4)).length > 0);

    const iso = shiftISO(todayISO, 4);
    const slot = openTimesFor(created, iso)[0];
    prepare(created, iso, slot, 4);
    fillForm('신규예약', '010-3333-4444');
    reserve();
    const reservation = payAndConfirm();
    ok('승인된 신규 골프장 예약 완료', Boolean(reservation), reservation?.number);
    eq('예약에 승인 골프장 ID 저장', reservation?.courseId, created?.id);
    eq('승인 건수 집계', api.stats().approved, 2);
    const partnerIds = window.ALL_GOLF_COURSES.filter(item => api.isPartnerCourse(item.id)).map(item => item.id);
    ok('골프장 관리자 화면 운영 대상 포함', partnerIds.includes(existing.id));
    ok('승인 신규 골프장도 운영 대상 포함', api.isPartnerCourse(created.id));
  }

  function scenarioPartnerBackup() {
    section('5단계 · 시연 백업 연동');
    resetState();
    const api = window.ALL_GOLF_PARTNER_STORE, transfer = window.ALL_GOLF_DEMO_TRANSFER;
    ok('시연 백업 도구 로드', Boolean(transfer));
    if (!api || !transfer) return;
    const request = api.submit({ courseMode: 'new', courseName: '백업 힐스 CC', region: '경기', city: '이천', managerName: '김담당', managerPhone: '010-1234-5678', managerEmail: 'partner@example.com', agree: true, memo: '자유 입력 메모', weekdayGreenFee: '160000' });
    api.approve(request.application.id, { memo: '내부 승인 메모' });
    const backup = transfer.createBackup();
    const saved = (backup.data.allGolfPartnerApplicationsV1 || [])[0];
    ok('백업에 제휴 신청 키 포함', Array.isArray(backup.data.allGolfPartnerApplicationsV1) && backup.data.allGolfPartnerApplicationsV1.length === 1);
    ok('백업에서 담당자 연락처 제외', saved && saved.manager.phone === '' && saved.manager.email === '');
    ok('백업에서 자유 입력 메모 제외', saved && saved.conditions.memo === '');
    eq('승인 상태 보존', saved?.status, 'approved');
    const parsed = transfer.parse(JSON.stringify(backup));
    eq('복원 파싱 신청 건수', parsed.allGolfPartnerApplicationsV1.length, 1);
    localStorage.setItem('allGolfPartnerApplicationsV1', JSON.stringify(parsed.allGolfPartnerApplicationsV1));
    ok('복원된 승인 신청 반영', api.isPartnerCourse(parsed.allGolfPartnerApplicationsV1[0].newCourseId));
    const summary = transfer.createBackup();
    ok('백업 요약 문구 없음(데이터만)', typeof summary.data === 'object');
  }

  function runAll() {
    const scenarios = [
      scenarioData, scenarioFourPlayers, scenarioThreePlayers, scenarioSpecialOffer,
      scenarioWaitAndCancel, scenarioPhoneValidation, scenarioCalendarAndShare,
      scenarioRevisit, scenarioReservationDetail, scenarioReadyScreens,
      scenarioPartnerApplication, scenarioPartnerApproval, scenarioPartnerBackup
    ];
    scenarios.forEach(scenario => {
      try {
        scenario();
      } catch (error) {
        results.push({ name: `${scenario.name} 실행 오류`, ok: false, detail: String(error && error.message || error) + ' | ' + String(error && error.stack || '').slice(0, 300) });
      }
    });
    if (__timerErrors.length) results.push({ name: '타이머 콜백 오류', ok: false, detail: __timerErrors.join(' | ') });
    const checks = results.filter(item => !item.heading);
    return { results, passed: checks.filter(item => item.ok).length, failed: checks.filter(item => !item.ok).length, total: checks.length };
  }

  globalThis.__runScenarios = runAll;
})();
