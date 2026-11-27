const app=document.querySelector('#admin-app'),modal=document.querySelector('#modal');const AUTH='allGolfAdminAuth',RKEY='allGolfReservations',TKEY='allGolfPartnerTeeTimes',PKEY='allGolfPartners',MKEY='allGolfMembers',QKEY='allGolfInquiries';const masterCourses=window.ALL_GOLF_COURSES||[],demoCourses=window.ALL_GOLF_DEMO_COURSES||{};
/* 6단계: 서버가 연결되어 있으면 서버 DB·서버 인증을 쓰고, 없으면 기존 정적 시연 모드로 동작한다. */
const apiClient=window.ALL_GOLF_API||null,partnerSync=window.ALL_GOLF_PARTNER_SYNC||null;
const isServerMode=()=>Boolean(apiClient&&apiClient.state.mode==='server');
const adminToken=()=>apiClient?apiClient.getToken():'';
const modeChip=()=>`<span class="mode-chip ${isServerMode()?'server':'static'}">${isServerMode()?'서버 연동':'정적 시연'}</span>`;
const modeBanner=()=>`<div class="server-banner ${isServerMode()?'':'static'}"><span>${isServerMode()?'서버 DB에 연결되어 있습니다. 제휴 신청 승인·반려가 서버 인증으로 처리되고 모든 화면에 공유됩니다.':'정적 시연 모드입니다. 데이터는 이 브라우저에만 저장되며 서버로 전송되지 않습니다.'}</span><span>${apiClient?apiClient.modeLabel():'정적 시연'}</span></div>`;
let serverApplications=null,serverStats=null;
const loginState=()=>localStorage.getItem(AUTH);
const isPartnered=id=>window.ALL_GOLF_PARTNER_STORE?window.ALL_GOLF_PARTNER_STORE.isPartnerCourse(id):Boolean(demoCourses[id]);let page='dash',period='today',courseQuery='',courseRegion='전체',courseType='all',courseScope='all',applicationFilter='all';const get=k=>JSON.parse(localStorage.getItem(k)||'[]'),set=(k,v)=>localStorage.setItem(k,JSON.stringify(v)),money=n=>Number(n||0).toLocaleString('ko-KR')+'원',esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function seed(){if(!get(PKEY).length)set(PKEY,[{id:'p1',name:'레이크힐스 용인 CC',manager:'김영업',phone:'010-3000-1000',region:'경기',status:'정상 운영',fee:10,cycle:'매월 15일',created:'2026-08-01'},{id:'p2',name:'우정힐스 CC',manager:'박지훈',phone:'010-3000-1001',region:'충청',status:'정상 운영',fee:12,cycle:'매월 15일',created:'2026-08-02'},{id:'p3',name:'제주 더 시에나 CC',manager:'이민지',phone:'010-3000-1002',region:'제주',status:'심사 중',fee:10,cycle:'매월 말일',created:'2026-08-10'}]);if(!get(MKEY).length)set(MKEY,[{id:'U-1001',name:'김골퍼',phone:'010-1234-5678',email:'golf@example.com',joined:'2026-08-01',status:'정상'},{id:'U-1002',name:'박라운드',phone:'010-2222-3333',email:'round@example.com',joined:'2026-08-03',status:'정상'}]);if(!get(QKEY).length)set(QKEY,[{id:'Q-1',type:'예약',writer:'김골퍼',title:'예약 확인 문의',status:'접수',content:'예약번호 확인 부탁드립니다.',answer:''},{id:'Q-2',type:'제휴 문의',writer:'새로운 CC',title:'제휴 등록 문의',status:'확인 중',content:'제휴 절차가 궁금합니다.',answer:''}])}
function shell(title,body){const pendingApplications=window.ALL_GOLF_PARTNER_STORE?.pendingCount()||0;return `<div class="shell"><aside class="side"><div class="brand"><b>●</b> ALL:GOLF</div><small>본사 운영 관리자 · 시연용</small>${[['dash','전국 운영 대시보드'],['courses','전국 골프장'],['partners','제휴 현황'],['applications','제휴 신청 관리'],['accounts','제휴 계정 관리'],['operations','골프장 운영 현황'],['analytics','운영 통계·제휴 성과'],['audit','승인 처리 이력'],['tees','전체 티타임'],['reservations','전체 예약'],['waitlist','예약 대기'],['refunds','취소·환불'],['members','회원 관리'],['settlements','정산·수수료 관리'],['banners','배너·혜택 관리'],['inquiries','고객 문의'],['settings','운영 설정'],['transfer','시연 데이터 백업·복원']].map(x=>`<button class="nav ${page===x[0]?'active':''}" data-page="${x[0]}">${x[1]}${x[0]==='applications'&&pendingApplications?` <em class="nav-count">${pendingApplications}</em>`:''}</button>`).join('')}<a class="nav demo-link" href="../demo/">시연 허브(10단계)</a><button class="nav logout" id="logout">로그아웃</button></aside><main class="main"><div class="top"><div><h1>${title}</h1><p>ALL:GOLF 본사 통합 운영 콘솔</p></div>${modeChip()}</div>${modeBanner()}${body}</main></div>`}
function waitlist(){const items=window.ALL_GOLF_STORE?.getWaitlist()||[],notes=window.ALL_GOLF_STORE?.getNotifications()||[];return shell('예약 대기',`<section class="panel"><div class="head"><h2>시연 대기 ${items.length}건 · 내부 알림 ${notes.length}건</h2></div><p class="notice">같은 브라우저의 시연 데이터만 표시합니다. 실제 고객 알림 발송이나 자동 예약은 없습니다.</p><div class="table-wrap"><table class="table"><thead><tr><th>골프장</th><th>희망 날짜</th><th>시간대</th><th>인원</th><th>최대 1인 가격</th><th>상태</th></tr></thead><tbody>${items.map(x=>`<tr><td>${esc(masterCourses.find(c=>c.id===x.courseId)?.name||x.courseId)}</td><td>${esc(x.date)}</td><td>${esc(x.fromTime)}~${esc(x.toTime)}</td><td>${Number(x.people)||0}명</td><td>${money(x.maxPrice)}</td><td>${({active:'대기 중',cancelled:'취소',completed:'예약 완료로 정리',expired:'만료'})[x.status]||x.status}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">대기 신청이 없습니다.</td></tr>'}</tbody></table></div></section>`)}

function courseDirectory(){const normalized=courseQuery.toLocaleLowerCase('ko').replace(/\s/g,'');const rows=masterCourses.filter(course=>{const text=`${course.name}${course.region}${course.city}${course.address||''}`.toLocaleLowerCase('ko').replace(/\s/g,'');return (!normalized||text.includes(normalized))&&(courseRegion==='전체'||course.region===courseRegion)&&(courseType==='all'||course.operationType===courseType)&&(courseScope==='all'||(courseScope==='bookable')===isPartnered(course.id))});const regions=['전체',...new Set(masterCourses.map(course=>course.region))];return shell('전국 골프장',`<section class="panel"><div class="head"><div><h2>골프장 마스터 ${rows.length}곳</h2><p class="admin-caption">공식 공개자료와 기존 검증 데이터를 병합한 조회용 목록입니다. 가격·티타임은 포함하지 않습니다.</p></div><button class="primary" id="download-courses">CSV 다운로드</button></div><div class="course-tools"><input id="course-query" value="${esc(courseQuery)}" placeholder="골프장명·지역·주소 검색"><select id="course-region">${regions.map(value=>`<option ${courseRegion===value?'selected':''}>${value}</option>`).join('')}</select><select id="course-type"><option value="all">전체 운영형태</option><option value="public" ${courseType==='public'?'selected':''}>대중제</option><option value="membership" ${courseType==='membership'?'selected':''}>회원제</option><option value="mixed" ${courseType==='mixed'?'selected':''}>혼합형</option><option value="unknown" ${courseType==='unknown'?'selected':''}>미확인</option></select><select id="course-scope"><option value="all">전체</option><option value="bookable" ${courseScope==='bookable'?'selected':''}>제휴 예약 가능</option><option value="info" ${courseScope==='info'?'selected':''}>정보 제공</option></select></div><div class="table-wrap"><table class="table"><thead><tr><th>골프장</th><th>지역</th><th>주소</th><th>운영형태</th><th>홀</th><th>예약 상태</th><th>출처 기준일</th></tr></thead><tbody>${rows.slice(0,200).map(course=>`<tr><td><b>${course.name}</b><br><small>${course.id}</small></td><td>${course.region} · ${course.city}</td><td>${course.address||'미확인'}</td><td>${course.operationType==='public'?'대중제':course.operationType==='membership'?'회원제':course.operationType==='mixed'?'혼합형':'미확인'}</td><td>${course.holes||'미확인'}</td><td><span class="badge ${isPartnered(course.id)?'':'warn'}">${isPartnered(course.id)?'제휴 예약':'정보 제공'}</span></td><td>${course.sourceAsOf||course.lastVerified||'미확인'}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">검색 결과가 없습니다.</td></tr>'}</tbody></table></div>${rows.length>200?'<div class="notice">화면에는 처음 200곳만 표시됩니다. 전체 결과는 CSV로 내려받을 수 있습니다.</div>':''}</section>`)}
function login(){
  if(isServerMode()){
    return `<div class="login"><section class="login-box"><div class="brand"><b>●</b> ALL:GOLF</div><span class="mode-chip server">서버 연동</span><p class="notice">서버 인증이 필요한 화면입니다. 승인·반려는 서버의 관리자 세션으로만 처리됩니다.</p><h1>본사 관리자 로그인</h1><p>제휴 골프장, 예약, 정산을 통합 관리합니다.</p><label class="field">이메일<input id="email" type="email" placeholder="admin@allgolf.demo" autocomplete="username"></label><label class="field">비밀번호<input id="password" type="password" placeholder="비밀번호" autocomplete="current-password"></label><button class="primary" id="login">로그인</button><div class="form-error" id="login-error" role="alert"></div><div class="hint">비밀번호는 서버의 ADMIN_PASSWORD 환경변수로 설정합니다. 로컬 시연용 기본값은 서버 실행 로그에 표시됩니다.</div></section></div>`;
  }
  return `<div class="login"><section class="login-box"><div class="brand"><b>●</b> ALL:GOLF</div><span class="mode-chip">정적 시연</span><p class="notice">시연용 화면입니다. 실제 운영 시스템이 아니며 입력한 값은 이 브라우저 밖으로 전송되지 않습니다.</p><h1>본사 관리자 로그인</h1><p>제휴 골프장, 예약, 정산을 통합 관리합니다.</p><label class="field">이메일<input id="email" type="email" placeholder="이메일" autocomplete="off"></label><label class="field">비밀번호<input id="password" type="password" placeholder="비밀번호" autocomplete="off"></label><button class="primary" id="login">로그인</button><button class="secondary" id="demo-enter">시연 입장</button><div class="hint">정적 시연 모드에서는 어떤 값이든 입력하면 시연 콘솔로 들어갑니다. 서버를 실행하면 실제 서버 인증으로 전환됩니다.</div></section></div>`;
}
function dash(){return window.ALL_GOLF_NATIONAL_DASHBOARD.dashboard(shell,masterCourses)}
function partners(){return window.ALL_GOLF_NATIONAL_DASHBOARD.partnerships(shell,masterCourses)}
function tees(){let t=get(TKEY);return shell('전체 티타임 관리',`<section class="panel"><div class="head"><h2>전체 티타임</h2><div class="tools"><button class="secondary">골프장 필터</button><button class="secondary">판매 상태</button></div></div><div class="table-wrap"><table class="table"><thead><tr><th>골프장</th><th>지역</th><th>날짜</th><th>티오프</th><th>정가</th><th>판매가</th><th>남은 팀</th><th>인원</th><th>상태</th><th>관리</th></tr></thead><tbody>${t.map(x=>`<tr><td>레이크힐스 용인 CC</td><td>경기</td><td>${x.date}</td><td>${x.time}</td><td>${money(x.regular)}</td><td>${money(x.price)}</td><td>${x.remaining}</td><td>${x.players}인</td><td><span class="badge ${x.closed?'warn':''}">${x.closed?'마감':'판매중'}</span></td><td><button class="secondary" data-tee="${x.id}">가격 수정</button> <button class="danger" data-stop="${x.id}">${x.closed?'판매 재개':'강제 마감'}</button></td></tr>`).join('')}</tbody></table></div></section>`)}
function reservationTable(reservations){
  if(!reservations.length)return '<div class="empty">예약 데이터가 없습니다.</div>';
  const rows=reservations.map(item=>`<tr><td>${item.number}</td><td>${item.courseName||item.course||'-'}</td><td>${item.booker||item.name||'-'}</td><td>${item.phone||'-'}</td><td>${item.date}</td><td>${item.time}</td><td>${item.people}인</td><td>${money(item.paidDeposit??item.deposit)}</td><td>${money(item.onsite)}</td><td><span class="badge ${item.status==='cancelled'?'bad':''}">${item.status==='cancelled'?'취소 완료':'예약 확정'}</span></td><td><button class="secondary" data-reservation="${item.id}">상세</button></td></tr>`).join('');
  return `<div class="table-wrap"><table class="table"><thead><tr><th>예약번호</th><th>골프장</th><th>예약자</th><th>연락처</th><th>날짜</th><th>시간</th><th>인원</th><th>예약금</th><th>현장결제</th><th>상태</th><th>상세</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function reservations(){
  if(isServerMode()){
    return shell('전체 예약 관리',`<section class="panel"><div class="head"><div><h2>전체 예약</h2><p class="admin-caption">서버 예약입니다. 확정·취소·환불 계산과 재고 복구는 서버가 처리하며, 모든 골프장 예약을 조회할 수 있습니다.</p></div><div class="tools"><input class="date-picker" id="reservation-date" type="date" value="${reservationDate}"><select id="reservation-status"><option value="all">전체 상태</option>${[['confirmed','예약 확정'],['cancelled','취소'],['completed','이용 완료'],['no_show','노쇼']].map(([value,label])=>`<option value="${value}" ${reservationFilter===value?'selected':''}>${label}</option>`).join('')}</select><button class="secondary" id="refresh-reservations">새로고침</button></div></div><div id="reservations-root"><div class="notice">서버에서 불러오는 중…</div></div></section>`);
  }
  return shell('전체 예약 관리',`<section class="panel"><div class="head"><h2>전체 예약</h2><div class="tools"><button class="secondary">예약 상태</button><button class="secondary">결제 상태</button></div></div>${reservationTable(get(RKEY))}</section>`)
}
let adminReservations=[],adminReservationStats=null,reservationFilter='all',reservationDate='',reservationsLoading=false;
async function loadAdminReservations(){
  const root=document.querySelector('#reservations-root');
  if(!root||!isServerMode()||reservationsLoading)return;
  reservationsLoading=true;
  const params=new URLSearchParams();
  if(reservationFilter&&reservationFilter!=='all')params.set('status',reservationFilter);
  if(reservationDate)params.set('date',reservationDate);
  const response=await apiClient.request(`/api/admin/reservations${params.toString()?'?'+params.toString():''}`,{token:adminToken(),timeoutMs:10000});
  reservationsLoading=false;
  if(!response.ok){root.innerHTML=`<div class="form-error">${esc((response.error&&response.error.message)||'예약을 불러오지 못했습니다.')}</div>`;handleAdminError(response);return}
  adminReservations=response.data.reservations||[];
  adminReservationStats=response.data.stats||{};
  root.innerHTML=adminReservationsBody(response.data);
  bindAdminReservationActions();
}
function adminReservationStatusLabel(item){return ({confirmed:'예약 확정',cancelled:'취소',completed:'이용 완료',no_show:'노쇼'})[item.status]||item.status}
function adminReservationsBody(data){
  const stats=data.stats||{},items=data.reservations||[];
  return `<section class="national-kpis application-kpis">${[['전체 예약',stats.total||0],['확정',stats.confirmed||0],['취소',stats.cancelled||0],['확정 인원',stats.people||0],['진행 중 임시확보',data.activeHolds||0]].map(([label,value])=>`<article class="stat"><small>${label}</small><strong>${value}</strong></article>`).join('')}</section><p class="notice">취소 시 환불률은 골프장 요금 설정의 취소·환불 정책으로 계산되며, 취소한 티타임의 잔여 팀은 즉시 복구됩니다. 실제 결제·환불은 아닙니다.</p><div class="table-wrap"><table class="table"><thead><tr><th>예약번호</th><th>골프장</th><th>라운드</th><th>예약자</th><th>연락처</th><th>인원</th><th>예약금</th><th>환불</th><th>상태</th><th>관리</th></tr></thead><tbody>${items.map(item=>`<tr><td><b>${esc(item.number)}</b><small class="demo-cell">${esc(String(item.createdAt||'').slice(0,16).replace('T',' '))}</small></td><td>${esc(item.courseName||item.courseId||'-')}</td><td>${esc(item.date||item.dateISO||'-')} ${esc(item.time||'')}</td><td>${esc(item.booker||'-')}</td><td>${esc(item.phone||'-')}</td><td>${Number(item.people)||0}명</td><td>${money(item.paidDeposit)}</td><td>${item.status==='cancelled'?money(item.refundAmount||0):'-'}</td><td><span class="badge ${item.status==='cancelled'?'bad':item.status==='no_show'?'warn':''}">${esc(adminReservationStatusLabel(item))}</span></td><td><button class="secondary" data-admin-reservation="${esc(item.id)}">상세</button>${item.status==='confirmed'?` <button class="danger" data-admin-reservation-cancel="${esc(item.id)}">취소</button>`:''}</td></tr>`).join('')||'<tr><td colspan="10" class="empty">조건에 맞는 예약이 없습니다.</td></tr>'}</tbody></table></div>`;
}
function bindAdminReservationActions(){
  document.querySelectorAll('[data-admin-reservation]').forEach(button=>button.onclick=()=>adminReservationModal(button.dataset.adminReservation));
  document.querySelectorAll('[data-admin-reservation-cancel]').forEach(button=>button.onclick=()=>adminChangeReservation(button.dataset.adminReservationCancel,'cancelled'));
  document.querySelector('#refresh-reservations')?.addEventListener('click',loadAdminReservations);
  document.querySelector('#reservation-status')?.addEventListener('change',event=>{reservationFilter=event.target.value;loadAdminReservations()});
  document.querySelector('#reservation-date')?.addEventListener('change',event=>{reservationDate=event.target.value;loadAdminReservations()});
}
async function adminReservationModal(id){
  modal.innerHTML='<div class="modal-bg"><section class="modal application-modal"><h2>예약 상세</h2><p class="notice">불러오는 중…</p></section></div>';
  const response=await apiClient.request(`/api/admin/reservations/${encodeURIComponent(id)}`,{token:adminToken(),timeoutMs:8000});
  if(!response.ok){close();handleAdminError(response);if(response.status!==401&&response.status!==403)alert((response.error&&response.error.message)||'예약을 불러오지 못했습니다.');return}
  const r=response.data.reservation||{},quote=r.quote||{};
  modal.innerHTML=`<div class="modal-bg"><section class="modal application-modal"><h2>예약 상세</h2><p><b>${esc(r.number||'')}</b> · ${esc(r.courseName||'')} · ${esc(adminReservationStatusLabel(r))}</p><dl class="application-detail"><div><dt>예약자</dt><dd>${esc(r.booker||'-')} · ${esc(r.phone||'-')}</dd></div><div><dt>라운드</dt><dd>${esc(r.date||r.dateISO||'')} ${esc(r.time||'')} · ${Number(r.people)||0}명</dd></div><div><dt>동반자</dt><dd>${r.companions&&r.companions.length?esc(r.companions.join(' · ')):'입력 없음'}</dd></div>${r.specialOfferName?`<div><dt>적용 특가</dt><dd>${esc(r.specialOfferName)}</dd></div>`:''}<div><dt>총 예상 이용금액</dt><dd>${money(r.totalEstimated)}</dd></div><div><dt>예약금</dt><dd>${money(r.paidDeposit)}</dd></div><div><dt>현장 결제 예정</dt><dd>${money(r.onsite)}</dd></div>${r.status==='cancelled'?`<div><dt>취소 일시</dt><dd>${esc(String(r.cancelledAt||'').slice(0,16).replace('T',' '))}</dd></div><div><dt>취소 사유</dt><dd>${esc(r.cancelReason||'-')}</dd></div><div><dt>취소수수료</dt><dd>${money(r.cancellationFee||0)}</dd></div><div><dt>시연 환불 금액</dt><dd>${money(r.refundAmount||0)}</dd></div>`:`<div><dt>지금 취소 시</dt><dd>환불률 ${quote.refundRate==null?'-':quote.refundRate+'%'} · 환불 ${money(quote.refundAmount||0)}</dd></div>`}</dl><p>요청사항 ${esc(r.request||'없음')}</p>${r.status==='confirmed'?`<div class="decision-box"><h3>상태 변경</h3><label class="field">변경 사유 (취소 시 필수)<textarea id="admin-reservation-reason" rows="2" placeholder="예: 고객 요청"></textarea></label><div class="actions"><button class="secondary" data-admin-status="completed">이용 완료</button><button class="secondary" data-admin-status="no_show">노쇼</button><button class="primary" data-admin-status="cancelled">취소 처리</button></div></div>`:''}<div class="modal-actions"><button class="secondary" data-close>닫기</button></div></section></div>`;
  document.querySelector('[data-close]').onclick=close;
  document.querySelectorAll('[data-admin-status]').forEach(button=>button.onclick=()=>adminChangeReservation(r.id,button.dataset.adminStatus,()=>adminReservationModal(r.id)));
}
async function adminChangeReservation(id,status,reopen){
  const reason=(document.querySelector('#admin-reservation-reason')?.value||'').trim();
  if(status==='cancelled'){
    if(!reason){alert('취소 사유를 입력해주세요.');return}
    if(!confirm('이 예약을 취소할까요? 잔여 팀이 즉시 복구되고 환불 규정이 적용됩니다.'))return;
  }else if(!confirm(`예약 상태를 '${adminReservationStatusLabel({status})}'(으)로 변경할까요?`))return;
  const response=await apiClient.request(`/api/admin/reservations/${encodeURIComponent(id)}/status`,{method:'POST',body:{status,reason},token:adminToken(),timeoutMs:10000});
  if(!response.ok){
    if(response.status===409)alert('다른 곳에서 먼저 변경했습니다. 새로고침합니다.');
    else handleAdminError(response);
    if(response.status!==401&&response.status!==403)alert((response.error&&response.error.message)||'변경하지 못했습니다.');
    close();if(document.querySelector('#reservations-root'))loadAdminReservations();
    return;
  }
  close();
  if(document.querySelector('#reservations-root'))loadAdminReservations();
  if(status==='cancelled')alert(`예약을 취소했습니다. 환불 금액 ${money((response.data.refund&&response.data.refund.refundAmount)||0)}(시연)`);
}
function refunds(){
  if(isServerMode()){
    return shell('취소·환불 관리',`<section class="panel"><div class="head"><div><h2>취소·환불 내역</h2><p class="admin-caption">서버 예약 중 취소된 건입니다. 환불 금액은 골프장 취소 정책으로 계산됩니다(시연용).</p></div><button class="secondary" id="refresh-reservations">새로고침</button></div><div id="reservations-root"><div class="notice">서버에서 불러오는 중…</div></div></section>`);
  }
  const items=get(RKEY).filter(item=>item.status==='cancelled');
  if(!items.length)return shell('취소·환불 관리','<section class="panel"><div class="head"><h2>취소 요청</h2></div><div class="empty">취소 요청이 없습니다.</div></section>');
  const rows=items.map(item=>`<tr><td>${item.number}</td><td>${item.courseName||item.course||'-'}</td><td>${item.booker||item.name||'-'}</td><td>${item.date}</td><td>${money(item.paidDeposit??item.deposit)}</td><td>${money(item.refundAmount??item.paidDeposit??item.deposit)}</td><td><span class="badge bad">취소 완료</span></td><td><button class="primary" data-refund="${item.id}">확인</button></td></tr>`).join('');
  return shell('취소·환불 관리',`<section class="panel"><div class="head"><h2>취소 내역</h2></div><div class="table-wrap"><table class="table"><thead><tr><th>예약번호</th><th>골프장</th><th>예약자</th><th>이용일</th><th>예약금</th><th>환불액</th><th>처리 상태</th><th>관리</th></tr></thead><tbody>${rows}</tbody></table></div></section>`)
}
function members(){let m=get(MKEY),r=get(RKEY);return shell('회원 관리',`<section class="panel"><div class="head"><h2>회원 목록</h2></div><div class="table-wrap"><table class="table"><thead><tr><th>회원번호</th><th>이름</th><th>휴대전화</th><th>이메일</th><th>가입일</th><th>예약</th><th>취소</th><th>상태</th><th>관리</th></tr></thead><tbody>${m.map(x=>`<tr><td>${x.id}</td><td>${x.name}</td><td>${x.phone}</td><td>${x.email}</td><td>${x.joined}</td><td>${r.filter(y=>(y.booker||y.name)===x.name).length}건</td><td>0건</td><td><span class="badge">${x.status}</span></td><td><button class="secondary" data-member="${x.id}">상세</button></td></tr>`).join('')}</tbody></table></div></section>`)}
function settlements(){if(isServerMode())return settlementsPage();let p=get(PKEY),r=get(RKEY).filter(x=>x.status==='confirmed');return shell('정산·수수료 관리',`<section class="panel"><div class="head"><h2>골프장별 정산(정적 시연)</h2></div><p class="notice">정적 시연 모드의 예시 표입니다. 서버를 실행하면 수수료율·정산서·상태 전이가 서버 DB 기준으로 동작합니다.</p><div class="table-wrap"><table class="table"><thead><tr><th>정산번호</th><th>골프장</th><th>기간</th><th>예약 건수</th><th>예약금 총액</th><th>수수료</th><th>지급 예정액</th><th>상태</th><th>상세</th></tr></thead><tbody>${p.map((x,i)=>{let amount=r.reduce((s,v)=>s+(v.deposit||0),0),fee=Math.round(amount*x.fee/100);return `<tr><td>ST-202608-${String(i+1).padStart(3,'0')}</td><td>${x.name}</td><td>2026.08.01~08.31</td><td>${r.length}건</td><td>${money(amount)}</td><td>${money(fee)}</td><td>${money(amount-fee)}</td><td><span class="badge warn">정산 검토</span></td><td><button class="secondary">상세</button></td></tr>`}).join('')}</tbody></table></div></section>`)}
function banners(){return shell('배너·혜택 관리',`<section class="panel"><div class="head"><h2>홈 배너 및 혜택</h2><button class="primary" id="new-banner">+ 콘텐츠 등록</button></div><div class="notice">시연용 콘텐츠입니다. 노출 순서와 공개 여부를 관리할 수 있습니다.</div><div class="table-wrap"><table class="table"><thead><tr><th>유형</th><th>제목</th><th>연결 경로</th><th>노출 기간</th><th>상태</th><th>순서</th><th>관리</th></tr></thead><tbody><tr><td>홈 배너</td><td>제주 2박 3일 골프여행</td><td>/travel/jeju</td><td>2026.08.01~08.31</td><td><span class="badge">노출</span></td><td>1</td><td><button class="secondary">수정</button></td></tr><tr><td>특가</td><td>주말 특가 티타임</td><td>/reserve</td><td>2026.08.10~08.20</td><td><span class="badge">노출</span></td><td>2</td><td><button class="secondary">수정</button></td></tr></tbody></table></div></section>`)}
function inquiries(){let q=get(QKEY);return shell('고객 문의',`<section class="panel"><div class="head"><h2>문의 목록</h2></div><div class="table-wrap"><table class="table"><thead><tr><th>유형</th><th>작성자</th><th>제목</th><th>상태</th><th>관리</th></tr></thead><tbody>${q.map(x=>`<tr><td>${x.type}</td><td>${x.writer}</td><td>${x.title}</td><td><span class="badge ${x.status==='답변 완료'?'':'warn'}">${x.status}</span></td><td><button class="secondary" data-inquiry="${x.id}">답변</button></td></tr>`).join('')}</tbody></table></div></section>`)}
function settings(){return shell('운영 설정',`<section class="panel"><h2>운영 정책</h2><div class="form-grid"><label class="field">기본 예약금<input value="30,000"></label><label class="field">기본 수수료율<input value="10"></label><label class="field full">운영 공지<textarea rows="3">ALL:GOLF 시연용 운영 설정입니다.</textarea></label></div><div class="actions"><button class="primary" id="save-settings">저장</button></div></section>`)}
function partnerModal(){modal.innerHTML=`<div class="modal-bg"><section class="modal"><h2>신규 제휴 골프장 등록</h2><div class="form-grid"><label class="field">골프장명<input id="p-name"></label><label class="field">사업자등록번호<input id="p-business"></label><label class="field">대표자명<input id="p-owner"></label><label class="field">대표 전화<input id="p-phone"></label><label class="field">담당자명<input id="p-manager"></label><label class="field">담당자 이메일<input id="p-email"></label><label class="field full">주소<input id="p-address"></label><label class="field">수수료율<input id="p-fee" type="number" value="10"></label><label class="field">정산 주기<select id="p-cycle"><option>매월 15일</option><option>매월 말일</option></select></label><label class="field">제휴 상태<select id="p-status"><option>심사 중</option><option>정상 운영</option></select></label></div><div class="actions"><button class="secondary" data-close>닫기</button><button class="primary" id="save-partner">등록 및 계정 발급</button></div></section></div>`;document.querySelector('[data-close]').onclick=close;document.querySelector('#save-partner').onclick=()=>{if(!document.querySelector('#p-name').value||!document.querySelector('#p-manager').value)return alert('골프장명과 담당자명은 필수입니다.');let p={id:'p'+Date.now(),name:val('p-name'),manager:val('p-manager'),phone:val('p-phone'),region:'신규',status:val('p-status'),fee:+val('p-fee'),cycle:val('p-cycle'),created:'2026-08-12'};set(PKEY,[...get(PKEY),p]);close();alert('제휴사 계정 발급 완료 (시연용)');render()}}
const val=id=>document.querySelector('#'+id).value,close=()=>modal.innerHTML='';
function bookingModal(id){let r=get(RKEY).find(x=>x.id===id);modal.innerHTML=`<div class="modal-bg"><section class="modal"><h2>예약 상세 및 강제 상태 변경</h2><p><b>${r.number}</b><br>${r.course||'-'} · ${r.date} ${r.time} · ${r.people}인<br>예약자 ${r.booker||r.name||'-'} · ${r.phone||'-'}<br>예약금 ${money(r.deposit)} · 현장 결제 ${money(r.onsite)}</p><label class="field">변경 상태<select id="force-status"><option value="confirmed">예약 확정</option><option value="completed">이용 완료</option><option value="no-show">노쇼</option><option value="cancelled">취소 완료</option></select></label><label class="field">변경 사유<textarea id="force-reason" rows="2" placeholder="강제 변경 사유"></textarea></label><div class="actions"><button class="secondary" data-close>닫기</button><button class="primary" id="force-save">변경 확인</button></div></section></div>`;document.querySelector('[data-close]').onclick=close;document.querySelector('#force-save').onclick=()=>{if(!val('force-reason'))return alert('변경 사유를 입력해주세요.');if(!confirm('예약 상태를 변경할까요?'))return;set(RKEY,get(RKEY).map(x=>x.id===id?{...x,status:val('force-status'),adminReason:val('force-reason')}:x));close();render()}}
function answerModal(id){let q=get(QKEY).find(x=>x.id===id);modal.innerHTML=`<div class="modal-bg"><section class="modal"><h2>문의 답변</h2><p>${q.type} · ${q.writer}<br>${q.content}</p><label class="field">관리자 답변<textarea id="answer" rows="4">${q.answer||''}</textarea></label><div class="actions"><button class="secondary" data-close>닫기</button><button class="primary" id="save-answer">답변 저장</button></div></section></div>`;document.querySelector('[data-close]').onclick=close;document.querySelector('#save-answer').onclick=()=>{set(QKEY,get(QKEY).map(x=>x.id===id?{...x,status:'답변 완료',answer:val('answer')}:x));close();render()}}
function downloadCourses(){const quote=value=>`"${String(value??'').replaceAll('"','""')}"`;const header=['ID','골프장명','시도','시군구','주소','운영형태','홀수','예약상태','전화번호','출처','기준일'];const rows=masterCourses.map(course=>[course.id,course.name,course.region,course.city,course.address,course.operationType,course.holes,isPartnered(course.id)?'제휴 예약':'정보 제공',course.phone,course.source,course.sourceAsOf||course.lastVerified]);const csv='\uFEFF'+[header,...rows].map(row=>row.map(quote).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=`all-golf-courses-${new Date().toISOString().slice(0,10)}.csv`;link.click();URL.revokeObjectURL(url)}
function bind(){
  document.querySelectorAll('[data-page]').forEach(x=>x.onclick=()=>{page=x.dataset.page;render()});
  if(isServerMode()&&page==='applications'){loadApplicationsServer();loadAuditServer('audit-root',20)}
  if(isServerMode()&&page==='audit'){loadAuditServer('audit-root',200)}
  if(isServerMode()&&page==='accounts'){loadAccountsServer();document.querySelector('#new-partner-account')?.addEventListener('click',()=>{if(!adminCoursesCache.length){apiClient.request('/api/partner-courses',{timeoutMs:6000}).then(response=>{adminCoursesCache=(response.data&&response.data.courses)||[];newAccountModal()})}else newAccountModal()})}
  if(isServerMode()&&page==='operations'){loadOperationsServer()}
  if(isServerMode()&&page==='analytics'){loadAnalyticsServer()}
  if(isServerMode()&&page==='settlements'){loadSettlementsServer()}
  document.querySelectorAll('[data-analytics-period]').forEach(x=>x.onclick=()=>{analyticsPeriod=x.dataset.analyticsPeriod;adminAnalytics=null;render()});
  document.querySelector('#analytics-csv')?.addEventListener('click',()=>downloadAdminFile(`/api/admin/analytics?period=${encodeURIComponent(analyticsPeriod)}&format=csv`,`allgolf-analytics-${analyticsPeriod}-${todayIso()}.csv`));
  document.querySelector('#analytics-json')?.addEventListener('click',()=>downloadAdminFile('',`allgolf-analytics-${analyticsPeriod}-${todayIso()}.json`,JSON.stringify(adminAnalytics||{},null,2)));
  document.querySelector('#refresh-settlements')?.addEventListener('click',()=>{adminSettlements=null;adminCommissionRows=null;loadSettlementsServer()});
  document.querySelector('#settlements-csv')?.addEventListener('click',()=>downloadAdminFile('/api/admin/settlements/export',`allgolf-settlements-${todayIso()}.csv`));
  document.querySelector('#create-settlement')?.addEventListener('click',createSettlementFromForm);
  if(isServerMode()&&(page==='reservations'||page==='refunds')){loadAdminReservations()}
  document.querySelector('#refresh-accounts')?.addEventListener('click',loadAccountsServer);
  document.querySelector('#refresh-operations')?.addEventListener('click',loadOperationsServer);
  document.querySelector('#operations-date')?.addEventListener('change',loadOperationsServer);
  document.querySelector('#refresh-applications')?.addEventListener('click',()=>{loadApplicationsServer();loadAuditServer('audit-root',20)});
  document.querySelector('#refresh-audit')?.addEventListener('click',()=>loadAuditServer('audit-root',200));
  document.querySelectorAll('[data-application-filter]').forEach(x=>x.onclick=()=>{applicationFilter=x.dataset.applicationFilter;if(isServerMode())loadApplicationsServer();else render()});
  document.querySelectorAll('[data-application]').forEach(x=>x.onclick=()=>applicationModal(x.dataset.application));
  document.querySelectorAll('[data-period]').forEach(x=>x.onclick=()=>{period=x.dataset.period;render()});
  document.querySelector('#logout')?.addEventListener('click',async()=>{localStorage.removeItem(AUTH);if(isServerMode()){try{await apiClient.request('/api/admin/logout',{method:'POST',token:adminToken()})}catch{}apiClient.clearToken()}render()});
  document.querySelector('#new-partner')?.addEventListener('click',partnerModal);
  document.querySelector('#course-query')?.addEventListener('change',event=>{courseQuery=event.target.value.trim();render()});
  document.querySelector('#course-region')?.addEventListener('change',event=>{courseRegion=event.target.value;render()});
  document.querySelector('#course-type')?.addEventListener('change',event=>{courseType=event.target.value;render()});
  document.querySelector('#course-scope')?.addEventListener('change',event=>{courseScope=event.target.value;render()});
  document.querySelector('#download-courses')?.addEventListener('click',downloadCourses);
  document.querySelectorAll('[data-stop]').forEach(x=>x.onclick=()=>{if(!confirm('티타임 판매 상태를 변경할까요?'))return;set(TKEY,get(TKEY).map(t=>t.id===x.dataset.stop?{...t,closed:!t.closed}:t));render()});
  document.querySelectorAll('[data-tee]').forEach(x=>x.onclick=()=>alert('가격 수정은 제휴사 티타임 관리에서 시연할 수 있습니다.'));
  document.querySelectorAll('[data-reservation]').forEach(x=>x.onclick=()=>bookingModal(x.dataset.reservation));
  document.querySelectorAll('[data-refund]').forEach(x=>x.onclick=()=>{if(!confirm('테스트 환불을 승인할까요?'))return;set(RKEY,get(RKEY).map(r=>r.id===x.dataset.refund?{...r,status:'refund-complete'}:r));render()});
  document.querySelectorAll('[data-reject]').forEach(x=>x.onclick=()=>{let reason=prompt('취소 거절 사유를 입력해주세요.');if(!reason)return;set(RKEY,get(RKEY).map(r=>r.id===x.dataset.reject?{...r,status:'confirmed',rejectReason:reason}:r));render()});
  document.querySelectorAll('[data-inquiry]').forEach(x=>x.onclick=()=>answerModal(x.dataset.inquiry));
  document.querySelector('#save-settings')?.addEventListener('click',()=>alert('운영 설정이 저장되었습니다. (시연용)'));
  document.querySelector('#new-banner')?.addEventListener('click',()=>alert('배너 등록 화면은 시연 안내입니다.'));
  document.querySelector('#run-server-guide')?.addEventListener('click',()=>alert('터미널에서 npm start (또는 start-server.bat)를 실행한 뒤 http://127.0.0.1:4173/admin/ 으로 접속하면 서버 모드로 바뀝니다.'));
}
function bindApplicationActions(){
  document.querySelectorAll('[data-application]').forEach(x=>x.onclick=()=>applicationModal(x.dataset.application));
  document.querySelectorAll('[data-application-filter]').forEach(x=>x.onclick=()=>{applicationFilter=x.dataset.applicationFilter;loadApplicationsServer()});
}
function bindLogin(){
  document.querySelector('#login').onclick=async()=>{
    if(!isServerMode()){
      if(!val('email').trim()||!val('password'))return alert('시연 입장을 위해 이메일과 비밀번호를 입력해주세요. 어떤 값이든 괜찮습니다.');
      enterDemo();return;
    }
    const button=document.querySelector('#login');button.disabled=true;button.textContent='로그인 중…';
    const response=await apiClient.request('/api/admin/login',{method:'POST',body:{email:val('email'),password:val('password')},timeoutMs:10000});
    button.disabled=false;button.textContent='로그인';
    if(!response.ok){document.querySelector('#login-error').textContent=(response.error&&response.error.message)||'로그인하지 못했습니다.';return}
    apiClient.setToken(response.data.token);
    localStorage.setItem(AUTH,'server');
    render();
  };
  document.querySelector('#password')?.addEventListener('keydown',event=>{if(event.key==='Enter')document.querySelector('#login').click()});
  document.querySelector('#demo-enter')?.addEventListener('click',enterDemo);
}
function enterDemo(){localStorage.setItem(AUTH,'true');render()}
/* ===== 7단계: 골프장 담당자 계정·운영 현황 ===== */
let adminAccounts=[],adminAccountStats=null,adminCoursesCache=[],adminOperations=null,accountsLoading=false,operationsLoading=false;
function accountStatusBadge(status){return `<span class="badge ${status==='active'?'approved':'rejected'}">${status==='active'?'사용 중':'사용 중지'}</span>`}
function accountsPage(){
  if(!isServerMode()){
    return shell('제휴 계정 관리','<section class="panel"><div class="empty">정적 시연 모드에서는 서버 계정 관리가 없습니다. <code>npm start</code> 로 서버를 실행하면 골프장별 담당자 계정을 만들 수 있습니다.</div></section>');
  }
  return shell('제휴 계정 관리',`<section class="panel"><div class="head"><div><h2>골프장 담당자 계정</h2><p class="admin-caption">제휴 승인된 골프장에만 계정을 발급할 수 있습니다. 권한·상태 변경 시 해당 계정의 기존 세션은 즉시 무효화됩니다.</p></div><div class="tools"><button class="secondary" id="refresh-accounts">새로고침</button><button class="primary" id="new-partner-account">+ 계정 생성</button></div></div><div id="accounts-root"><div class="notice">서버에서 불러오는 중…</div></div></section>`)
}
async function loadAccountsServer(){
  const root=document.querySelector('#accounts-root');
  if(!root||!isServerMode())return;
  if(accountsLoading)return;
  accountsLoading=true;
  const [accountsResponse,coursesResponse]=await Promise.all([
    apiClient.request('/api/admin/partner-accounts',{token:adminToken(),timeoutMs:8000}),
    apiClient.request('/api/partner-courses',{timeoutMs:8000})
  ]);
  accountsLoading=false;
  if(!accountsResponse.ok){root.innerHTML=`<div class="form-error">${esc((accountsResponse.error&&accountsResponse.error.message)||'계정을 불러오지 못했습니다.')}</div>`;handleAdminError(accountsResponse);return}
  adminAccounts=accountsResponse.data.accounts||[];
  adminAccountStats=accountsResponse.data.stats||{total:0,active:0,disabled:0,courses:0};
  adminCoursesCache=(coursesResponse.data&&coursesResponse.data.courses)||[];
  root.innerHTML=accountsBody();
  bindAccountActions();
}
function accountsBody(){
  const stats=adminAccountStats||{total:0,active:0,disabled:0,courses:0};
  return `<section class="national-kpis application-kpis">${[['전체 계정',stats.total],['사용 중',stats.active],['사용 중지',stats.disabled],['계정 있는 골프장',stats.courses]].map(([label,value])=>`<article class="stat"><small>${label}</small><strong>${value}</strong></article>`).join('')}</section><p class="notice">계정은 골프장별로 분리되며, 담당자는 자기 골프장 티타임·요금·특가만 수정할 수 있습니다. 비밀번호는 scrypt 해시로만 저장되고 화면·API로 다시 조회할 수 없습니다.</p><div class="table-wrap"><table class="table"><thead><tr><th>계정</th><th>골프장</th><th>권한</th><th>상태</th><th>마지막 로그인</th><th>생성일</th><th>관리</th></tr></thead><tbody>${adminAccounts.map(account=>`<tr><td><b>${esc(account.name)}</b><small class="demo-cell">${esc(account.email)}</small><small class="demo-cell">${esc(account.id)}</small></td><td>${esc(account.courseName||account.courseId)}<small class="demo-cell">${esc(account.courseId)}</small></td><td>${esc(account.roleLabel||account.role)}</td><td>${accountStatusBadge(account.status)}</td><td>${esc(String(account.lastLoginAt||'-').slice(0,16).replace('T',' '))}</td><td>${esc(String(account.createdAt||'').slice(0,10))}</td><td><button class="secondary" data-account-toggle="${esc(account.id)}">${account.status==='active'?'사용 중지':'사용 재개'}</button> <button class="secondary" data-account-reset="${esc(account.id)}">비밀번호 재설정</button></td></tr>`).join('')||'<tr><td colspan="7" class="empty">발급된 담당자 계정이 없습니다. ‘계정 생성’으로 발급하세요.</td></tr>'}</tbody></table></div>`;
}
function bindAccountActions(){
  document.querySelectorAll('[data-account-toggle]').forEach(button=>button.onclick=()=>toggleAccount(button.dataset.accountToggle));
  document.querySelectorAll('[data-account-reset]').forEach(button=>button.onclick=()=>resetAccountPassword(button.dataset.accountReset));
}
function newAccountModal(){
  if(!adminCoursesCache.length){alert('제휴 승인된 골프장이 없습니다. 먼저 제휴 신청을 승인해주세요.');return}
  modal.innerHTML=`<div class="modal-bg"><section class="modal"><h2>골프장 담당자 계정 생성</h2><p>계정은 제휴 승인된 골프장에 연결됩니다. 초기 비밀번호는 생성 직후 한 번만 표시됩니다.</p><div class="form-grid"><label class="field full">골프장<select id="acc-course">${adminCoursesCache.map(course=>`<option value="${esc(course.id)}">${esc(course.name)} · ${esc(course.region)} ${esc(course.city)}</option>`).join('')}</select></label><label class="field">담당자명<input id="acc-name" maxlength="20" placeholder="홍길동"></label><label class="field">이메일<input id="acc-email" type="email" maxlength="60" placeholder="partner@example.com"></label><label class="field">권한<select id="acc-role"><option value="manager">운영 담당</option><option value="owner">대표 관리자</option><option value="viewer">조회 전용</option></select></label><label class="field">초기 비밀번호<input id="acc-password" type="text" placeholder="비워 두면 자동 생성"></label></div><p class="notice">비밀번호는 8자 이상, 영문과 숫자를 각각 포함해야 합니다. 계정을 만들면 담당자에게 이메일·초기 비밀번호를 직접 전달하세요(시연용).</p><div class="form-error" id="acc-error"></div><div class="actions"><button class="secondary" data-close>닫기</button><button class="primary" id="acc-save">계정 생성</button></div></section></div>`;
  document.querySelector('[data-close]').onclick=close;
  document.querySelector('#acc-save').onclick=async()=>{
    const body={courseId:document.querySelector('#acc-course').value,name:document.querySelector('#acc-name').value,email:document.querySelector('#acc-email').value,role:document.querySelector('#acc-role').value,password:document.querySelector('#acc-password').value};
    const errorBox=document.querySelector('#acc-error');
    const button=document.querySelector('#acc-save');button.disabled=true;button.textContent='생성 중…';
    const response=await apiClient.request('/api/admin/partner-accounts',{method:'POST',body,token:adminToken(),timeoutMs:10000});
    button.disabled=false;button.textContent='계정 생성';
    if(!response.ok){errorBox.textContent=(response.error&&response.error.message)||'계정을 만들지 못했습니다.';return}
    const data=response.data;
    modal.innerHTML=`<div class="modal-bg"><section class="modal"><h2>계정이 생성되었습니다</h2><p>${esc(data.account.name)} · ${esc(data.account.courseName||data.account.courseId)}<br>${esc(data.account.email)} · ${esc(data.account.roleLabel)}</p><div class="notice"><b>초기 비밀번호: ${esc(data.initialPassword)}</b><br>이 값은 지금 이 화면에서만 표시됩니다. 담당자에게 안전하게 전달하세요.</div><p class="notice">요청대로 저장되었습니다. 골프장 담당자는 /partner/ 에서 이 계정으로 로그인합니다.</p><div class="actions"><button class="primary" id="acc-done">확인</button></div></section></div>`;
    document.querySelector('#acc-done').onclick=()=>{close();loadAccountsServer()};
  };
}
async function toggleAccount(id){
  const account=adminAccounts.find(item=>item.id===id);if(!account)return;
  const next=account.status==='active'?'disabled':'active';
  if(!confirm(next==='disabled'?'이 계정의 사용을 중지할까요?\n기존 로그인 세션도 즉시 무효화됩니다.':'이 계정의 사용을 다시 허용할까요?'))return;
  const response=await apiClient.request(`/api/admin/partner-accounts/${encodeURIComponent(id)}`,{method:'PATCH',body:{status:next,version:account.version},token:adminToken(),timeoutMs:8000});
  if(!response.ok){if(response.status===409)alert('다른 곳에서 먼저 변경했습니다. 새로고침합니다.');else alert((response.error&&response.error.message)||'변경하지 못했습니다.');loadAccountsServer();return}
  loadAccountsServer();
}
async function resetAccountPassword(id){
  const account=adminAccounts.find(item=>item.id===id);if(!account)return;
  if(!confirm(`${account.email} 계정의 비밀번호를 재설정할까요?\n기존 세션은 즉시 만료됩니다.`))return;
  const response=await apiClient.request(`/api/admin/partner-accounts/${encodeURIComponent(id)}/reset-password`,{method:'POST',body:{},token:adminToken(),timeoutMs:8000});
  if(!response.ok){alert((response.error&&response.error.message)||'재설정하지 못했습니다.');return}
  modal.innerHTML=`<div class="modal-bg"><section class="modal"><h2>비밀번호가 재설정되었습니다</h2><p>${esc(account.email)}</p><div class="notice"><b>새 비밀번호: ${esc(response.data.initialPassword)}</b><br>이 값은 지금 이 화면에서만 표시됩니다. 기존 로그인 세션은 모두 만료되었습니다.</div><div class="actions"><button class="primary" id="reset-done">확인</button></div></section></div>`;
  document.querySelector('#reset-done').onclick=()=>{close();loadAccountsServer()};
}
function operationsPage(){
  if(!isServerMode()){
    return shell('골프장 운영 현황','<section class="panel"><div class="empty">정적 시연 모드에서는 서버 운영 현황이 없습니다. <code>npm start</code> 로 서버를 실행하세요.</div></section>');
  }
  return shell('골프장 운영 현황',`<section class="panel"><div class="head"><div><h2>골프장별 티타임·특가 현황</h2><p class="admin-caption">서버 DB 기준입니다. 골프장 담당자가 수정한 내용과 최근 변경 이력이 함께 표시됩니다.</p></div><div class="tools"><input class="date-picker" id="operations-date" type="date" value="${new Date().toISOString().slice(0,10)}"><button class="secondary" id="refresh-operations">새로고침</button></div></div><div id="operations-root"><div class="notice">서버에서 불러오는 중…</div></div></section>`)
}
async function loadOperationsServer(){
  const root=document.querySelector('#operations-root');
  if(!root||!isServerMode()||operationsLoading)return;
  operationsLoading=true;
  const date=(document.querySelector('#operations-date')&&document.querySelector('#operations-date').value)||new Date().toISOString().slice(0,10);
  const response=await apiClient.request(`/api/admin/operations?date=${encodeURIComponent(date)}`,{token:adminToken(),timeoutMs:8000});
  operationsLoading=false;
  if(!response.ok){root.innerHTML=`<div class="form-error">${esc((response.error&&response.error.message)||'현황을 불러오지 못했습니다.')}</div>`;handleAdminError(response);return}
  adminOperations=response.data;
  root.innerHTML=operationsBody(response.data);
  document.querySelectorAll('[data-ops-tees]').forEach(button=>button.onclick=()=>showOperationsTees(button.dataset.opsTees,button.dataset.opsDate));
}
function operationsBody(data){
  const totals=data.totals||{};
  const labels={};
  return `<section class="national-kpis application-kpis">${[['제휴 골프장',totals.courses||0],['등록 티타임',totals.teeTimes||0],['선택일 티타임',totals.teeTimesOnDate||0],['등록 특가',totals.offers||0],['담당자 계정',totals.accounts||0]].map(([label,value])=>`<article class="stat"><small>${label}</small><strong>${value}</strong></article>`).join('')}</section><div class="table-wrap"><table class="table"><thead><tr><th>골프장</th><th>티타임</th><th>${esc(data.date)} 티타임</th><th>특가</th><th>계정</th><th>마지막 수정</th><th>최근 변경</th><th>상세</th></tr></thead><tbody>${(data.courses||[]).map(course=>`<tr><td><b>${esc(course.courseName)}</b><small class="demo-cell">${esc(course.courseId)}</small></td><td>${course.teeTimes.total}건<br><small class="demo-cell">판매 중 ${course.teeTimes.open}건</small></td><td>${course.teeTimes.date}건</td><td>${course.offers.total}건<br><small class="demo-cell">진행 ${course.offers.active} · 예정 ${course.offers.scheduled} · 종료 ${course.offers.ended}</small></td><td>${course.accounts.active}/${course.accounts.total}</td><td>${esc(String(course.lastUpdated||'-').slice(0,16).replace('T',' '))}</td><td>${(course.recent||[]).slice(0,2).map(log=>`<small class="demo-cell">${esc(String(log.at||'').slice(5,16).replace('T',' '))} ${esc(auditLabel(log.action))} · ${esc((log.actor&&log.actor.email)||'')}</small>`).join('')||'-'}</td><td><button class="secondary" data-ops-tees="${esc(course.courseId)}" data-ops-date="${esc(data.date)}">티타임 보기</button></td></tr>`).join('')||'<tr><td colspan="8" class="empty">제휴 승인된 골프장이 없습니다.</td></tr>'}</tbody></table></div>`;
}
async function showOperationsTees(courseId,date){
  const response=await apiClient.request(`/api/admin/tee-times?courseId=${encodeURIComponent(courseId)}&date=${encodeURIComponent(date)}`,{token:adminToken(),timeoutMs:8000});
  if(!response.ok){alert((response.error&&response.error.message)||'티타임을 불러오지 못했습니다.');handleAdminError(response);return}
  const items=response.data.teeTimes||[];
  modal.innerHTML=`<div class="modal-bg"><section class="modal application-modal"><h2>${esc(date)} 티타임</h2><p>${esc(courseId)} · 서버 DB 기준</p><div class="table-wrap"><table class="table"><thead><tr><th>시간</th><th>코스</th><th>부</th><th>팀</th><th>그린피</th><th>상태</th><th>수정자</th></tr></thead><tbody>${items.map(tee=>`<tr><td><b>${esc(tee.time)}</b></td><td>${esc(tee.course||'전체')}</td><td>${esc(tee.session)}</td><td>${tee.capacityTeams}</td><td>${money(tee.greenFee)}</td><td>${esc(tee.statusLabel)}</td><td>${esc((tee.updatedBy&&tee.updatedBy.email)||'-')}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">등록된 티타임이 없습니다.</td></tr>'}</tbody></table></div><div class="modal-actions"><button class="primary" data-close>확인</button></div></section></div>`;
  document.querySelector('[data-close]').onclick=close;
}
/* --- 9단계: 운영 통계·제휴 성과 · 수수료/정산 시뮬레이션 ------------------ */
let adminAnalytics=null,analyticsPeriod='30d',analyticsLoading=false;
let adminSettlements=null,adminCommissionRows=null,settlementsLoading=false,settlementStatusFilter='all';
const settlementStatusLabel=status=>({DRAFT:'작성 중',PENDING:'확인 대기',CONFIRMED:'확정',PAID:'지급 완료'})[status]||status;
const settlementStatusClass=status=>status==='PAID'?'approved':status==='CONFIRMED'?'active':status==='PENDING'?'warn':'closed';
const rateText=value=>`${Number(value||0)}%`;
const todayIso=()=>new Date(Date.now()+9*3600*1000).toISOString().slice(0,10);
const shiftIso=(iso,days)=>{const base=new Date(`${iso}T00:00:00Z`);base.setUTCDate(base.getUTCDate()+days);return base.toISOString().slice(0,10)};

async function downloadAdminFile(pathname,filename,fallbackJson){
  try{
    if(fallbackJson!=null){
      const url=URL.createObjectURL(new Blob([fallbackJson],{type:'application/json;charset=utf-8'}));
      const link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      return;
    }
    const response=await fetch(apiClient.apiUrl(pathname),{headers:{Authorization:`Bearer ${adminToken()}`},cache:'no-store'});
    if(!response.ok){alert('다운로드하지 못했습니다. 다시 로그인한 뒤 시도해주세요.');handleAdminError({status:response.status});return}
    const text=await response.text();
    const url=URL.createObjectURL(new Blob([text],{type:pathname.includes('csv')?'text/csv;charset=utf-8':'application/json;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(error){alert('다운로드하지 못했습니다.');}
}

function analyticsPage(){
  if(!isServerMode()){
    return shell('운영 통계·제휴 성과','<section class="panel"><div class="head"><h2>기간별 운영 통계</h2></div><div class="empty">정적 시연 모드에서는 서버 운영 통계가 없습니다. <code>npm start</code> 로 서버를 실행하면 예약·제휴 성과 지표가 표시됩니다.</div><p class="notice">정적 모드에서는 네트워크 요청을 보내지 않습니다.</p></section>');
  }
  return shell('운영 통계·제휴 성과',`<section class="panel"><div class="head"><div><h2>기간별 운영 통계</h2><p class="admin-caption">예약 접수일 기준 집계입니다. GMV 는 취소되지 않은 예약(확정·이용완료·노쇼)의 예약 총액이며, 정산은 라운드일 기준으로 별도 계산합니다. 시연용 집계입니다.</p></div><div class="tools"><button class="secondary" id="analytics-csv">CSV 내보내기</button> <button class="secondary" id="analytics-json">JSON 내보내기</button></div></div><div class="tabs application-tabs">${[['today','오늘'],['7d','최근 7일'],['30d','최근 30일'],['all','전체']].map(([id,label])=>`<button class="${analyticsPeriod===id?'active':''}" data-analytics-period="${id}">${label}</button>`).join('')}</div><div id="analytics-root">${adminAnalytics?analyticsBody(adminAnalytics):'<div class="notice">서버에서 불러오는 중…</div>'}</div></section>`)
}
async function loadAnalyticsServer(){
  if(!isServerMode()||analyticsLoading)return;
  analyticsLoading=true;
  const response=await apiClient.request(`/api/admin/analytics?period=${encodeURIComponent(analyticsPeriod)}`,{token:adminToken(),timeoutMs:10000});
  analyticsLoading=false;
  const root=document.querySelector('#analytics-root');
  if(!response.ok){if(root)root.innerHTML=`<div class="form-error">${esc((response.error&&response.error.message)||'통계를 불러오지 못했습니다.')}</div>`;handleAdminError(response);return}
  adminAnalytics=response.data;
  if(root)root.innerHTML=analyticsBody(adminAnalytics);
}
function analyticsBody(data){
  const totals=data.totals||{},apps=data.applications||{},period=data.period||{};
  const kpis=[['예약 건수',`${totals.reservations||0}건`],['GMV',money(totals.gmv)],['취소·환불액',money(totals.refundAmount)],['취소 수수료',money(totals.cancellationFee)],['노쇼율',rateText(totals.noShowRate)],['객단가',money(totals.averageTicket)]];
  const appKpis=[['제휴 신청',`${apps.total||0}건`],['승인',`${apps.approved||0}건`],['반려',`${apps.rejected||0}건`],['승인 전환율',rateText(apps.conversionRate)],['기간 내 승인',`${apps.approvedInPeriod||0}건`]];
  const sessions=totals.sessions||{};
  return `<div class="notice">${esc(period.label||'')} · ${esc(period.basisLabel||'')} · ${esc(data.note||'')}</div><section class="national-kpis application-kpis">${kpis.map(([label,value])=>`<article class="stat"><small>${label}</small><strong>${value}</strong></article>`).join('')}</section><section class="national-kpis application-kpis">${appKpis.map(([label,value])=>`<article class="stat"><small>${label}</small><strong>${value}</strong></article>`).join('')}</section><div class="table-wrap"><table class="table"><thead><tr><th>부(시간대)</th><th>예약 건수</th><th>비중</th></tr></thead><tbody>${['1부','2부','3부'].map(key=>{const count=Number(sessions[key]||0);const base=['1부','2부','3부'].reduce((sum,item)=>sum+Number(sessions[item]||0),0);return `<tr><td><b>${key}</b></td><td>${count}건</td><td>${base?Math.round(count*1000/base)/10:0}%</td></tr>`}).join('')}</tbody></table></div><div class="table-wrap"><table class="table"><thead><tr><th>골프장</th><th>예약</th><th>인원</th><th>GMV</th><th>취소·환불</th><th>취소 수수료</th><th>정산 기준액</th><th>수수료율</th><th>플랫폼 수수료</th><th>정산 예정액</th></tr></thead><tbody>${(data.byCourse||[]).map(row=>`<tr><td><b>${esc(row.courseName||row.courseId)}</b><small class="demo-cell">${esc(row.courseId)}</small></td><td>${row.reservations}건<small class="demo-cell">확정 ${row.confirmed} · 취소 ${row.cancelled} · 노쇼 ${row.noShow}</small></td><td>${row.people}명</td><td>${money(row.gmv)}</td><td>${money(row.refundAmount)}</td><td>${money(row.cancellationFee)}</td><td>${money(row.basisAmount)}</td><td>${rateText(row.commissionRatePercent)}${row.commissionSource==='default'?'<small class="demo-cell">기본</small>':''}</td><td>${money(row.platformFee)}</td><td>${money(row.payoutAmount)}</td></tr>`).join('')||'<tr><td colspan="10" class="empty">해당 기간에 집계할 예약이 없습니다.</td></tr>'}</tbody></table></div><p class="notice">정산 기준액 = GMV + 취소 수수료 · 플랫폼 수수료 = 정산 기준액 × 수수료율 · 정산 예정액 = 정산 기준액 − 플랫폼 수수료</p>`;
}

function settlementsPage(){
  if(!isServerMode())return settlements();
  const today=todayIso();
  return shell('정산·수수료 관리',`<section class="panel"><div class="head"><div><h2>정산서 생성·상태 전이</h2><p class="admin-caption">DRAFT → PENDING → CONFIRMED → PAID 순서로만 진행됩니다. 같은 골프장·같은 기간의 정산서는 중복 생성되지 않습니다(409). 시연용이며 실제 계좌 이체는 없습니다.</p></div><div class="tools"><button class="secondary" id="settlements-csv">정산 CSV</button> <button class="secondary" id="refresh-settlements">새로고침</button></div></div><div class="form-grid"><label class="field">골프장<select id="settlement-course">${(adminCommissionRows||[]).map(row=>`<option value="${esc(row.courseId)}">${esc(row.courseName)} (${rateText(row.ratePercent)})</option>`).join('')||'<option value="">골프장을 불러오는 중</option>'}</select></label><label class="field">시작일<input id="settlement-from" type="date" value="${shiftIso(today,-30)}"></label><label class="field">종료일<input id="settlement-to" type="date" value="${today}"></label><label class="field">생성 상태<select id="settlement-status"><option value="DRAFT">DRAFT (작성 중)</option><option value="PENDING">PENDING (확인 대기)</option></select></label></div><div class="actions"><button class="primary" id="create-settlement">정산서 계산·생성</button></div><div class="notice">정산 기준: 라운드일이 기간에 포함된 예약 · 정산 기준액 = GMV + 취소 수수료 · 플랫폼 수수료 = 기준액 × 수수료율</div><div id="settlements-root">${adminSettlements?settlementsBody():'<div class="notice">서버에서 불러오는 중…</div>'}</div></section><section class="panel"><div class="head"><div><h2>골프장별 수수료율</h2><p class="admin-caption">기본 8% · 0~30% 범위에서 설정합니다. 변경은 감사 로그에 기록되며, 이미 만든 정산서의 수수료율은 생성 시점 값으로 유지됩니다.</p></div></div><div id="commission-root">${adminCommissionRows?commissionBody():'<div class="notice">불러오는 중…</div>'}</div></section>`)
}
async function loadSettlementsServer(){
  if(!isServerMode()||settlementsLoading)return;
  settlementsLoading=true;
  const [list,commissions]=await Promise.all([
    apiClient.request('/api/admin/settlements',{token:adminToken(),timeoutMs:10000}),
    apiClient.request('/api/admin/commissions',{token:adminToken(),timeoutMs:10000})
  ]);
  settlementsLoading=false;
  const root=document.querySelector('#settlements-root');
  const commissionRoot=document.querySelector('#commission-root');
  if(!list.ok){if(root)root.innerHTML=`<div class="form-error">${esc((list.error&&list.error.message)||'정산 목록을 불러오지 못했습니다.')}</div>`;handleAdminError(list);return}
  adminSettlements=list.data;
  if(commissions.ok)adminCommissionRows=commissions.data.courses||[];
  if(root)root.innerHTML=settlementsBody();
  if(commissionRoot)commissionRoot.innerHTML=commissionBody();
  const select=document.querySelector('#settlement-course');
  if(select&&adminCommissionRows&&!select.value&&adminCommissionRows.length)select.value=adminCommissionRows[0].courseId;
  bindSettlementActions();
}
function settlementsBody(){
  const data=adminSettlements||{},totals=data.totals||{};
  const kpis=[['정산서',`${data.count||0}건`],['확정',`${(data.byStatus&&data.byStatus.CONFIRMED)||0}건`],['지급 완료',`${(data.byStatus&&data.byStatus.PAID)||0}건`],['정산 기준액 합계',money(totals.basisAmount)],['플랫폼 수수료 합계',money(totals.platformFee)],['지급 예정 합계',money(totals.payoutAmount)]];
  return `<section class="national-kpis application-kpis">${kpis.map(([label,value])=>`<article class="stat"><small>${label}</small><strong>${value}</strong></article>`).join('')}</section><div class="table-wrap"><table class="table"><thead><tr><th>정산번호</th><th>골프장</th><th>기간</th><th>상태</th><th>수수료율</th><th>정산 기준액</th><th>플랫폼 수수료</th><th>정산 예정액</th><th>처리</th></tr></thead><tbody>${(data.settlements||[]).filter(item=>settlementStatusFilter==='all'||item.status===settlementStatusFilter).map(item=>`<tr><td><b>${esc(item.number)}</b><small class="demo-cell">${esc(item.id)}</small></td><td>${esc(item.courseName||item.courseId)}</td><td>${esc((item.period&&item.period.from)||'')}~${esc((item.period&&item.period.to)||'')}<small class="demo-cell">예약 ${item.reservations}건</small></td><td><span class="badge ${settlementStatusClass(item.status)}">${esc(settlementStatusLabel(item.status))}</span></td><td>${rateText(item.commissionRatePercent)}</td><td>${money(item.basisAmount)}</td><td>${money(item.platformFee)}</td><td><b>${money(item.payoutAmount)}</b></td><td>${(item.nextStatuses||[]).length?item.nextStatuses.map(next=>`<button class="secondary" data-settlement-next="${esc(next.status)}" data-settlement-id="${esc(item.id)}" data-settlement-version="${Number(item.version)||1}">${esc(next.label)}</button>`).join(' '):'<small class="demo-cell">처리 완료</small>'}</td></tr>`).join('')||'<tr><td colspan="9" class="empty">생성된 정산서가 없습니다. 위에서 기간과 골프장을 선택해 정산서를 계산하세요.</td></tr>'}</tbody></table></div><p class="notice">${esc(data.note||'')}</p>`;
}
function commissionBody(){
  const rows=adminCommissionRows||[];
  return `<div class="table-wrap"><table class="table"><thead><tr><th>골프장</th><th>현재 수수료율</th><th>변경</th><th>최근 변경</th><th>미완료 정산</th></tr></thead><tbody>${rows.map(row=>`<tr><td><b>${esc(row.courseName)}</b><small class="demo-cell">${esc(row.courseId)}</small></td><td>${rateText(row.ratePercent)} ${row.source==='default'?'<small class="demo-cell">기본값</small>':'<small class="demo-cell">설정값</small>'}</td><td><input id="rate-${esc(row.courseId)}" class="rate-input" type="number" min="0" max="30" step="0.5" value="${Number(row.ratePercent)}" style="width:90px"> <button class="secondary" data-rate-save="${esc(row.courseId)}" data-rate-version="${Number(row.version)||0}">저장</button></td><td>${esc(String(row.updatedAt||'-').slice(0,16).replace('T',' '))}<small class="demo-cell">${esc((row.updatedBy&&row.updatedBy.email)||'')}</small></td><td>${Number(row.openSettlements)||0}건</td></tr>`).join('')||'<tr><td colspan="5" class="empty">제휴 승인된 골프장이 없습니다.</td></tr>'}</tbody></table></div>`;
}
function bindSettlementActions(){
  document.querySelectorAll('[data-rate-save]').forEach(button=>button.onclick=async()=>{
    const courseId=button.dataset.rateSave,field=document.querySelector(`#rate-${courseId}`);
    const ratePercent=field?field.value:'';
    button.disabled=true;
    const response=await apiClient.request(`/api/admin/commissions/${encodeURIComponent(courseId)}`,{method:'PUT',token:adminToken(),body:{ratePercent,version:Number(button.dataset.rateVersion)}});
    button.disabled=false;
    if(!response.ok){alert((response.error&&response.error.message)||'수수료율을 저장하지 못했습니다.');handleAdminError(response);return}
    alert(`${response.data.commission.courseId} 수수료율이 ${rateText(response.data.commission.ratePercent)}로 저장되었습니다. (시연)`);
    adminSettlements=null;adminCommissionRows=null;render();
  });
  document.querySelectorAll('[data-settlement-next]').forEach(button=>button.onclick=async()=>{
    const next=button.dataset.settlementNext,id=button.dataset.settlementId;
    if(!confirm(`정산서를 ${settlementStatusLabel(next)} 상태로 변경할까요? (시연)`))return;
    button.disabled=true;
    const response=await apiClient.request(`/api/admin/settlements/${encodeURIComponent(id)}/transition`,{method:'POST',token:adminToken(),body:{status:next,version:Number(button.dataset.settlementVersion)}});
    button.disabled=false;
    if(!response.ok){alert((response.error&&response.error.message)||'상태를 변경하지 못했습니다.');handleAdminError(response);return}
    adminSettlements=null;render();
  });
}

async function createSettlementFromForm(){
  const courseId=val('settlement-course'),from=val('settlement-from'),to=val('settlement-to'),status=val('settlement-status');
  const button=document.querySelector('#create-settlement');
  if(!courseId){alert('골프장을 선택해주세요.');return}
  if(!from||!to){alert('정산 기간을 입력해주세요.');return}
  if(button)button.disabled=true;
  const response=await apiClient.request('/api/admin/settlements',{method:'POST',token:adminToken(),body:{courseId,from,to,status}});
  if(button)button.disabled=false;
  if(!response.ok){alert((response.error&&response.error.message)||'정산서를 만들지 못했습니다.');handleAdminError(response);return}
  const settlement=response.data.settlement;
  alert(`${settlement.number} 정산서를 만들었습니다.\n정산 기준액 ${money(settlement.basisAmount)} · 수수료 ${money(settlement.platformFee)} · 정산 예정 ${money(settlement.payoutAmount)} (시연)`);
  adminSettlements=null;render();
}

function auditLabel(action){
  return ({'application.created':'신청 접수','application.approved':'승인','application.rejected':'반려','admin.login':'본사 로그인','partner.login':'담당자 로그인','partner-account.created':'계정 생성','partner-account.updated':'계정 변경','partner-account.password-reset':'비밀번호 재설정','tee-time.created':'티타임 등록','tee-time.updated':'티타임 수정','tee-time.deleted':'티타임 삭제','tee-time.recurring':'티타임 반복 등록','rates.updated':'요금 수정','special-offer.created':'특가 등록','special-offer.updated':'특가 수정','special-offer.deleted':'특가 삭제','reservation.created':'예약 확정','reservation.cancelled':'예약 취소','reservation.status-updated':'예약 상태 변경','commission.updated':'수수료율 변경','settlement.created':'정산서 생성','settlement.pending':'정산 확인 대기','settlement.confirmed':'정산 확정','settlement.paid':'정산 지급 완료'})[action]||action;
}

function render(){
  if(!loginState()){app.innerHTML=login();bindLogin();return}
  if(isServerMode()&&loginState()!=='server'){localStorage.removeItem(AUTH);app.innerHTML=login();bindLogin();return}
  const views={dash,courses:courseDirectory,partners,applications,accounts:accountsPage,operations:operationsPage,analytics:analyticsPage,audit,tees,reservations,waitlist,refunds,members,settlements,banners,inquiries,settings,transfer:()=>window.ALL_GOLF_DEMO_TRANSFER.view(shell)};
  app.innerHTML=(views[page]||dash)();
  bind();
  window.ALL_GOLF_NATIONAL_DASHBOARD.bind(render);
  window.ALL_GOLF_DEMO_TRANSFER?.bind();
}
let booted=false;
async function boot(){
  if(apiClient){try{await apiClient.init()}catch{}}
  if(apiClient)apiClient.onModeChange(()=>{if(booted&&!loginState())render()});
  if(loginState()&&localStorage.getItem(AUTH)==='server'&&!adminToken())localStorage.removeItem(AUTH);
  if(isServerMode()&&loginState()==='server'){
    const response=await apiClient.request('/api/admin/session',{token:adminToken(),timeoutMs:6000});
    if(!response.ok){localStorage.removeItem(AUTH);apiClient.clearToken()}
  }
  booted=true;
  render();
}
function applicationRows(all){return `<div class="table-wrap"><table class="table application-table"><thead><tr><th>접수번호</th><th>신청일</th><th>구분</th><th>골프장</th><th>지역</th><th>담당자</th><th>연락처</th><th>상태</th><th>관리</th></tr></thead><tbody>${all.map(app=>`<tr><td><b>${esc(app.id)}</b></td><td>${esc(String(app.createdAt||'').slice(0,10))}</td><td>${esc(app.modeLabel||'')}</td><td>${esc(app.course?.name||'-')}<small class="demo-cell">${esc(app.courseId||app.newCourseId||'')}</small></td><td>${esc(app.course?.region||'')} ${esc(app.course?.city||'')}</td><td>${esc(app.manager?.name||'')}<small class="demo-cell">${esc(app.manager?.role||'-')}</small></td><td>${esc(app.manager?.phone||'')}<small class="demo-cell">${esc(app.manager?.email||'')}</small></td><td><span class="badge ${esc(app.status)}">${esc(app.statusLabel||app.status)}</span></td><td><button class="${app.status==='pending'?'primary':'secondary'}" data-application="${esc(app.id)}">${app.status==='pending'?'검토':'상세'}</button></td></tr>`).join('')||'<tr><td colspan="9" class="empty">접수된 제휴 신청이 없습니다.</td></tr>'}</tbody></table></div>`}
function applications(){
  const api=window.ALL_GOLF_PARTNER_STORE;
  if(isServerMode()){
    return shell('제휴 신청 관리',`<section class="panel"><div class="head"><div><h2>골프장 제휴 신청</h2><p class="admin-caption">서버 DB에 접수된 신청입니다. 승인·반려는 서버 인증으로 처리되며 처리 이력이 남습니다.</p></div><button class="secondary" id="refresh-applications">새로고침</button></div><div id="applications-root"><div class="notice">서버에서 불러오는 중…</div></div></section><section class="panel"><div class="head"><div><h2>최근 승인 처리 이력</h2><p class="admin-caption">서버 DB 기록 · 최근 20건</p></div><button class="secondary" data-page="audit">전체 보기</button></div><div id="audit-root"><div class="notice">불러오는 중…</div></div></section>`);
  }
  if(!api)return shell('제휴 신청 관리','<section class="panel"><div class="empty">제휴 신청 저장소를 불러오지 못했습니다. 페이지를 새로고침해주세요.</div></section>');
  const stats=api.stats(),all=api.list().filter(item=>applicationFilter==='all'||item.status===applicationFilter);
  return shell('제휴 신청 관리',`<section class="panel"><div class="head"><div><h2>골프장 제휴 신청 ${stats.total}건</h2><p class="admin-caption">partner/ 화면에서 접수된 신청입니다. 승인하면 사용자 앱에서 해당 골프장이 즉시 ‘제휴 예약 가능’ 상태로 전환됩니다.</p></div><button class="secondary" id="run-server-guide">서버로 전환</button></div><section class="national-kpis application-kpis">${[['전체 신청',stats.total],['검토 대기',stats.pending],['승인 완료',stats.approved],['반려',stats.rejected]].map(([label,value])=>`<article class="stat"><small>${label}</small><strong>${value}</strong></article>`).join('')}</section><div class="tabs application-tabs">${[['all','전체'],['pending','검토 대기'],['approved','승인'],['rejected','반려']].map(([id,label])=>`<button class="${applicationFilter===id?'active':''}" data-application-filter="${id}">${label}</button>`).join('')}</div>${all.length?applicationRows(all):'<div class="empty">조건에 맞는 제휴 신청이 없습니다.</div>'}<p class="notice">정적 시연 모드에서는 승인·반려 결과가 이 브라우저에만 저장됩니다. 서버를 실행하면 서버 DB·인증·처리 이력이 함께 동작합니다.</p></section>`)
}
function applicationsBody(){
  const stats=serverStats||{total:0,pending:0,approved:0,rejected:0};
  const all=serverApplications||[];
  return `<section class="national-kpis application-kpis">${[['전체 신청',stats.total],['검토 대기',stats.pending],['승인 완료',stats.approved],['반려',stats.rejected]].map(([label,value])=>`<article class="stat"><small>${label}</small><strong>${value}</strong></article>`).join('')}</section><div class="tabs application-tabs">${[['all','전체'],['pending','검토 대기'],['approved','승인'],['rejected','반려']].map(([id,label])=>`<button class="${applicationFilter===id?'active':''}" data-application-filter="${id}">${label}</button>`).join('')}</div>${all.length?applicationRows(all):'<div class="empty">조건에 맞는 제휴 신청이 없습니다.</div>'}<p class="notice">서버 DB 기준입니다. 승인하면 공개 제휴 골프장 목록에 반영되어 사용자 앱에서 예약할 수 있습니다.</p>`;
}
async function loadApplicationsServer(){
  const root=document.querySelector('#applications-root');
  if(!root||!isServerMode())return;
  root.innerHTML='<div class="notice">서버에서 불러오는 중…</div>';
  const query=applicationFilter==='all'?'':'?status='+encodeURIComponent(applicationFilter);
  const response=await apiClient.request('/api/admin/partner-applications'+query,{token:adminToken(),timeoutMs:8000});
  if(!response.ok){root.innerHTML=`<div class="form-error">${esc((response.error&&response.error.message)||'불러오지 못했습니다.')}</div>`;handleAdminError(response);return}
  serverApplications=response.data.applications||[];
  serverStats=response.data.stats||{total:0,pending:0,approved:0,rejected:0};
  root.innerHTML=applicationsBody();
  bindApplicationActions();
}
function auditRows(logs){
  return `<div class="table-wrap"><table class="table"><thead><tr><th>일시</th><th>처리</th><th>접수번호</th><th>골프장</th><th>처리자</th><th>사유·메모</th></tr></thead><tbody>${(logs||[]).map(log=>`<tr><td>${esc(String(log.at||'').slice(0,16).replace('T',' '))}</td><td><span class="badge ${log.action==='application.rejected'?'warn':log.action==='application.approved'?'':'pending'}">${esc(auditLabel(log.action))}</span></td><td>${esc(log.applicationId||'-')}</td><td>${esc(log.courseName||'-')}</td><td>${esc((log.actor&&log.actor.email)||'-')}<small class="demo-cell">${esc((log.actor&&log.actor.type)||'')}</small></td><td>${esc(log.reason||log.memo||'-')}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">처리 이력이 없습니다.</td></tr>'}</tbody></table></div>`;
}
async function loadAuditServer(rootId='audit-root',limit=20){
  const root=document.querySelector('#'+rootId);
  if(!root||!isServerMode())return;
  root.innerHTML='<div class="notice">불러오는 중…</div>';
  const response=await apiClient.request('/api/admin/audit-logs?limit='+limit,{token:adminToken(),timeoutMs:8000});
  if(!response.ok){root.innerHTML=`<div class="form-error">${esc((response.error&&response.error.message)||'불러오지 못했습니다.')}</div>`;handleAdminError(response);return}
  root.innerHTML=auditRows(response.data.logs||[]);
}
function audit(){
  if(!isServerMode()){
    return shell('승인 처리 이력','<section class="panel"><div class="empty">정적 시연 모드에서는 서버 처리 이력이 없습니다. <code>npm start</code> 로 서버를 실행하면 승인·반려 기록이 남습니다.</div></section>');
  }
  return shell('승인 처리 이력',`<section class="panel"><div class="head"><div><h2>제휴 신청 처리 이력</h2><p class="admin-caption">서버 DB에 기록된 접수·승인·반려 이력입니다.</p></div><button class="secondary" id="refresh-audit">새로고침</button></div><div id="audit-root"><div class="notice">불러오는 중…</div></div></section>`);
}
function handleAdminError(response){
  if(!response||!response.status)return;
  if(response.status===401||response.status===403){
    localStorage.removeItem(AUTH);apiClient&&apiClient.clearToken();
    alert('로그인이 만료되었습니다. 다시 로그인해주세요.');
    render();
  }
}
function applicationDetailRows(app){
  const c=app.course||{},m=app.manager||{},cond=app.conditions||{},amount=value=>value==null||value===''?'미입력':money(value),interval=cond.teeInterval==null?'미입력':`${Number(cond.teeInterval)}분`;
  return `<dl class="application-detail"><div><dt>접수번호</dt><dd>${esc(app.id)}</dd></div><div><dt>신청일시</dt><dd>${esc(String(app.createdAt||'').slice(0,16).replace('T',' '))}</dd></div><div><dt>신청 구분</dt><dd>${esc(app.modeLabel||app.courseMode)}</dd></div><div><dt>골프장</dt><dd>${esc(c.name||'-')}</dd></div><div><dt>지역</dt><dd>${esc(c.region||'-')} ${esc(c.city||'')}</dd></div><div><dt>주소</dt><dd>${esc(c.address||'미입력')}</dd></div><div><dt>운영형태</dt><dd>${c.operationType==='membership'?'회원제':c.operationType==='mixed'?'혼합형':c.operationType==='public'?'대중제':'미확인'}</dd></div><div><dt>홀 수</dt><dd>${c.holes?esc(c.holes)+'홀':'미입력'}</dd></div><div><dt>대표 전화</dt><dd>${esc(c.phone||'미입력')}</dd></div><div><dt>공식 홈페이지</dt><dd>${esc(c.website||'미입력')}</dd></div><div><dt>담당자</dt><dd>${esc(m.name||'-')} ${m.role?`<small>${esc(m.role)}</small>`:''}</dd></div><div><dt>담당자 연락처</dt><dd>${esc(m.phone||'-')}<br><small>${esc(m.email||'-')}</small></dd></div><div><dt>평일/주말 그린피</dt><dd>${amount(cond.weekdayGreenFee)} / ${amount(cond.weekendGreenFee)}</dd></div><div><dt>카트비/캐디피</dt><dd>${amount(cond.cartFee)} / ${amount(cond.caddieFee)}</dd></div><div><dt>티오프 간격</dt><dd>${interval}</dd></div><div class="full"><dt>운영 조건·메모</dt><dd>${esc(cond.memo||'미입력')}</dd></div></dl>`
}
function applicationModal(id){
  if(isServerMode()){return applicationModalServer(id)}
  const api=window.ALL_GOLF_PARTNER_STORE,app=api?.get(id);if(!app)return;
  const decision=app.decision||{};
  modal.innerHTML=`<div class="modal-bg"><section class="modal application-modal"><h2>제휴 신청 상세</h2><p>${esc(app.course?.name||'')} · ${esc(app.statusLabel||app.status)}</p>${applicationDetailRows(app)}${app.status==='pending'?`<div class="decision-box"><h3>검토 처리</h3><label class="field">승인 메모 (선택)<input id="decision-memo" placeholder="승인 시 내부 메모"></label><label class="field">반려 사유 (반려 시 필수)<textarea id="decision-reason" rows="3" placeholder="예: 사업자 정보 확인 불가"></textarea></label><p class="notice">승인하면 이 골프장이 사용자 앱에서 제휴 예약 가능 상태로 전환되고, 골프장 관리자 화면의 골프장 목록에도 추가됩니다.</p><div class="actions"><button class="secondary" data-application-reject>반려</button><button class="primary" data-application-approve>승인</button></div></div>`:`<div class="decision-result"><b>처리 결과 · ${esc(app.statusLabel||app.status)}</b><p>${esc(String(decision.at||'').slice(0,16).replace('T',' '))} · ${esc(decision.by||'본사 관리자')}${decision.reason?`<br>반려 사유: ${esc(decision.reason)}`:''}${decision.memo&&!decision.reason?`<br>메모: ${esc(decision.memo)}`:''}</p></div>`}<div class="modal-actions"><button class="secondary" data-close>닫기</button></div></section></div>`;
  document.querySelector('[data-close]').onclick=close;
  document.querySelector('[data-application-approve]')?.addEventListener('click',()=>{if(!confirm('이 신청을 승인할까요?\n승인하면 사용자 앱에서 제휴 예약 가능 골프장으로 전환됩니다.'))return;const result=api.approve(id,{memo:val('decision-memo')});if(!result.ok)return alert(result.message);close();alert('승인되었습니다. 사용자 앱을 새로고침하면 반영됩니다.');render()});
  document.querySelector('[data-application-reject]')?.addEventListener('click',()=>{const reason=val('decision-reason');if(!reason.trim())return alert('반려 사유를 입력해주세요.');if(!confirm('이 신청을 반려할까요?'))return;const result=api.reject(id,{reason});if(!result.ok)return alert(result.message);close();render()});
}

/* 서버 모드: 신청 상세를 서버에서 읽고, 승인·반려를 서버 세션으로 요청한다. */
async function applicationModalServer(id){
  modal.innerHTML='<div class="modal-bg"><section class="modal application-modal"><h2>제휴 신청 상세</h2><p class="notice">서버에서 불러오는 중…</p></section></div>';
  const response=await apiClient.request('/api/admin/partner-applications/'+encodeURIComponent(id),{token:adminToken(),timeoutMs:8000});
  if(!response.ok){close();handleAdminError(response);if(response.status!==401&&response.status!==403)alert((response.error&&response.error.message)||'신청을 불러오지 못했습니다.');return}
  const app=response.data.application,decision=app.decision||{};
  const deciding=app.status==='pending';
  modal.innerHTML=`<div class="modal-bg"><section class="modal application-modal"><h2>제휴 신청 상세</h2><p>${esc(app.course?.name||'')} · ${esc(app.statusLabel||app.status)}</p>${applicationDetailRows(app)}${deciding?`<div class="decision-box"><h3>검토 처리</h3><label class="field">승인 메모 (선택)<input id="decision-memo" placeholder="승인 시 내부 메모"></label><label class="field">반려 사유 (반려 시 필수)<textarea id="decision-reason" rows="3" placeholder="예: 사업자 정보 확인 불가"></textarea></label><p class="notice">승인하면 서버 DB의 공개 제휴 골프장 목록에 반영되어 사용자 앱에서 예약할 수 있습니다. 처리 결과는 이력에 남습니다.</p><div class="actions"><button class="secondary" data-application-reject>반려</button><button class="primary" data-application-approve>승인</button></div></div>`:`<div class="decision-result"><b>처리 결과 · ${esc(app.statusLabel||app.status)}</b><p>${esc(String(decision.at||'').slice(0,16).replace('T',' '))} · ${esc(decision.by||'본사 관리자')}${decision.reason?`<br>반려 사유: ${esc(decision.reason)}`:''}${decision.memo&&!decision.reason?`<br>메모: ${esc(decision.memo)}`:''}</p></div>`}<div class="modal-actions"><button class="secondary" data-close>닫기</button></div></section></div>`;
  document.querySelector('[data-close]').onclick=close;
  const decide=async(action)=>{
    const memo=val('decision-memo')||'',reason=val('decision-reason')||'';
    if(action==='reject'&&!reason.trim())return alert('반려 사유를 입력해주세요.');
    if(!confirm(action==='approve'?'이 신청을 승인할까요?\n승인하면 사용자 앱에서 제휴 예약 가능 골프장으로 전환됩니다.':'이 신청을 반려할까요?'))return;
    const approveButton=document.querySelector('[data-application-approve]'),rejectButton=document.querySelector('[data-application-reject]');
    if(approveButton)approveButton.disabled=true;if(rejectButton)rejectButton.disabled=true;
    const result=await apiClient.request(`/api/admin/partner-applications/${encodeURIComponent(id)}/${action}`,{method:'POST',body:action==='approve'?{memo}:{reason},token:adminToken(),timeoutMs:10000});
    if(approveButton)approveButton.disabled=false;if(rejectButton)rejectButton.disabled=false;
    if(!result.ok){
      if(result.status===409){alert('다른 관리자가 먼저 처리했습니다. 목록을 새로고침합니다.');close();render();return}
      handleAdminError(result);
      if(result.status!==401&&result.status!==403)alert((result.error&&result.error.message)||'처리하지 못했습니다.');
      return;
    }
    close();render();
    alert(action==='approve'?'승인되었습니다. 사용자 앱과 골프장 관리자 화면에 반영됩니다.':'반려되었습니다.');
  };
  document.querySelector('[data-application-approve]')?.addEventListener('click',()=>decide('approve'));
  document.querySelector('[data-application-reject]')?.addEventListener('click',()=>decide('reject'));
}

seed();boot();
