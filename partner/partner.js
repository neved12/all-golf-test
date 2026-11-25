const app=document.querySelector('#partner-app'),modal=document.querySelector('#modal');
const store=window.ALL_GOLF_STORE,partnerApi=window.ALL_GOLF_PARTNER_STORE,demos=window.ALL_GOLF_DEMO_COURSES||{};
const SESSION='allGolfPartnerSessionV1',COURSE_KEY='allGolfPartnerCourseId',RECEIPT_KEY='allGolfPartnerReceiptsV1';
const apiClient=window.ALL_GOLF_API||null,partnerSync=window.ALL_GOLF_PARTNER_SYNC||null;
/* 6단계: 서버가 연결되어 있으면 서버 DB, 아니면 이 브라우저의 정적 시연 저장소를 쓴다. */
const isServerMode=()=>Boolean(apiClient&&apiClient.state.mode==='server');
const modeChip=()=>`<span class="mode-chip ${isServerMode()?'server':'static'}">${isServerMode()?'서버 연동':'정적 시연'}</span>`;
const modeNote=()=>isServerMode()?'서버 DB와 연결되어 있습니다. 접수·승인 결과가 모든 화면에 공유됩니다.':'정적 시연 모드입니다. 접수 내용은 이 브라우저에만 저장되며 서버로 전송되지 않습니다.';
const readReceipts=()=>{try{const list=JSON.parse(localStorage.getItem(RECEIPT_KEY)||'[]');return Array.isArray(list)?list:[]}catch{return[]}};
const rememberReceipt=(application,lookupCode)=>{try{const list=readReceipts().filter(item=>item.id!==application.id);list.unshift({id:application.id,code:lookupCode||'',courseName:application.course&&application.course.name||'',status:application.status,at:new Date().toISOString()});localStorage.setItem(RECEIPT_KEY,JSON.stringify(list.slice(0,8)))}catch{}};
const hashParts=()=>String(location.hash||'').replace(/^#/,'').split(':');
const hashView=()=>hashParts()[0]||'';
const hashCourse=()=>hashParts()[1]||'';
/* 제휴 승인된 골프장만 운영 화면에 노출한다. 승인된 신규 골프장은 신청 데이터에서 만든다. */
const partnerCourses=()=>{
  const extra=partnerApi?partnerApi.approvedCourses().map(entry=>entry.course):[];
  const base=(window.ALL_GOLF_COURSES||[]).filter(course=>partnerApi?partnerApi.isPartnerCourse(course.id):Boolean(demos[course.id]));
  return [...base,...extra];
};
let courses=partnerCourses();
let lastReceipt=null,lastLookupCode='';
const todayISO=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
const VIEWS=['dashboard','tees','bookings','rates','course','deals','apply','status'];
let view=VIEWS.includes(hashView())?hashView():'dashboard',applyCourse=hashCourse(),selectedDate=todayISO(),bookingTab='all',teeTab='all',dealTab='all',dealQuery='',dealDate='';
const money=n=>n==null?'미설정':Number(n).toLocaleString('ko-KR')+'원';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const currentId=()=>isServerMode()&&serverSession&&serverSession.account?String(serverSession.account.courseId):(localStorage.getItem(COURSE_KEY)||'cn-gcz-cheonan');
const currentCourse=()=>courses.find(c=>c.id===currentId())||courses[0];
const isApprovedNewCourse=courseId=>Boolean(partnerApi&&partnerApi.approvedCourses().some(entry=>entry.course.id===courseId));
const fallbackTimes=(courseId,date=selectedDate)=>{
  const source=isApprovedNewCourse(courseId)&&partnerApi?partnerApi.demoTimesFor(courseId,date):(window.ALL_GOLF_DEMO_FOR_DATE?window.ALL_GOLF_DEMO_FOR_DATE(courseId,date):(demos[courseId]?.demoTeeTimes||[]));
  return source.map(t=>({...t,regular:t.price,maxPlayers:4,closed:false,instant:true}));
};
const times=()=>store.getTeeTimes(currentId(),selectedDate,fallbackTimes(currentId(),selectedDate));
const canonicalStatus=status=>status==='canceled'||status==='cancel_requested'?'cancelled':status||'confirmed';
const reservations=()=>store.getReservations().filter(r=>r.courseId===currentId()).map(r=>({...r,status:canonicalStatus(r.status)}));
const statusLabel=status=>canonicalStatus(status)==='cancelled'?'취소완료':status==='no_show'?'노쇼':status==='completed'?'이용 완료':'예약완료';
const operationLabel=value=>value==='public'?'대중제':value==='membership'?'회원제':value==='mixed'?'혼합형':'확인 필요';
const sessionLabel=time=>+time.slice(0,2)<10?'1부':+time.slice(0,2)<14?'2부':'3부';
const specialStatus=(offer)=>{const tee=store.getTeeTimes(offer.courseId,offer.roundDate,fallbackTimes(offer.courseId,offer.roundDate)).find(item=>item.id===offer.teeTimeId),sold=reservations().filter(item=>item.specialOfferId===offer.id&&item.status!=='cancelled').length;if(offer.status==='active'&&(!tee||tee.closed||tee.remaining<1||sold>=offer.teamLimit))return 'soldout';return offer.status};
const specialStatusLabel=status=>({scheduled:'예정',active:'진행 중',ended:'종료',paused:'중지',soldout:'매진',deleted:'삭제'})[status]||status;
const localDateTime=(date,time='00:00')=>`${date}T${time}`;
const csvCell=value=>{let text=String(value??'');if(/^[=+\-@]/.test(text))text=`'${text}`;return `"${text.replaceAll('"','""')}"`};
const downloadCsv=(filename,rows)=>{const content='\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'),blob=new Blob([content],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};

function login(){
  return `<div class="login"><section class="login-card"><div class="brand"><b>●</b> ALL:GOLF</div><span class="demo-account">시연용 관리자 계정</span>${modeChip()}<h1>골프장 관리자</h1><p>관리할 골프장을 선택하세요. 제휴 승인된 골프장만 목록에 표시되며, 선택한 골프장의 티타임과 예약만 보입니다.</p><label class="field">골프장<select id="login-course">${courses.map(c=>`<option value="${c.id}" ${c.id===currentId()?'selected':''}>${c.name} · ${c.region} ${c.city}</option>`).join('')||'<option value="">제휴 승인된 골프장이 없습니다</option>'}</select></label><button class="primary" id="enter-partner">관리자 화면 시작</button><div class="login-links"><button class="link-btn" id="go-apply">골프장 제휴 신청</button><button class="link-btn" id="go-status">접수 상태 조회</button></div><div class="hint">${modeNote()}</div></section></div>`;
}
function bindLogin(){
  document.querySelector('#enter-partner').onclick=()=>{const selected=val('login-course');if(!selected)return alert('관리할 골프장이 없습니다. 먼저 제휴 신청 후 본사 승인을 받아주세요.');localStorage.setItem(COURSE_KEY,selected);localStorage.setItem(SESSION,'demo');render()};
  document.querySelector('#go-apply').onclick=()=>{location.hash='apply';view='apply';render()};
  document.querySelector('#go-status').onclick=()=>{location.hash='status';view='status';render()};
}
function menu(){
  return [['dashboard','운영 현황'],['tees','티타임 관리'],['bookings','예약 관리'],['rates','요금·취소 정책'],['course','골프장 정보'],['deals','특가 관리'],['apply','제휴 신청'],['status','접수 상태']];
}
function shell(content,title){
  const c=currentCourse();
  return `<div class="shell"><aside class="sidebar"><div class="brand"><b>●</b> ALL:GOLF</div><small>골프장 운영 시스템</small>${menu().map(([id,label])=>`<a href="#${id}" class="side-btn ${view===id?'active':''}" data-view="${id}">${label}</a>`).join('')}<button class="side-btn logout" id="logout">관리자 선택으로</button></aside><main class="main"><div class="top"><div><h1>${title}</h1><p>${c.name} · 시연용 운영 시스템</p></div><label class="course-switch">관리 골프장<select id="course-switch">${courses.map(item=>`<option value="${item.id}" ${item.id===c.id?'selected':''}>${item.name}</option>`).join('')}</select></label></div>${content}</main></div>`;
}
function dashboard(){
  const teeTimes=times(),all=reservations(),todayBookings=all.filter(r=>r.dateISO===selectedDate&&r.status==='confirmed');
  const bookedPeople=time=>todayBookings.filter(r=>r.time===time).reduce((sum,r)=>sum+Number(r.people||0),0);
  const cards=[['예약 완료',todayBookings.length+'건'],['예약 가능한 티타임',teeTimes.filter(t=>!t.closed&&t.remaining>0).length+'개'],['취소',all.filter(r=>r.dateISO===selectedDate&&r.status==='cancelled').length+'건']];
  return shell(`<section class="dashboard-date"><label>운영 날짜 <input class="date-picker" type="date" value="${selectedDate}" data-date-change></label><span>초기 운영에 필요한 예약·티타임만 간단히 표시합니다.</span></section><section class="stats simple-stats">${cards.map(([label,value])=>`<article class="stat"><small>${label}</small><strong>${value}</strong></article>`).join('')}</section><section class="panel"><div class="panel-head"><h2>오늘의 티타임 현황</h2><div class="btn-row"><button class="secondary" data-view="bookings">예약 관리</button><button class="secondary" data-view="tees">티타임 관리</button></div></div><div class="table-wrap"><table class="table"><thead><tr><th>시간</th><th>부</th><th>그린피</th><th>예약인원</th><th>상태</th><th>관리</th></tr></thead><tbody>${teeTimes.map(t=>`<tr><td><b>${t.time}</b></td><td>${t.session||sessionLabel(t.time)}</td><td>${money(t.price)}<small class="demo-cell">시연용</small></td><td>${bookedPeople(t.time)}/${t.maxPlayers}</td><td><span class="badge ${t.closed?'closed':''}">${t.closed?'마감':'예약 가능'}</span></td><td><button class="secondary" data-edit-tee="${t.id}">상세/수정</button></td></tr>`).join('')}</tbody></table></div></section>`,'운영 현황');
}
function teePage(){
  let items=times().filter(t=>teeTab==='open'?!t.closed:teeTab==='closed'?t.closed:true);
  return shell(`<section class="panel"><div class="panel-head"><div><h2>티타임 관리</h2><p>같은 courseId·날짜·시간 데이터가 현재 브라우저 환경의 사용자 앱에 즉시 반영됩니다. 서버·다른 사용자에게는 전달되지 않는 시연 동작입니다.</p></div><div class="btn-row"><input class="date-picker" type="date" value="${selectedDate}" data-date-change><button class="secondary" id="export-tees">엑셀용 CSV</button><button class="secondary" id="recurring-tee">날짜 반복 등록</button><button class="primary" id="new-tee">+ 티타임 추가</button></div></div><div class="tabs">${[['all','전체'],['open','예약 가능'],['closed','마감']].map(([id,label])=>`<button class="${teeTab===id?'active':''}" data-tee-tab="${id}">${label}</button>`).join('')}</div>${teeTable(items)}</section>`,'티타임 관리');
}
function teeTable(items){
  return `<div class="table-wrap"><table class="table"><thead><tr><th>시간</th><th>부</th><th>시연 그린피</th><th>최대 인원</th><th>잔여 팀</th><th>특가</th><th>상태</th><th>관리</th></tr></thead><tbody>${items.map(t=>`<tr><td><b>${t.time}</b></td><td>${t.session}</td><td>${money(t.price)}<small class="demo-cell">실제 판매가 아님</small></td><td>${t.maxPlayers}명</td><td>${t.remaining}팀</td><td>${t.special?'특가':'-'}</td><td><span class="badge ${t.closed?'closed':''}">${t.closed?'마감':'예약 가능'}</span></td><td><button class="secondary" data-edit-tee="${t.id}">수정</button> <button class="${t.closed?'success':'danger'}" data-toggle-tee="${t.id}">${t.closed?'예약 가능':'마감'}</button> <button class="danger" data-delete-tee="${t.id}">삭제</button></td></tr>`).join('')||'<tr><td colspan="8" class="empty">등록된 티타임이 없습니다.</td></tr>'}</tbody></table></div>`;
}
function bookingsPage(){
  const items=reservations().filter(r=>bookingTab==='all'||r.status===bookingTab);
  return shell(`<section class="panel"><div class="panel-head"><div><h2>예약 관리</h2><p>사용자 앱에서 만든 AG 예약번호가 그대로 표시됩니다.</p></div><button class="secondary" id="export-bookings">엑셀용 CSV</button></div><div class="tabs">${[['all','전체'],['confirmed','예약완료'],['cancelled','취소'],['no_show','노쇼']].map(([id,label])=>`<button class="${bookingTab===id?'active':''}" data-booking-tab="${id}">${label}</button>`).join('')}</div>${bookingTable(items)}</section>`,'예약 관리');
}
function bookingTable(items){
  return `<div class="table-wrap"><table class="table"><thead><tr><th>예약번호</th><th>예약일</th><th>라운드 날짜</th><th>티타임</th><th>예약자</th><th>휴대전화</th><th>인원</th><th>예약금</th><th>상태</th></tr></thead><tbody>${items.map(r=>`<tr data-booking="${r.number||r.id}"><td><b>${r.number}</b></td><td>${(r.createdAt||'').slice(0,10)||'-'}</td><td>${r.dateISO||r.date||'-'}</td><td>${r.time}</td><td>${r.booker||'-'}</td><td>${r.phone||'-'}</td><td>${r.people}명</td><td>${money(r.paidDeposit??r.online??r.deposit)}</td><td><span class="badge ${r.status==='cancelled'?'cancel':''}">${statusLabel(r.status)}</span></td></tr>`).join('')||'<tr><td colspan="9" class="empty">해당 골프장의 예약이 없습니다.</td></tr>'}</tbody></table></div>`;
}
function ratesPage(){
  const r=store.getRates(currentId());
  const p={...store.DEFAULT_CANCELLATION_POLICY,...r.cancellationPolicy};
  return shell(`<section class="panel"><div class="panel-head"><div><h2>요금·취소 정책</h2><p>평일·주말과 예약 인원에 따라 사용자 계산 금액이 달라집니다.</p></div><button class="primary" id="save-rates">저장</button></div><div class="notice">현재 입력값은 시연용 가격 및 정책이며 실제 판매·환불 조건이 아닙니다.</div><div class="form-grid"><label class="field">평일 1인 그린피<input id="rate-weekday" type="number" min="0" value="${r.weekdayGreenFee??''}" placeholder="미설정 시 티타임 가격 사용"></label><label class="field">주말 1인 그린피<input id="rate-weekend" type="number" min="0" value="${r.weekendGreenFee??''}" placeholder="미설정 시 티타임 가격 사용"></label><label class="field">3인 플레이 1인당 추가금<input id="rate-three-surcharge" type="number" min="0" value="${r.threePlayerSurcharge??0}"></label><label class="field">2인 플레이 1인당 추가금<input id="rate-two-surcharge" type="number" min="0" value="${r.twoPlayerSurcharge??0}"></label><label class="field">카트비 / 팀<input id="rate-cart" type="number" min="0" value="${r.cartFee??''}" placeholder="미설정"></label><label class="field">캐디피 / 팀<input id="rate-caddie" type="number" min="0" value="${r.caddieFee??''}" placeholder="미설정"></label></div><h3 class="subhead">예약금 설정</h3><div class="form-grid"><label class="field">예약금 방식<select id="deposit-type"><option value="none" ${r.depositType==='none'?'selected':''}>예약금 없음</option><option value="team" ${r.depositType==='team'?'selected':''}>팀당 고정 예약금</option><option value="person" ${!r.depositType||r.depositType==='person'?'selected':''}>1인당 예약금</option><option value="percent" ${r.depositType==='percent'?'selected':''}>총 이용금액의 %</option></select></label><label class="field">금액 또는 비율<input id="deposit-value" type="number" min="0" value="${r.depositValue??''}" placeholder="예: 30000 또는 20"></label></div><h3 class="subhead">시연용 취소/환불 정책</h3><div class="notice">라운드일까지 남은 날짜를 기준으로 예약금 환불률을 계산합니다. 예약 완료 시 정책을 스냅샷으로 보존합니다.</div><div class="form-grid policy-grid"><label class="field">취소 가능 기한 · 티오프 몇 시간 전<input id="policy-cutoff" type="number" min="0" max="720" value="${p.cutoffHoursBefore??''}" placeholder="비워두면 기한 제한 없음"></label><label class="field">7일 전까지 환불률 %<input id="policy-seven" type="number" min="0" max="100" value="${p.sevenPlus}"></label><label class="field">4~6일 전 환불률 %<input id="policy-six" type="number" min="0" max="100" value="${p.fourToSix}"></label><label class="field">2~3일 전 환불률 %<input id="policy-three" type="number" min="0" max="100" value="${p.twoToThree}"></label><label class="field">1일 전 환불률 %<input id="policy-one" type="number" min="0" max="100" value="${p.oneDay}"></label><label class="field">당일 환불률 %<input id="policy-today" type="number" min="0" max="100" value="${p.sameDay}"></label></div></section>`,'요금·취소 정책');
}
function coursePage(){
  const c=currentCourse(),o=store.getCourseOverride(c.id);
  return shell(`<section class="panel"><div class="panel-head"><div><h2>골프장 정보</h2><p>마스터 원본은 읽기 전용이며 운영정보만 별도로 저장됩니다.</p></div><button class="primary" id="save-course">운영정보 저장</button></div><div class="master-box"><h3>ALL:GOLF 마스터 데이터</h3><dl><div><dt>골프장명</dt><dd>${c.name}</dd></div><div><dt>지역</dt><dd>${c.region} · ${c.city}</dd></div><div><dt>주소</dt><dd>${c.address||'확인 필요'}</dd></div><div><dt>운영형태</dt><dd>${operationLabel(c.operationType)}</dd></div><div><dt>홀 수</dt><dd>${c.holes?c.holes+'홀':'확인 필요'}</dd></div><div><dt>코스</dt><dd>${c.courses?.join(', ')||'확인 중'}</dd></div><div><dt>공식 홈페이지</dt><dd>${c.officialWebsite||'확인 필요'}</dd></div></dl></div><h3 class="subhead">관리자 운영정보</h3><div class="form-grid"><label class="field">대표 전화<input id="course-phone" value="${o.phone||''}"></label><label class="field">운영 시간<input id="course-hours" value="${o.hours||''}"></label><label class="field full">운영 안내<textarea id="course-guide" rows="4">${o.guide||''}</textarea></label><label class="field full">시설 정보<textarea id="course-amenities" rows="3">${o.amenities||''}</textarea></label></div></section>`,'골프장 정보');
}
function dealsPage(){
  const all=store.getSpecialOffers(currentId()),bookings=reservations().filter(item=>item.specialOfferId||Number(item.discountAmount)>0),cancelled=bookings.filter(item=>item.status==='cancelled');
  let items=all.map(item=>({...item,displayStatus:specialStatus(item)})).filter(item=>(dealTab==='all'||item.displayStatus===dealTab)&&(!dealDate||item.roundDate===dealDate)&&(!dealQuery||`${item.name} ${item.time} ${item.roundDate}`.toLowerCase().includes(dealQuery.toLowerCase())));
  const cards=[['등록된 특가',all.length+'개'],['진행 중',all.filter(item=>specialStatus(item)==='active').length+'개'],['특가 예약',bookings.length+'건']];
  return shell(`<section class="notice">모든 특가·예약·금액은 기능 검증용 시연 데이터이며 실제 판매 또는 매출이 아닙니다.</section><section class="stats deal-stats">${cards.map(([label,value])=>`<article class="stat"><small>${label}</small><strong>${value}</strong></article>`).join('')}</section><section class="panel"><div class="panel-head"><div><h2>특가 목록</h2><p>현재 관리 중인 ${currentCourse().name}의 기존 티타임에만 특가를 연결합니다.</p></div><button class="primary" id="new-deal">+ 특가 등록</button></div><div class="deal-tools"><input id="deal-search" value="${dealQuery}" placeholder="특가명·날짜·시간 검색"><input id="deal-date-filter" type="date" value="${dealDate}"><button class="secondary" id="deal-reset">초기화</button></div><div class="tabs">${[['all','전체'],['scheduled','예정'],['active','진행 중'],['ended','종료'],['paused','중지'],['soldout','매진']].map(([id,label])=>`<button class="${dealTab===id?'active':''}" data-deal-tab="${id}">${label}</button>`).join('')}</div><div class="table-wrap"><table class="table deal-table"><thead><tr><th>특가명</th><th>라운딩</th><th>정상가</th><th>특가</th><th>할인</th><th>적용 팀</th><th>상태</th><th>관리</th></tr></thead><tbody>${items.map(offer=>`<tr><td><b>${offer.name}</b><small class="demo-cell">${currentCourse().name}</small></td><td>${offer.roundDate}<br>${offer.time}</td><td><s>${money(offer.regularPrice)}</s></td><td><b class="deal-amount">${money(offer.specialPrice)}</b></td><td>${money(offer.discountAmount)}<br><b>${offer.discountRate}%</b></td><td>${offer.teamLimit}팀</td><td><span class="badge ${offer.displayStatus}">${specialStatusLabel(offer.displayStatus)}</span></td><td><button class="secondary" data-edit-deal="${offer.id}">수정</button> <button class="${offer.paused?'success':'danger'}" data-toggle-deal="${offer.id}">${offer.paused?'재개':'중지'}</button> <button class="danger" data-delete-deal="${offer.id}">삭제</button></td></tr>`).join('')||'<tr><td colspan="8" class="empty">조건에 맞는 특가가 없습니다.</td></tr>'}</tbody></table></div></section>`,'특가 관리');
}
function placeholderPage(kind){
  const messages={weather:'향후 실시간 날씨 API 연동 예정입니다. 날씨는 가격을 자동 변경하지 않으며 최종 가격 결정 권한은 골프장 관리자에게 있습니다.',staff:'권한 관리 준비 중입니다. 최고 관리자·예약 관리자·가격 관리자·일반 직원 권한으로 확장할 예정입니다.'};
  return shell(`<section class="panel placeholder"><h2>${menu().find(x=>x[0]===kind)[1]}</h2><p>${messages[kind]}</p></section>`,menu().find(x=>x[0]===kind)[1]);
}
function teeModal(item){
  const t=item||{id:null,time:'',session:'1부',price:'',regular:'',maxPlayers:4,remaining:1,closed:false,special:false,instant:true};
  modal.innerHTML=`<div class="modal-bg"><section class="modal"><h2>${item?'티타임 수정':'티타임 추가'}</h2><p>${currentCourse().name} · ${selectedDate}</p><div class="form-grid"><label class="field">시간<input id="t-time" type="time" value="${t.time}"></label><label class="field">부<select id="t-session"><option ${t.session==='1부'?'selected':''}>1부</option><option ${t.session==='2부'?'selected':''}>2부</option><option ${t.session==='3부'?'selected':''}>3부</option></select></label><label class="field">시연 그린피<input id="t-price" type="number" min="0" value="${t.price}"></label><label class="field">정상가(시연)<input id="t-regular" type="number" min="0" value="${t.regular||t.price}"></label><label class="field">최대 인원<input id="t-max" type="number" min="2" max="4" value="${t.maxPlayers}"></label><label class="field">잔여 팀<input id="t-remaining" type="number" min="0" max="20" value="${t.remaining}"></label><label class="check"><input id="t-special" type="checkbox" ${t.special?'checked':''}> 특가 지정</label><label class="check"><input id="t-closed" type="checkbox" ${t.closed?'checked':''}> 예약 마감</label></div><div class="notice">시연용 가격 · 실제 판매가격 아님 · 잔여 팀은 0~20 범위만 저장됩니다.</div><div class="modal-actions"><button class="secondary" data-modal-close>닫기</button><button class="primary" id="save-tee">저장</button></div></section></div>`;
  document.querySelector('[data-modal-close]').onclick=closeModal;
  document.querySelector('#save-tee').onclick=()=>{const time=val('t-time'),price=Number(val('t-price')),regular=Number(val('t-regular')),maxPlayers=Number(val('t-max')),remaining=Number(val('t-remaining'));if(!time||!Number.isFinite(price)||price<0||!Number.isFinite(regular)||regular<0)return alert('시간과 0원 이상의 시연 그린피·정상가를 입력해주세요.');if(!Number.isInteger(maxPlayers)||maxPlayers<2||maxPlayers>4)return alert('최대 인원은 2~4명만 입력할 수 있습니다.');if(!Number.isInteger(remaining)||remaining<0||remaining>20)return alert('잔여 팀은 0~20팀만 입력할 수 있습니다.');const history=reservations().filter(r=>r.dateISO===selectedDate&&r.teeTimeId===t.id),active=history.filter(r=>r.status!=='cancelled');if(item&&history.length&&(time!==t.time||maxPlayers<Math.max(...history.map(r=>Number(r.people)||0))))return alert('예약 이력이 있는 티타임의 시간이나 예약 인원 조건을 변경할 수 없습니다.');if(item&&remaining+active.length>20)return alert('예약 수량의 합계가 20팀을 넘을 수 없습니다.');const duplicate=times().some(x=>x.time===time&&x.id!==t.id);if(duplicate)return alert('같은 날짜와 시간의 티타임이 이미 있습니다.');store.upsertTeeTime(currentId(),selectedDate,{...t,id:t.id||`${currentId()}::${selectedDate}::${time}`,time,session:val('t-session'),price,regular,maxPlayers,remaining,capacityTeams:Math.max(Number(t.capacityTeams||0),remaining+active.length),special:checked('t-special'),closed:checked('t-closed')});closeModal();render()};
}
function recurringModal(){
  const courseId=currentId();
  modal.innerHTML=`<div class="modal-bg"><section class="modal"><h2>날짜 반복 티타임 등록</h2><p>${currentCourse().name} · 기존 티타임과 예약 이력은 덮어쓰지 않습니다.</p><div class="form-grid"><label class="field">시작 날짜<input id="repeat-start" type="date" value="${selectedDate}"></label><label class="field">종료 날짜<input id="repeat-end" type="date" value="${selectedDate}"></label><label class="field">티오프 시간<input id="repeat-time" type="time" value="07:18"></label><label class="field">시연 1인 그린피<input id="repeat-price" type="number" min="0" value="150000"></label><label class="field">시연 정상가<input id="repeat-regular" type="number" min="0" value="150000"></label><label class="field">최대 인원<input id="repeat-max" type="number" min="2" max="4" value="4"></label><label class="field">판매 가능 팀<input id="repeat-teams" type="number" min="1" max="20" value="1"></label></div><fieldset class="repeat-days"><legend>반복 요일</legend>${['일','월','화','수','목','금','토'].map((label,index)=>`<label><input type="checkbox" name="repeat-weekday" value="${index}" checked> ${label}</label>`).join('')}</fieldset><p class="notice">최대 90일 · 시연용 가격 · 실제 판매가 아님</p><div id="repeat-preview" class="notice">미리보기를 눌러 등록·중복 건수를 확인하세요.</div><div class="modal-actions"><button class="secondary" data-modal-close>닫기</button><button class="secondary" id="preview-repeat">미리보기</button><button class="primary" id="confirm-repeat" disabled>확인 후 등록</button></div></section></div>`;
  const readInput=()=>({startDate:val('repeat-start'),endDate:val('repeat-end'),time:val('repeat-time'),price:Number(val('repeat-price')),regular:Number(val('repeat-regular')),maxPlayers:Number(val('repeat-max')),remaining:Number(val('repeat-teams')),weekdays:[...modal.querySelectorAll('[name="repeat-weekday"]:checked')].map(el=>Number(el.value))});
  const fallback=date=>fallbackTimes(courseId,date);
  let approved=null;
  modal.querySelectorAll('input').forEach(input=>input.addEventListener('input',()=>{approved=null;document.querySelector('#confirm-repeat').disabled=true;document.querySelector('#repeat-preview').textContent='조건이 변경되었습니다. 다시 미리보기를 눌러주세요.'}));
  document.querySelector('[data-modal-close]').onclick=closeModal;
  document.querySelector('#preview-repeat').onclick=()=>{const input=readInput(),result=store.recurringPlan(courseId,input,fallback);if(!result.ok){document.querySelector('#repeat-preview').textContent=result.message;return}approved=JSON.stringify(input);document.querySelector('#repeat-preview').textContent=`등록 예정 ${result.createCount}건 · 기존 티타임/예약 중복으로 건너뜀 ${result.skipCount}건 · 대상 날짜 ${result.plan.map(item=>item.date+(item.duplicate?'(중복)':'')).join(', ')||'없음'}`;document.querySelector('#confirm-repeat').disabled=result.createCount===0};
  document.querySelector('#confirm-repeat').onclick=()=>{const input=readInput();if(approved!==JSON.stringify(input))return alert('조건이 변경되었습니다. 미리보기를 다시 확인해주세요.');if(!confirm(`${currentCourse().name}에 반복 티타임을 등록할까요?`))return;const result=store.registerRecurringTeeTimes(courseId,input,fallback);if(!result.ok)return alert(result.message);alert(`${result.created}건 등록, ${result.skipped}건 중복 건너뜀`);closeModal();render()};
}
function dealModal(item=null){
  const roundDate=item?.roundDate||selectedDate,teeItems=store.getTeeTimes(currentId(),roundDate,fallbackTimes(currentId(),roundDate)),selectedTee=teeItems.find(tee=>tee.id===item?.teeTimeId)||teeItems.find(tee=>!tee.closed&&tee.remaining>0)||teeItems[0];
  const now=new Date(),nowInput=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const saleStart=item?.saleStartAt?.slice(0,16)||nowInput,saleEnd=item?.saleEndAt?.slice(0,16)||localDateTime(roundDate,'23:59'),courseList=currentCourse().courses||[];
  const teeOptions=(date,selected='')=>store.getTeeTimes(currentId(),date,fallbackTimes(currentId(),date)).map(tee=>`<option value="${tee.id}" ${tee.id===selected?'selected':''} ${tee.closed||tee.remaining<1?'disabled':''}>${tee.time} · ${money(tee.regular||tee.price)} · 잔여 ${tee.remaining}팀${tee.closed?' · 마감':''}</option>`).join('');
  modal.innerHTML=`<div class="modal-bg"><section class="modal deal-modal"><h2>${item?'특가 수정':'특가 등록'}</h2><p>기존 티타임에 연결되는 시연용 할인 정책입니다. 실제 판매가격이 아닙니다.</p><div class="form-grid"><label class="field">골프장<select id="d-course" disabled><option value="${currentId()}">${currentCourse().name}</option></select></label><label class="field">코스 선택<select id="d-course-name"><option value="">전체 코스</option>${courseList.map(name=>`<option ${name===item?.courseName?'selected':''}>${name}</option>`).join('')}</select></label><label class="field">라운딩 날짜<input id="d-date" type="date" value="${roundDate}"></label><label class="field">티오프 시간<select id="d-tee">${teeOptions(roundDate,item?.teeTimeId||selectedTee?.id)}</select></label><label class="field full">특가명<input id="d-name" maxlength="60" value="${item?.name||''}" placeholder="예: 평일 오전 한정 특가"></label><label class="field full">특가 설명<textarea id="d-description" rows="3" placeholder="사용자에게 안내할 특가 설명">${item?.description||''}</textarea></label><label class="field">정상 그린피<input id="d-regular" type="number" min="1" value="${item?.regularPrice??selectedTee?.regular??selectedTee?.price??''}"></label><label class="field">특가 그린피<input id="d-special" type="number" min="0" value="${item?.specialPrice??''}"></label><label class="field">할인 금액<input id="d-discount" value="${item?.discountAmount??''}" readonly></label><label class="field">할인율<input id="d-rate" value="${item?.discountRate!=null?item.discountRate+'%':''}" readonly></label><label class="field">특가 적용 가능 팀 수<input id="d-team-limit" type="number" min="1" value="${item?.teamLimit??Math.max(1,selectedTee?.remaining||1)}"></label><label class="field">판매 시작 일시<input id="d-start" type="datetime-local" value="${saleStart}"></label><label class="field">판매 종료 일시<input id="d-end" type="datetime-local" value="${saleEnd}"></label><label class="check"><input id="d-visible" type="checkbox" ${item?.visible===false?'':'checked'}> 사용자 화면 노출</label><label class="check"><input id="d-paused" type="checkbox" ${item?.paused?'checked':''}> 특가 판매 중지</label></div><div class="form-error" id="deal-error"></div><div class="modal-actions"><button class="secondary" data-modal-close>취소</button><button class="primary" id="save-deal">저장</button></div></section></div>`;
  const updateDiscount=()=>{const regular=Number(val('d-regular')),special=Number(val('d-special')),discount=regular-special,rate=regular>0?Math.round(discount*100/regular):0;document.querySelector('#d-discount').value=Number.isFinite(discount)&&discount>=0?money(discount):'';document.querySelector('#d-rate').value=Number.isFinite(rate)&&rate>=0?rate+'%':''};
  const syncTee=()=>{const tee=store.getTeeTimes(currentId(),val('d-date'),fallbackTimes(currentId(),val('d-date'))).find(entry=>entry.id===val('d-tee'));if(tee){document.querySelector('#d-regular').value=tee.regular||tee.price;document.querySelector('#d-team-limit').max=tee.remaining;updateDiscount()}};
  document.querySelector('[data-modal-close]').onclick=closeModal;document.querySelector('#d-regular').oninput=updateDiscount;document.querySelector('#d-special').oninput=updateDiscount;document.querySelector('#d-tee').onchange=syncTee;document.querySelector('#d-date').onchange=()=>{const select=document.querySelector('#d-tee');select.innerHTML=teeOptions(val('d-date'));syncTee()};updateDiscount();
  document.querySelector('#save-deal').onclick=()=>{const tee=store.getTeeTimes(currentId(),val('d-date'),fallbackTimes(currentId(),val('d-date'))).find(entry=>entry.id===val('d-tee'));const result=store.saveSpecialOffer({...(item||{}),id:item?.id,courseId:currentId(),courseName:val('d-course-name'),roundDate:val('d-date'),teeTimeId:tee?.id||'',time:tee?.time||'',name:val('d-name'),description:val('d-description'),regularPrice:Number(val('d-regular')),specialPrice:Number(val('d-special')),teamLimit:Number(val('d-team-limit')),saleStartAt:val('d-start'),saleEndAt:val('d-end'),visible:checked('d-visible'),paused:checked('d-paused')});if(!result.ok){document.querySelector('#deal-error').textContent=result.message;return}closeModal();render()};
}
function bookingModal(reference){
  const r=reservations().find(x=>x.number===reference||x.id===reference);if(!r)return;
  const total=Number(r.totalEstimated??Number(r.greenTotal||0)+Number(r.cart||0)+Number(r.caddie||0)),deposit=Number(r.paidDeposit??r.online??r.deposit??0),onsite=Number(r.onsite??Math.max(0,total-deposit));
  modal.innerHTML=`<div class="modal-bg"><section class="modal booking-detail"><h2>예약 상세</h2><dl><div><dt>예약번호</dt><dd>${r.number}</dd></div><div><dt>예약자</dt><dd>${r.booker||'-'} · ${r.phone||'-'}</dd></div><div><dt>예약 인원</dt><dd><b>${r.people}명 플레이</b></dd></div><div><dt>동반자</dt><dd>${r.companions?.length?r.companions.join(' · '):'입력 없음'}</dd></div><div><dt>골프장</dt><dd>${r.courseName||currentCourse().name}</dd></div><div><dt>라운드</dt><dd>${r.dateISO||r.date} ${r.time}</dd></div>${Number(r.playerSurcharge)>0?`<div><dt>인원별 추가금</dt><dd>${money(r.playerSurcharge)} / 1인</dd></div>`:''}${r.specialOfferId||Number(r.discountAmount)>0?`<div><dt>적용 특가</dt><dd><span class="badge active">${r.specialOfferName||'특가 예약'}</span><br>정상가 ${money(r.regularGreenFee)} → 적용가 ${money(r.appliedGreenFee)}<br>총 ${money(r.discountAmount)} 할인</dd></div>`:''}<div><dt>총 예상 이용금액</dt><dd>${money(total)}</dd></div><div><dt>예약금</dt><dd>${money(deposit)}</dd></div><div><dt>현장 결제 예정금액</dt><dd>${money(onsite)}</dd></div><div><dt>예약 상태</dt><dd><span class="badge ${r.status==='cancelled'?'cancel':''}">${statusLabel(r.status)}</span></dd></div>${r.status==='cancelled'?`<div><dt>취소 일시</dt><dd>${r.cancelledAt||'-'}</dd></div><div><dt>취소수수료</dt><dd>${money(r.cancellationFee||0)}</dd></div><div><dt>시연 환불 금액</dt><dd>${money(r.refundAmount||0)}</dd></div><div><dt>환불 상태</dt><dd>${r.refundStatus==='demo_refunded'?'시연 환불 완료':r.refundStatus||'확인 필요'}</dd></div>`:''}</dl><p>요청사항 ${r.request||'없음'}</p><div class="modal-actions"><button class="primary" data-modal-close>확인</button></div></section></div>`;document.querySelector('[data-modal-close]').onclick=closeModal;
}
const val=id=>document.querySelector('#'+id)?.value||'',checked=id=>Boolean(document.querySelector('#'+id)?.checked),closeModal=()=>modal.innerHTML='';
function bind(){
  document.querySelectorAll('[data-view]').forEach(el=>el.onclick=()=>{view=el.dataset.view;location.hash=view;render()});
  document.querySelector('#logout')?.addEventListener('click',()=>{localStorage.removeItem(SESSION);render()});
  document.querySelector('#course-switch')?.addEventListener('change',e=>{localStorage.setItem(COURSE_KEY,e.target.value);render()});
  document.querySelectorAll('[data-date-change]').forEach(el=>el.onchange=()=>{selectedDate=el.value;render()});
  document.querySelector('#new-tee')?.addEventListener('click',()=>teeModal());
  document.querySelector('#recurring-tee')?.addEventListener('click',recurringModal);
  document.querySelector('#export-tees')?.addEventListener('click',()=>downloadCsv(`${currentCourse().name}-${selectedDate}-티타임.csv`,[['골프장','날짜','시간','부','그린피','최대 인원','잔여 팀','상태'],...times().map(t=>[currentCourse().name,selectedDate,t.time,t.session,money(t.price),t.maxPlayers,t.remaining,t.closed?'마감':'예약 가능'])]));
  document.querySelectorAll('[data-edit-tee]').forEach(el=>el.onclick=()=>teeModal(times().find(t=>t.id===el.dataset.editTee)));
  document.querySelectorAll('[data-toggle-tee]').forEach(el=>el.onclick=()=>{const list=times(),item=list.find(t=>t.id===el.dataset.toggleTee);item.closed=!item.closed;store.setTeeTimes(currentId(),selectedDate,list);render()});
  document.querySelectorAll('[data-delete-tee]').forEach(el=>el.onclick=()=>{const item=times().find(t=>t.id===el.dataset.deleteTee);if(reservations().some(r=>r.dateISO===selectedDate&&r.time===item.time))return alert('예약 이력이 있는 티타임은 삭제할 수 없습니다. 마감 처리해주세요.');if(confirm('이 티타임을 삭제할까요?')){store.deleteTeeTime(currentId(),selectedDate,item.id);render()}});
  document.querySelectorAll('[data-tee-tab]').forEach(el=>el.onclick=()=>{teeTab=el.dataset.teeTab;render()});
  document.querySelectorAll('[data-booking-tab]').forEach(el=>el.onclick=()=>{bookingTab=el.dataset.bookingTab;render()});
  document.querySelector('#export-bookings')?.addEventListener('click',()=>downloadCsv(`${currentCourse().name}-예약-${todayISO()}.csv`,[['예약번호','예약일','라운드 날짜','티타임','예약자','휴대전화','인원','동반자','총 예상금액','예약금','상태'],...reservations().map(r=>[r.number,(r.createdAt||'').slice(0,10),r.dateISO||r.date,r.time,r.booker,r.phone,r.people,(r.companions||[]).join(' / '),r.totalEstimated,r.paidDeposit??r.online??r.deposit,statusLabel(r.status)])]));
  document.querySelectorAll('[data-booking]').forEach(el=>el.onclick=()=>bookingModal(el.dataset.booking));
  document.querySelector('#new-deal')?.addEventListener('click',()=>dealModal());
  document.querySelectorAll('[data-edit-deal]').forEach(el=>el.onclick=()=>dealModal(store.getSpecialOffer(el.dataset.editDeal)));
  document.querySelectorAll('[data-toggle-deal]').forEach(el=>el.onclick=()=>{const offer=store.getSpecialOffer(el.dataset.toggleDeal);if(!offer)return;const result=store.setSpecialOfferPaused(offer.id,!offer.paused);if(!result.ok)return alert(result.message||'특가 상태를 변경할 수 없습니다.');render()});
  document.querySelectorAll('[data-delete-deal]').forEach(el=>el.onclick=()=>{if(!confirm('이 특가를 삭제할까요? 예약 이력이 있으면 기록은 보존됩니다.'))return;store.deleteSpecialOffer(el.dataset.deleteDeal);render()});
  document.querySelectorAll('[data-deal-tab]').forEach(el=>el.onclick=()=>{dealTab=el.dataset.dealTab;render()});
  document.querySelector('#deal-search')?.addEventListener('change',e=>{dealQuery=e.target.value.trim();render()});
  document.querySelector('#deal-date-filter')?.addEventListener('change',e=>{dealDate=e.target.value;render()});
  document.querySelector('#deal-reset')?.addEventListener('click',()=>{dealQuery='';dealDate='';dealTab='all';render()});
  document.querySelector('#save-rates')?.addEventListener('click',()=>{const moneyIds=['rate-weekday','rate-weekend','rate-three-surcharge','rate-two-surcharge','rate-cart','rate-caddie','deposit-value'],policyIds=['policy-seven','policy-six','policy-three','policy-one','policy-today'];if(moneyIds.some(id=>val(id)!==''&&Number(val(id))<0))return alert('요금과 추가금에는 음수를 입력할 수 없습니다.');if(policyIds.some(id=>!Number.isFinite(Number(val(id)))||Number(val(id))<0||Number(val(id))>100))return alert('환불률은 0~100 사이로 입력해주세요.');if(val('policy-cutoff')!==''&&(!Number.isInteger(Number(val('policy-cutoff')))||Number(val('policy-cutoff'))<0||Number(val('policy-cutoff'))>720))return alert('취소 가능 기한은 0~720시간으로 입력해주세요.');if(val('deposit-type')==='percent'&&Number(val('deposit-value'))>100)return alert('비율 예약금은 100%를 초과할 수 없습니다.');store.setRates(currentId(),{weekdayGreenFee:val('rate-weekday')?Number(val('rate-weekday')):null,weekendGreenFee:val('rate-weekend')?Number(val('rate-weekend')):null,threePlayerSurcharge:Number(val('rate-three-surcharge')||0),twoPlayerSurcharge:Number(val('rate-two-surcharge')||0),cartFee:val('rate-cart')?Number(val('rate-cart')):null,caddieFee:val('rate-caddie')?Number(val('rate-caddie')):null,depositType:val('deposit-type')||'none',depositValue:val('deposit-value')?Number(val('deposit-value')):0,cancellationPolicy:{sevenPlus:Number(val('policy-seven')||0),fourToSix:Number(val('policy-six')||0),twoToThree:Number(val('policy-three')||0),oneDay:Number(val('policy-one')||0),sameDay:Number(val('policy-today')||0),cutoffHoursBefore:val('policy-cutoff')===''?null:Number(val('policy-cutoff'))},dataMode:'demo'});alert('요금과 취소 정책이 저장되었습니다.');render()});
  document.querySelector('#save-course')?.addEventListener('click',()=>{store.setCourseOverride(currentId(),{phone:val('course-phone'),hours:val('course-hours'),guide:val('course-guide'),amenities:val('course-amenities')});alert('운영정보가 저장되었습니다.')});
}

/* 제휴 신청 ------------------------------------------------------------------ */
const FIELD_IDS={courseId:'a-course',courseName:'a-name',region:'a-region',city:'a-city',holes:'a-holes',managerName:'a-manager',managerRole:'a-role',managerPhone:'a-manager-phone',managerEmail:'a-email',weekdayGreenFee:'a-weekday',weekendGreenFee:'a-weekend',cartFee:'a-cart',caddieFee:'a-caddie',teeInterval:'a-interval',memo:'a-memo',agree:'a-agree'};
function applyPage(){
  if(!partnerApi)return `<div class="login"><section class="login-card"><div class="brand"><b>●</b> ALL:GOLF</div><h1>제휴 신청</h1><p class="form-error">제휴 신청 저장소를 불러오지 못했습니다. 페이지를 새로고침해주세요.</p><a class="secondary" href="../index.html">사용자 앱으로</a></section></div>`;
  const options=partnerApi.availableCourses().map(c=>`<option value="${esc(c.id)}" ${c.id===applyCourse?'selected':''}>${esc(c.name)} · ${esc(c.region)} ${esc(c.city)}</option>`).join('');
  return `<div class="login apply-view"><section class="login-card apply-card">
    <div class="brand"><b>●</b> ALL:GOLF</div>
    ${modeChip()}
    <h1>골프장 제휴 신청</h1>
    <p class="apply-lead">ALL:GOLF 제휴를 신청합니다. 접수 후 본사 검토를 거쳐 승인되면 사용자 앱에서 이 골프장의 시연 예약이 열리고, 승인된 골프장만 이 관리자 화면에서 티타임을 운영할 수 있습니다.</p>
    <div class="mode-switch"><button type="button" data-mode="existing" class="active">기존 골프장 선택</button><button type="button" data-mode="new">신규 골프장 직접 입력</button></div>
    <form id="apply-form" novalidate>
      <div class="form-grid">
        <label class="field full" data-mode-block="existing">골프장<select id="a-course"><option value="">골프장을 선택하세요</option>${options}</select><small class="field-hint">아직 제휴하지 않은 ${partnerApi.availableCourses().length}곳만 표시됩니다.</small></label>
        <label class="field" data-mode-block="new">골프장명<input id="a-name" maxlength="40" placeholder="예: 테스트 힐스 CC"></label>
        <label class="field" data-mode-block="new">지역<select id="a-region">${(window.ALL_GOLF_REGIONS||[]).filter(item=>item.code!=='전체').map(item=>`<option value="${esc(item.code)}">${esc(item.label)}</option>`).join('')}</select></label>
        <label class="field" data-mode-block="new">시·군<input id="a-city" maxlength="20" placeholder="예: 용인"></label>
        <label class="field" data-mode-block="new">홀 수<input id="a-holes" type="number" min="9" max="72" placeholder="18"></label>
        <label class="field" data-mode-block="new">운영형태<select id="a-type"><option value="public">대중제</option><option value="membership">회원제</option><option value="mixed">혼합형</option></select></label>
        <label class="field" data-mode-block="new">대표 전화<input id="a-course-phone" maxlength="20" placeholder="031-000-0000"></label>
        <label class="field full" data-mode-block="new">주소<input id="a-address" maxlength="80" placeholder="도로명 주소"></label>
        <label class="field full" data-mode-block="new">공식 홈페이지<input id="a-website" maxlength="120" placeholder="https://"></label>
      </div>
      <h3 class="subhead">담당자 정보</h3>
      <div class="form-grid">
        <label class="field">담당자명<input id="a-manager" maxlength="20" placeholder="홍길동"></label>
        <label class="field">직책<input id="a-role" maxlength="20" placeholder="예약 담당"></label>
        <label class="field">휴대전화<input id="a-manager-phone" inputmode="tel" maxlength="20" placeholder="010-1234-5678"></label>
        <label class="field">이메일<input id="a-email" type="email" maxlength="60" placeholder="manager@example.com"></label>
      </div>
      <h3 class="subhead">운영 조건</h3>
      <div class="form-grid">
        <label class="field">평일 그린피(원)<input id="a-weekday" type="number" min="0" placeholder="160000"></label>
        <label class="field">주말 그린피(원)<input id="a-weekend" type="number" min="0" placeholder="190000"></label>
        <label class="field">카트비(팀)<input id="a-cart" type="number" min="0" placeholder="100000"></label>
        <label class="field">캐디피(팀)<input id="a-caddie" type="number" min="0" placeholder="150000"></label>
        <label class="field">티오프 간격(분)<input id="a-interval" type="number" min="5" max="30" value="8"></label>
        <label class="field full">운영 조건·메모<textarea id="a-memo" rows="3" maxlength="500" placeholder="예: 주말 2인 플레이 가능, 카트 필수"></textarea></label>
      </div>
      <label class="check"><input type="checkbox" id="a-agree"> 담당자 정보와 운영 조건을 확인했고, 이 신청이 시연용이며 실제 제휴 계약이 아님을 이해했습니다.</label>
      <div class="form-error" id="apply-error" role="alert"></div>
      <div class="apply-actions"><a class="secondary" href="../index.html">사용자 앱으로</a><button class="primary" id="apply-submit" type="submit">제휴 신청 접수</button></div>
    </form>
    <p class="hint" id="apply-mode-note">${isServerMode()?'담당자 연락처는 서버 DB에 저장되며, 공개 제휴 골프장 목록에는 표시되지 않습니다.':'담당자 연락처는 이 브라우저의 시연 저장소에만 저장되며, 시연 데이터 백업 파일에서는 제외됩니다.'}</p>
  </section></div>`;
}
function bindApply(){
  let mode='existing';
  const setMode=next=>{
    mode=next;
    document.querySelectorAll('[data-mode-block]').forEach(el=>{el.hidden=el.dataset.modeBlock!==mode});
    document.querySelectorAll('[data-mode]').forEach(el=>el.classList.toggle('active',el.dataset.mode===mode));
  };
  document.querySelectorAll('[data-mode]').forEach(el=>el.onclick=()=>setMode(el.dataset.mode));
  setMode('existing');
  const showErrors=(errors,messages)=>{
    document.querySelector('#apply-error').innerHTML=messages.map(message=>`<span>${esc(message)}</span>`).join('');
    Object.keys(errors||{}).forEach(key=>{const targetId=FIELD_IDS[key];const field=targetId&&document.querySelector('#'+targetId);if(field){field.classList.add('invalid');field.setAttribute('aria-invalid','true')}});
    const first=Object.keys(errors||{}).map(key=>FIELD_IDS[key]).find(id=>id&&document.querySelector('#'+id));
    if(first){const field=document.querySelector('#'+first);field.scrollIntoView?.({block:'center'});field.focus?.()}
  };
  const showReceipt=(application,lookupCode)=>{
    lastReceipt=application.id;lastLookupCode=lookupCode||'';
    app.innerHTML=receiptCard(application,lookupCode);
    document.querySelector('#receipt-status').onclick=()=>{location.hash=`status:${application.id}`;view='status';render()};
  };
  document.querySelector('#apply-form').onsubmit=async event=>{
    event.preventDefault();
    document.querySelectorAll('.invalid').forEach(el=>el.classList.remove('invalid'));
    document.querySelector('#apply-error').textContent='';
    const input={courseMode:mode,courseId:val('a-course'),courseName:val('a-name'),region:val('a-region'),city:val('a-city'),address:val('a-address'),holes:val('a-holes'),operationType:val('a-type'),coursePhone:val('a-course-phone'),website:val('a-website'),managerName:val('a-manager'),managerRole:val('a-role'),managerPhone:val('a-manager-phone'),managerEmail:val('a-email'),weekdayGreenFee:val('a-weekday'),weekendGreenFee:val('a-weekend'),cartFee:val('a-cart'),caddieFee:val('a-caddie'),teeInterval:val('a-interval'),memo:val('a-memo'),agree:checked('a-agree')};
    if(isServerMode()){
      const button=document.querySelector('#apply-submit');
      if(button){button.disabled=true;button.textContent='접수 중…'}
      const response=await apiClient.request('/api/partner-applications',{method:'POST',body:input,timeoutMs:12000});
      if(button){button.disabled=false;button.textContent='제휴 신청 접수'}
      if(!response.ok){
        const error=(response.data&&response.data.error)||{};
        const errors=(error.details&&error.details.errors)||{};
        const messages=Object.keys(errors).length?Object.keys(errors).map(key=>errors[key]):[error.message||'신청을 접수하지 못했습니다.'];
        showErrors(errors,messages);
        if(response.status===409)document.querySelector('#apply-error').insertAdjacentHTML('beforeend','<span>이미 접수된 건은 ‘접수 상태 조회’에서 확인할 수 있습니다.</span>');
        return;
      }
      rememberReceipt(response.data.application,response.data.lookupCode);
      showReceipt(response.data.application,response.data.lookupCode);
      return;
    }
    const result=partnerApi.submit(input);
    if(!result.ok){
      showErrors(result.errors,Object.keys(result.errors||{}).map(key=>result.errors[key]));
      return;
    }
    rememberReceipt(result.application,'');
    showReceipt(result.application,'');
  };
}
function receiptCard(application,lookupCode){
  return `<div class="login apply-view"><section class="login-card receipt-card"><div class="brand"><b>●</b> ALL:GOLF</div>${modeChip()}<span class="receipt-badge">접수 완료</span><h1>${esc(application.id)}</h1><p><b>${esc(application.course?.name||'')}</b> 제휴 신청이 접수되었습니다. 본사 검토 후 승인되면 사용자 앱에서 이 골프장의 시연 예약이 열립니다.</p><dl class="receipt-dl"><div><dt>골프장</dt><dd>${esc(application.course?.name||'-')} · ${esc(application.course?.region||'')} ${esc(application.course?.city||'')}</dd></div><div><dt>신청 구분</dt><dd>${application.courseMode==='new'?'신규 골프장':'기존 골프장'}</dd></div><div><dt>담당자</dt><dd>${esc(application.manager?.name||'-')} · ${esc(application.manager?.phone||'-')}</dd></div><div><dt>접수 일시</dt><dd>${esc(String(application.createdAt||'').slice(0,16).replace('T',' '))}</dd></div><div><dt>진행 상태</dt><dd><span class="badge pending">검토 대기</span></dd></div>${lookupCode?`<div><dt>조회 코드</dt><dd><b>${esc(lookupCode)}</b> · 타인은 볼 수 없습니다.</dd></div>`:''}</dl><p class="hint">${lookupCode?'접수번호와 조회 코드를 함께 보관해주세요. ‘접수 상태 조회’에서 두 값을 입력하면 진행 상황을 확인할 수 있습니다.':'접수번호를 보관해주세요. 아래 ‘접수 상태 조회’에서 진행 상황을 확인할 수 있습니다.'}</p><div class="apply-actions"><a class="secondary" href="../index.html">사용자 앱으로</a><button class="primary" id="receipt-status" type="button">접수 상태 조회</button></div></section></div>`;
}
/* 접수 상태 조회 ------------------------------------------------------------- */
function statusResult(application){
  const decision=application.decision||{};
  const guide=application.status==='pending'?'본사 검토 중입니다. 승인되면 사용자 앱에서 예약 가능한 골프장으로 표시됩니다.':application.status==='approved'?'승인되었습니다. 사용자 앱에서 예약할 수 있고, 골프장 관리자 화면에서 티타임을 운영할 수 있습니다.':'반려되었습니다. 내용을 보완해 다시 신청할 수 있습니다.';
  return `<div class="status-result"><span class="badge ${esc(application.status)}">${esc(application.statusLabel||application.status)}</span><h3>${esc(application.course?.name||'-')}</h3><dl class="receipt-dl"><div><dt>접수번호</dt><dd>${esc(application.id)}</dd></div><div><dt>신청 구분</dt><dd>${application.courseMode==='new'?'신규 골프장':'기존 골프장'}</dd></div><div><dt>접수 일시</dt><dd>${esc(String(application.createdAt||'').slice(0,16).replace('T',' '))}</dd></div><div><dt>담당자</dt><dd>${esc(application.manager?.name||'-')} · ${esc(application.manager?.phone||'-')}</dd></div><div><dt>처리 일시</dt><dd>${decision.at?esc(String(decision.at).slice(0,16).replace('T',' ')):'아직 처리 전'}</dd></div>${decision.reason?`<div><dt>반려 사유</dt><dd>${esc(decision.reason)}</dd></div>`:''}</dl><p class="hint">${esc(guide)}</p>${application.status==='approved'?`<a class="primary link" href="#dashboard">골프장 관리자 화면 열기</a>`:''}</div>`;
}
function statusPage(){
  const server=isServerMode();
  const recent=server?readReceipts():partnerApi.list().slice(0,8);
  const rows=server
    ? recent.map(item=>`<button class="status-row" type="button" data-status="${esc(item.id)}" data-code="${esc(item.code||'')}"><b>${esc(item.id)}</b><span>${esc(item.courseName||'')}</span><em class="badge ${esc(item.status||'pending')}">${{pending:'검토 대기',approved:'승인 완료',rejected:'반려'}[item.status]||'검토 대기'}</em></button>`).join('')
    : recent.map(item=>`<button class="status-row" type="button" data-status="${esc(item.id)}"><b>${esc(item.id)}</b><span>${esc(item.course?.name||'')}</span><em class="badge ${esc(item.status)}">${esc(item.statusLabel||item.status)}</em></button>`).join('');
  return `<div class="login apply-view"><section class="login-card status-card"><div class="brand"><b>●</b> ALL:GOLF</div>${modeChip()}<h1>제휴 신청 상태 조회</h1><p>${server?'접수번호와 접수 시 안내된 6자리 조회 코드를 입력합니다. 다른 사람의 신청은 열람할 수 없습니다.':'접수번호로 진행 상태를 확인합니다. 이 브라우저에서 접수한 신청만 조회됩니다.'}</p><form id="status-form"><label class="field">접수번호<input id="s-receipt" placeholder="PA-261124-0001" autocomplete="off"></label>${server?'<label class="field">조회 코드<input id="s-code" inputmode="numeric" maxlength="6" placeholder="6자리 숫자" autocomplete="one-time-code"></label>':''}<button class="primary" type="submit">조회</button></form><div id="status-result"></div>${rows?`<h3 class="subhead">${server?'이 브라우저에서 접수한 내역':'이 브라우저의 접수 내역'}</h3><div class="status-list">${rows}</div>`:''}<div class="apply-actions"><a class="secondary" href="#apply">새 제휴 신청</a><a class="secondary" href="../index.html">사용자 앱으로</a></div><p class="hint">${modeNote()}</p></section></div>`;
}
function bindStatus(){
  const resultBox=document.querySelector('#status-result');
  const search=async(lookupCode)=>{
    const receipt=val('s-receipt').trim();
    if(!receipt){resultBox.innerHTML='<div class="form-error">접수번호를 입력해주세요.</div>';return}
    if(isServerMode()){
      const code=(lookupCode!==undefined?lookupCode:val('s-code')||'').trim();
      resultBox.innerHTML='<div class="notice">서버에서 조회하는 중…</div>';
      const response=await apiClient.request(`/api/partner-applications/${encodeURIComponent(receipt)}?code=${encodeURIComponent(code)}`,{timeoutMs:8000});
      if(response.ok&&response.data&&response.data.application){
        const found=response.data.application;
        resultBox.innerHTML=statusResult(found);
        return;
      }
      if(response.status===403)resultBox.innerHTML='<div class="form-error">조회 코드가 일치하지 않습니다. 접수 완료 화면에 안내된 6자리 코드를 입력해주세요.</div>';
      else if(response.status===404)resultBox.innerHTML='<div class="form-error">해당 접수번호의 신청을 찾을 수 없습니다. 번호를 다시 확인해주세요.</div>';
      else if(response.status===429)resultBox.innerHTML='<div class="form-error">조회 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.</div>';
      else resultBox.innerHTML=`<div class="form-error">${esc((response.error&&response.error.message)||'조회하지 못했습니다. 서버 연결을 확인해주세요.')}</div>`;
      return;
    }
    const found=partnerApi?partnerApi.statusOf(receipt):null;
    resultBox.innerHTML=found?statusResult(found):'<div class="form-error">해당 접수번호의 신청을 찾을 수 없습니다. 접수번호를 다시 확인해주세요.</div>';
  };
  document.querySelector('#status-form').onsubmit=event=>{event.preventDefault();search()};
  document.querySelectorAll('[data-status]').forEach(el=>el.onclick=()=>{
    document.querySelector('#s-receipt').value=el.dataset.status;
    const codeField=document.querySelector('#s-code');
    if(codeField&&el.dataset.code)codeField.value=el.dataset.code;
    search(el.dataset.code||undefined);
  });
  const stored=readReceipts()[0];
  const preselected=hashCourse()||lastReceipt||(isServerMode()&&stored?stored.id:'');
  if(preselected){document.querySelector('#s-receipt').value=preselected;const codeField=document.querySelector('#s-code');if(codeField){codeField.value=lastLookupCode||(stored&&stored.id===preselected?stored.code:'')}search(codeField?codeField.value:undefined)}
}

/* ===== 7단계: 서버 모드 (골프장별 담당자 계정으로 로그인, 서버 CRUD) ===== */
const PARTNER_TOKEN_KEY='allGolfPartnerToken';
let serverSession=null,serverData={},serverLoadingKey='',serverBooted=false,serverLastRefresh='';
const partnerToken=()=>apiClient&&apiClient.getPartnerToken?apiClient.getPartnerToken():'';
const serverCourse=()=>serverSession&&serverSession.course?serverSession.course:null;
const serverAccount=()=>serverSession&&serverSession.account?serverSession.account:null;
const serverMenu=()=>[['dashboard','운영 현황'],['tees','티타임 관리'],['bookings','예약 관리'],['rates','요금 설정'],['deals','특가 관리'],['course','골프장 정보'],['apply','제휴 신청'],['status','접수 상태']];
const serverMeta=()=>`<div class="server-meta"><span class="mode-chip server">서버 연동</span><small>마지막 갱신 ${esc(serverLastRefresh||'-')}</small></div>`;
const invalidateServer=()=>{serverData={};serverLoadingKey=''};

function serverShell(title,body){
  const course=serverCourse()||currentCourse()||{name:'골프장'};
  const account=serverAccount();
  return `<div class="shell"><aside class="sidebar"><div class="brand"><b>●</b> ALL:GOLF</div><small>골프장 운영 시스템 · 서버</small>${serverMenu().map(([id,label])=>`<a href="#${id}" class="side-btn ${view===id?'active':''}" data-view="${id}">${label}</a>`).join('')}<button class="side-btn logout" id="logout">로그아웃</button></aside><main class="main"><div class="top"><div><h1>${title}</h1><p>${esc(course.name)}${account?` · ${esc(account.name)} (${esc(account.roleLabel||'')})`:''}</p></div>${serverMeta()}</div>${body}</main></div>`;
}
function serverLogin(message=''){
  return `<div class="login"><section class="login-card"><div class="brand"><b>●</b> ALL:GOLF</div><span class="mode-chip server">서버 연동</span><h1>골프장 관리자 로그인</h1><p>본사에서 발급한 골프장별 담당자 계정으로 로그인합니다. 계정마다 자기 골프장 데이터만 조회·수정할 수 있습니다.</p><label class="field">이메일<input id="partner-email" type="email" autocomplete="username" placeholder="partner@example.com"></label><label class="field">비밀번호<input id="partner-password" type="password" autocomplete="current-password" placeholder="비밀번호"></label><button class="primary" id="partner-login">로그인</button><div class="form-error" id="partner-login-error" role="alert">${esc(message)}</div><div class="login-links"><button class="link-btn" id="go-apply">골프장 제휴 신청</button><button class="link-btn" id="go-status">접수 상태 조회</button></div><div class="hint">계정이 없으면 본사 관리자에게 발급을 요청하세요. 시연용 계정은 본사 관리자 화면의 ‘제휴 계정 관리’에서 만들 수 있습니다.</div></section></div>`;
}
function bindServerLogin(){
  const submit=async()=>{
    const email=val('partner-email').trim(),password=val('partner-password');
    const errorBox=document.querySelector('#partner-login-error');
    if(!email||!password){errorBox.textContent='이메일과 비밀번호를 입력해주세요.';return}
    const button=document.querySelector('#partner-login');button.disabled=true;button.textContent='로그인 중…';
    const response=await apiClient.request('/api/partner/login',{method:'POST',body:{email,password},timeoutMs:10000});
    button.disabled=false;button.textContent='로그인';
    if(!response.ok){errorBox.textContent=(response.error&&response.error.message)||'로그인하지 못했습니다.';return}
    apiClient.setPartnerToken(response.data.token);
    serverSession={account:response.data.account,course:response.data.course};
    serverLastRefresh=new Date().toLocaleTimeString('ko-KR');
    view='dashboard';location.hash='dashboard';invalidateServer();render();
  };
  document.querySelector('#partner-login').onclick=submit;
  document.querySelector('#partner-password').onkeydown=event=>{if(event.key==='Enter')submit()};
  document.querySelector('#go-apply').onclick=()=>{location.hash='apply';view='apply';render()};
  document.querySelector('#go-status').onclick=()=>{location.hash='status';view='status';render()};
}
async function fetchServerSession(){
  const response=await apiClient.request('/api/partner/session',{token:partnerToken(),timeoutMs:8000});
  if(!response.ok){serverSession=null;return false}
  serverSession={account:response.data.account,course:response.data.course};
  serverLastRefresh=new Date().toLocaleTimeString('ko-KR');
  return true;
}
async function partnerRequest(pathname,options={}){
  const response=await apiClient.request(pathname,{...options,token:partnerToken(),timeoutMs:options.timeoutMs||12000});
  if(response.status===401){serverSession=null;if(apiClient.clearPartnerToken)apiClient.clearPartnerToken()}
  return response;
}
function serverKey(){
  if(view==='tees'||view==='deals')return `${view}:${selectedDate}`;
  return view;
}
function serverTitle(){
  return ({dashboard:'운영 현황',tees:'티타임 관리',bookings:'예약 현황',rates:'요금 설정',deals:'특가 관리',course:'골프장 정보'})[view]||'운영 현황';
}
function loadingPanel(){return '<section class="panel"><div class="notice">서버에서 불러오는 중…</div></section>'}
function errorPanel(message){return `<section class="panel"><div class="form-error">${esc(message||'불러오지 못했습니다.')}</div><div class="btn-row"><button class="secondary" id="server-retry">다시 시도</button></div></section>`}
async function loadServerData(key){
  const [target,date]=key.split(':');
  if(target==='dashboard'){
    const [dash,tees]=await Promise.all([partnerRequest('/api/partner/dashboard'),partnerRequest(`/api/partner/tee-times?date=${encodeURIComponent(date||selectedDate)}`)]);
    if(!dash.ok)throw new Error((dash.error&&dash.error.message)||'운영 현황을 불러오지 못했습니다.');
    serverData[key]={dash:dash.data,teeTimes:(tees.data&&tees.data.teeTimes)||[]};
  }else if(target==='tees'){
    const response=await partnerRequest(`/api/partner/tee-times?date=${encodeURIComponent(date||selectedDate)}`);
    if(!response.ok)throw new Error((response.error&&response.error.message)||'티타임을 불러오지 못했습니다.');
    serverData[key]={teeTimes:response.data.teeTimes||[]};
  }else if(target==='deals'){
    const offers=await partnerRequest('/api/partner/special-offers');
    if(!offers.ok)throw new Error((offers.error&&offers.error.message)||'특가를 불러오지 못했습니다.');
    const list=offers.data.offers||[];
    const dates=list.map(item=>item.roundDate).filter(Boolean).sort();
    const from=dates.length?dates[0]:selectedDate,to=dates.length?dates[dates.length-1]:selectedDate;
    const range=await partnerRequest(`/api/partner/tee-times?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    serverData[key]={offers:list,teeTimes:(range.data&&range.data.teeTimes)||[]};
  }else if(target==='rates'){
    const response=await partnerRequest('/api/partner/rates');
    if(!response.ok)throw new Error((response.error&&response.error.message)||'요금을 불러오지 못했습니다.');
    serverData[key]={rates:response.data.rates};
  }else if(target==='bookings'){
    const query=selectedDate?`?date=${encodeURIComponent(selectedDate)}`:'';
    const response=await partnerRequest(`/api/partner/reservations${query}`);
    if(!response.ok)throw new Error((response.error&&response.error.message)||'예약을 불러오지 못했습니다.');
    serverData[key]={reservations:response.data.reservations||[],stats:response.data.stats||{}};
  }else if(target==='course'){
    const response=await partnerRequest('/api/partner/dashboard');
    if(!response.ok)throw new Error((response.error&&response.error.message)||'골프장 정보를 불러오지 못했습니다.');
    serverData[key]={dash:response.data};
  }else{
    serverData[key]={};
  }
  serverLastRefresh=new Date().toLocaleTimeString('ko-KR');
}
function renderServer(){
  if(!serverSession){
    if(!partnerToken()){
      /* 세션 저장소가 비어 있어도 HttpOnly 쿠키로 복원될 수 있으므로 한 번 확인한다. */
      if(!serverBooted){
        serverBooted=true;
        app.innerHTML=serverLogin('세션을 확인하는 중입니다…');bindServerLogin();
        fetchServerSession().then(ok=>{if(!ok)apiClient.clearPartnerToken();render()}).catch(()=>render());
        return;
      }
      app.innerHTML=serverLogin();bindServerLogin();return;
    }
    app.innerHTML=serverLogin('세션을 확인하는 중입니다…');
    bindServerLogin();
    if(!serverBooted){serverBooted=true;fetchServerSession().then(ok=>{if(!ok)apiClient.clearPartnerToken();render()}).catch(()=>render())}
    return;
  }
  const key=serverKey();
  if(!serverData[key]){
    if(serverLoadingKey!==key){
      serverLoadingKey=key;
      loadServerData(key).then(()=>{serverLoadingKey='';render()}).catch(error=>{serverLoadingKey='';serverData[key]={error:error&&error.message};render()});
    }
    app.innerHTML=serverShell(serverTitle(),loadingPanel());bindServerShell();
    return;
  }
  const data=serverData[key];
  if(data.error){
    app.innerHTML=serverShell(serverTitle(),errorPanel(data.error));bindServerShell();
    document.querySelector('#server-retry')?.addEventListener('click',()=>{invalidateServer();render()});
    return;
  }
  app.innerHTML=serverShell(serverTitle(),serverBody(data));bindServerShell();bindServerView(data);
}
function serverBody(data){
  if(view==='tees')return serverTeesView(data);
  if(view==='deals')return serverDealsView(data);
  if(view==='rates')return serverRatesView(data);
  if(view==='bookings')return serverBookingsView(data);
  if(view==='course')return serverCourseView(data);
  return serverDashboardView(data);
}
function bindServerShell(){
  document.querySelectorAll('[data-view]').forEach(el=>el.onclick=()=>{view=el.dataset.view;location.hash=view;render()});
  document.querySelector('#logout')?.addEventListener('click',async()=>{try{await partnerRequest('/api/partner/logout',{method:'POST'})}catch{ }serverSession=null;serverData={};apiClient.clearPartnerToken();location.hash='';view='dashboard';render()});
}
function bindServerView(data){
  document.querySelectorAll('[data-date-change]').forEach(el=>el.onchange=()=>{selectedDate=el.value||todayISO();invalidateServer();render()});
  document.querySelector('#server-new-tee')?.addEventListener('click',()=>serverTeeModal(null));
  document.querySelector('#server-recurring-tee')?.addEventListener('click',()=>serverRecurringModal());
  document.querySelector('#server-refresh')?.addEventListener('click',()=>{invalidateServer();render()});
  document.querySelectorAll('[data-server-edit-tee]').forEach(el=>el.onclick=()=>serverTeeModal((data.teeTimes||[]).find(item=>item.id===el.dataset.serverEditTee)));
  document.querySelectorAll('[data-server-toggle-tee]').forEach(el=>el.onclick=()=>toggleServerTee(el.dataset.serverToggleTee,(data.teeTimes||[]).find(item=>item.id===el.dataset.serverToggleTee)));
  document.querySelectorAll('[data-server-delete-tee]').forEach(el=>el.onclick=()=>deleteServerTee(el.dataset.serverDeleteTee,(data.teeTimes||[]).find(item=>item.id===el.dataset.serverDeleteTee)));
  document.querySelector('#server-save-rates')?.addEventListener('click',()=>saveServerRates(data.rates));
  document.querySelector('#server-new-deal')?.addEventListener('click',()=>serverDealModal(null,data.teeTimes||[]));
  document.querySelectorAll('[data-server-edit-deal]').forEach(el=>el.onclick=()=>serverDealModal((data.offers||[]).find(item=>item.id===el.dataset.serverEditDeal),data.teeTimes||[]));
  document.querySelectorAll('[data-server-pause-deal]').forEach(el=>el.onclick=()=>pauseServerDeal((data.offers||[]).find(item=>item.id===el.dataset.serverPauseDeal),!(data.offers||[]).find(item=>item.id===el.dataset.serverPauseDeal)?.paused));
  document.querySelectorAll('[data-server-delete-deal]').forEach(el=>el.onclick=()=>deleteServerDeal((data.offers||[]).find(item=>item.id===el.dataset.serverDeleteDeal)));
  document.querySelectorAll('[data-server-reservation]').forEach(el=>el.onclick=()=>serverReservationDetail(el.dataset.serverReservation));
  document.querySelectorAll('[data-server-reservation-status]').forEach(el=>el.onclick=()=>changeServerReservation(el.dataset.serverReservationStatus,el.dataset.serverStatus));
}
function serverDashboardView(data){
  const dash=data.dash||{},times=data.teeTimes||[],today=selectedDate||todayISO();
  const cards=[['등록 티타임',`${dash.teeTimes?dash.teeTimes.total:0}개`],['선택일 티타임',`${times.length}개`],['선택일 예약',`${dash.reservations&&dash.reservations.today!=null?dash.reservations.today:0}건`],['확정 예약',`${dash.reservations?dash.reservations.count:0}건`],['판매 중 특가',`${dash.offers?dash.offers.active:0}개`]];
  return `<section class="dashboard-date"><label>운영 날짜 <input class="date-picker" type="date" value="${today}" data-date-change></label><span>서버 DB 기준 · 예약 재고는 서버 예약·임시확보로 공유됩니다.</span></section><section class="stats simple-stats">${cards.map(([label,value])=>`<article class="stat"><small>${label}</small><strong>${value}</strong></article>`).join('')}</section><section class="panel"><div class="panel-head"><div><h2>${esc(dash.course?dash.course.name:'')} 운영 현황</h2><p>서버에 저장된 티타임·특가를 불러왔습니다. 마지막 갱신 ${esc(serverLastRefresh)}</p></div><div class="btn-row"><button class="secondary" id="server-refresh">새로고침</button><button class="primary" data-view="tees">티타임 관리</button></div></div><div class="table-wrap"><table class="table"><thead><tr><th>시간</th><th>코스</th><th>부</th><th>그린피</th><th>예약 가능</th><th>상태</th><th>관리</th></tr></thead><tbody>${times.map(tee=>`<tr><td><b>${esc(tee.time)}</b></td><td>${esc(tee.course||'전체')}</td><td>${esc(tee.session)}</td><td>${money(tee.greenFee)}</td><td>${tee.remaining}/${tee.capacityTeams}팀</td><td><span class="badge ${tee.status==='open'?'active':tee.status==='stopped'?'paused':'closed'}">${esc(tee.statusLabel)}</span></td><td><button class="secondary" data-server-edit-tee="${esc(tee.id)}">수정</button></td></tr>`).join('')||'<tr><td colspan="7" class="empty">이 날짜에 등록된 티타임이 없습니다. ‘티타임 관리’에서 추가하세요.</td></tr>'}</tbody></table></div></section><section class="panel"><div class="panel-head"><div><h2>예약 현황</h2><p>${esc(dash.reservations?dash.reservations.note:'')}</p></div><button class="secondary" data-view="bookings">예약 관리</button></div><div class="notice">${esc(dash.reservations?dash.reservations.note:'')}</div></section>`;
}
function serverTeesView(data){
  const items=data.teeTimes||[];
  return `<section class="panel"><div class="panel-head"><div><h2>티타임 관리</h2><p>서버에 저장되며 사용자 앱에도 반영됩니다. 잔여 팀은 서버 예약·임시확보 기준으로 계산됩니다.</p></div><div class="btn-row"><input class="date-picker" type="date" value="${selectedDate}" data-date-change><button class="secondary" id="server-recurring-tee">날짜 반복 등록</button><button class="primary" id="server-new-tee">+ 티타임 추가</button></div></div><div class="table-wrap"><table class="table"><thead><tr><th>시간</th><th>코스</th><th>부</th><th>예약 가능 팀</th><th>최대 인원</th><th>기본 그린피</th><th>잔여</th><th>상태</th><th>관리</th></tr></thead><tbody>${items.map(tee=>`<tr><td><b>${esc(tee.time)}</b></td><td>${esc(tee.course||'전체')}</td><td>${esc(tee.session)}</td><td>${tee.capacityTeams}팀</td><td>${tee.maxPlayers}명</td><td>${money(tee.greenFee)}</td><td>${tee.remaining}팀</td><td><span class="badge ${tee.status==='open'?'active':tee.status==='stopped'?'paused':'closed'}">${esc(tee.statusLabel)}</span></td><td><button class="secondary" data-server-edit-tee="${esc(tee.id)}">수정</button> <button class="${tee.status==='open'?'danger':'success'}" data-server-toggle-tee="${esc(tee.id)}">${tee.status==='open'?'판매 중지':'판매 재개'}</button> <button class="danger" data-server-delete-tee="${esc(tee.id)}">삭제</button></td></tr>`).join('')||'<tr><td colspan="9" class="empty">등록된 티타임이 없습니다.</td></tr>'}</tbody></table></div><p class="notice">예약·임시확보가 연결된 티타임은 삭제할 수 없습니다(삭제 대신 판매 중지·마감).</p></section>`;
}
function serverBookingStatus(item){
  return ({confirmed:'예약 확정',cancelled:'취소',completed:'이용 완료',no_show:'노쇼'})[item.status]||item.status;
}
function serverBookingsView(data){
  const items=data.reservations||[],stats=data.stats||{};
  const cards=[['전체 예약',`${stats.total||0}건`],['확정',`${stats.confirmed||0}건`],['취소',`${stats.cancelled||0}건`],['확정 인원',`${stats.people||0}명`]];
  return `<section class="notice">서버에 저장된 실제 예약입니다. 잔여 팀은 확정 예약과 진행 중 임시확보를 함께 계산하며, 취소하면 재고가 즉시 복구됩니다(시연용·실결제 아님).</section>
  <section class="stats simple-stats">${cards.map(([label,value])=>`<article class="stat"><small>${label}</small><strong>${value}</strong></article>`).join('')}</section>
  <section class="panel"><div class="panel-head"><div><h2>예약 관리</h2><p>${selectedDate} 라운드 · 서버 예약 ${items.length}건</p></div><div class="btn-row"><input class="date-picker" type="date" value="${selectedDate}" data-date-change><button class="secondary" id="server-refresh">새로고침</button></div></div>
  <div class="table-wrap"><table class="table"><thead><tr><th>예약번호</th><th>라운드</th><th>티타임</th><th>예약자</th><th>연락처</th><th>인원</th><th>예약금</th><th>상태</th><th>관리</th></tr></thead><tbody>${items.map(item=>`<tr><td><b>${esc(item.number)}</b><small class="demo-cell">${esc(String(item.createdAt||'').slice(0,10))}</small></td><td>${esc(item.date||item.dateISO||'-')}</td><td>${esc(item.time||'-')}</td><td>${esc(item.booker||'-')}</td><td>${esc(item.phone||'-')}</td><td>${Number(item.people)||0}명</td><td>${money(item.paidDeposit)}${item.status==='cancelled'?`<small class="demo-cell">환불 ${money(item.refundAmount||0)}</small>`:''}</td><td><span class="badge ${item.status==='cancelled'?'cancel':item.status==='completed'?'':item.status==='no_show'?'paused':'active'}">${esc(serverBookingStatus(item))}</span></td><td><button class="secondary" data-server-reservation="${esc(item.id)}">상세</button> ${item.status==='confirmed'?`<button class="secondary" data-server-reservation-status="${esc(item.id)}" data-server-status="completed">완료</button> <button class="danger" data-server-reservation-status="${esc(item.id)}" data-server-status="cancelled">취소</button>`:''}</td></tr>`).join('')||'<tr><td colspan="9" class="empty">이 날짜에 서버 예약이 없습니다.</td></tr>'}</tbody></table></div></section>`;
}
async function serverReservationDetail(id){
  const response=await partnerRequest(`/api/partner/reservations/${encodeURIComponent(id)}`);
  if(!response.ok){invalidateOnError(response);return}
  const r=response.data.reservation||{};
  const quote=r.quote||{};
  modal.innerHTML=`<div class="modal-bg"><section class="modal booking-detail"><h2>예약 상세</h2><p>${esc(r.number||'')} · ${esc(serverBookingStatus(r))}</p><dl><div><dt>예약자</dt><dd>${esc(r.booker||'-')} · ${esc(r.phone||'-')}</dd></div><div><dt>골프장</dt><dd>${esc(r.courseName||'')}</dd></div><div><dt>라운드</dt><dd>${esc(r.date||r.dateISO||'')} ${esc(r.time||'')} · ${Number(r.people)||0}명</dd></div><div><dt>동반자</dt><dd>${r.companions&&r.companions.length?esc(r.companions.join(' · ')):'입력 없음'}</dd></div>${Number(r.playerSurcharge)>0?`<div><dt>인원별 추가금</dt><dd>${money(r.playerSurcharge)} / 1인</dd></div>`:''}${r.specialOfferName?`<div><dt>적용 특가</dt><dd>${esc(r.specialOfferName)}</dd></div>`:''}<div><dt>총 예상 이용금액</dt><dd>${money(r.totalEstimated)}</dd></div><div><dt>예약금</dt><dd>${money(r.paidDeposit)}</dd></div><div><dt>현장 결제 예정</dt><dd>${money(r.onsite)}</dd></div>${r.status==='cancelled'?`<div><dt>취소 일시</dt><dd>${esc(String(r.cancelledAt||'').slice(0,16).replace('T',' '))}</dd></div><div><dt>취소 사유</dt><dd>${esc(r.cancelReason||'-')}</dd></div><div><dt>취소수수료</dt><dd>${money(r.cancellationFee||0)}</dd></div><div><dt>시연 환불 금액</dt><dd>${money(r.refundAmount||0)}</dd></div>`:`<div><dt>지금 취소 시</dt><dd>환불률 ${quote.refundRate==null?'-':quote.refundRate+'%'} · 환불 ${money(quote.refundAmount||0)}</dd></div>`}</dl><p>요청사항 ${esc(r.request||'없음')}</p><div class="modal-actions"><button class="primary" data-modal-close>확인</button></div></section></div>`;
  document.querySelector('[data-modal-close]').onclick=closeModal;
}
async function changeServerReservation(id,status){
  const labels={completed:'이용 완료',no_show:'노쇼',cancelled:'취소',confirmed:'예약 확정'};
  let reason='';
  if(status==='cancelled'){
    if(!confirm('이 예약을 취소할까요? 취소하면 잔여 팀이 즉시 복구되고 환불 규정이 적용됩니다.'))return;
    reason=(prompt('취소 사유를 입력해주세요. (예: 고객 요청, 기상 악화)')||'').trim();
    if(!reason){alert('취소 사유를 입력해주세요.');return}
  }else if(!confirm(`예약 상태를 '${labels[status]||status}'(으)로 변경할까요?`))return;
  const response=await partnerRequest(`/api/partner/reservations/${encodeURIComponent(id)}/status`,{method:'POST',body:{status,reason}});
  if(!response.ok){invalidateOnError(response);return}
  invalidateServer();render();
  if(status==='cancelled')alert(`예약을 취소했습니다. 환불 금액 ${money((response.data.refund&&response.data.refund.refundAmount)||0)}(시연)`);
}
function serverRatesView(data){
  const r=data.rates||{};
  const policy={sevenPlus:100,fourToSix:70,twoToThree:50,oneDay:0,sameDay:0,cutoffHoursBefore:null,...(r.cancellationPolicy||{})};
  return `<section class="panel"><div class="panel-head"><div><h2>요금 설정</h2><p>기본·3인·4인 요금과 예약금, 취소·환불 정책을 서버에 저장합니다. 고객 앱 계산과 예약 환불에 반영됩니다.</p></div><button class="primary" id="server-save-rates">저장</button></div><div class="notice">기본 그린피는 4인 기준 1인 금액입니다. 3인·4인 그린피를 직접 지정하면 그 값이 우선합니다.</div><div class="form-grid"><label class="field">기본 그린피(1인)<input id="sr-base" type="number" min="0" value="${r.baseGreenFee??''}"></label><label class="field">3인 1인 그린피(선택)<input id="sr-three" type="number" min="0" value="${r.threePlayerGreenFee??''}" placeholder="미지정 시 기본 + 추가금"></label><label class="field">3인 1인당 추가금<input id="sr-three-surcharge" type="number" min="0" value="${r.threePlayerSurcharge??0}"></label><label class="field">4인 1인 그린피(선택)<input id="sr-four" type="number" min="0" value="${r.fourPlayerGreenFee??''}" placeholder="미지정 시 기본"></label><label class="field">2인 1인당 추가금<input id="sr-two-surcharge" type="number" min="0" value="${r.twoPlayerSurcharge??0}"></label><label class="field">평일 그린피(선택)<input id="sr-weekday" type="number" min="0" value="${r.weekdayGreenFee??''}" placeholder="미지정 시 기본"></label><label class="field">주말 그린피(선택)<input id="sr-weekend" type="number" min="0" value="${r.weekendGreenFee??''}" placeholder="미지정 시 기본"></label><label class="field">카트비(팀)<input id="sr-cart" type="number" min="0" value="${r.cartFee??''}"></label><label class="field">캐디피(팀)<input id="sr-caddie" type="number" min="0" value="${r.caddieFee??''}"></label><label class="field">예약금 방식<select id="sr-deposit-type"><option value="none" ${r.depositType==='none'?'selected':''}>예약금 없음</option><option value="team" ${r.depositType==='team'?'selected':''}>팀당 고정</option><option value="person" ${!r.depositType||r.depositType==='person'?'selected':''}>1인당</option><option value="percent" ${r.depositType==='percent'?'selected':''}>총액의 %</option></select></label><label class="field">예약금 금액/비율<input id="sr-deposit-value" type="number" min="0" value="${r.depositValue??''}"></label></div><h3 class="subhead">취소·환불 정책</h3><div class="notice">라운드일까지 남은 날짜를 기준으로 예약금 환불률을 계산합니다. 예약 확정 시 정책을 스냅샷으로 보존합니다.</div><div class="form-grid"><label class="field">취소 가능 기한(티오프 몇 시간 전)<input id="sr-policy-cutoff" type="number" min="0" max="720" value="${policy.cutoffHoursBefore??''}" placeholder="비우면 제한 없음"></label><label class="field">7일 전까지 환불률 %<input id="sr-policy-seven" type="number" min="0" max="100" value="${policy.sevenPlus}"></label><label class="field">4~6일 전 환불률 %<input id="sr-policy-six" type="number" min="0" max="100" value="${policy.fourToSix}"></label><label class="field">2~3일 전 환불률 %<input id="sr-policy-three" type="number" min="0" max="100" value="${policy.twoToThree}"></label><label class="field">1일 전 환불률 %<input id="sr-policy-one" type="number" min="0" max="100" value="${policy.oneDay}"></label><label class="field">당일 환불률 %<input id="sr-policy-today" type="number" min="0" max="100" value="${policy.sameDay}"></label></div><p class="notice">현재 요금 버전 ${esc(String(r.version||0))} · 마지막 수정 ${esc(String(r.updatedAt||'-').slice(0,16).replace('T',' '))}</p></section>`;
}
function serverDealsView(data){
  const offers=data.offers||[];
  const cards=[['등록 특가',`${offers.length}개`],['진행 중',`${offers.filter(item=>item.status==='active').length}개`],['예정',`${offers.filter(item=>item.status==='scheduled').length}개`]];
  return `<section class="notice">모든 특가는 시연용 가격이며 실제 판매·정산이 아닙니다. 정상가·특가·할인율은 서버가 계산합니다.</section><section class="stats deal-stats">${cards.map(([label,value])=>`<article class="stat"><small>${label}</small><strong>${value}</strong></article>`).join('')}</section><section class="panel"><div class="panel-head"><div><h2>특가 목록</h2><p>티타임에 연결된 서버 특가입니다. 고객 앱에 할인가로 표시됩니다.</p></div><button class="primary" id="server-new-deal">+ 특가 등록</button></div><div class="table-wrap"><table class="table deal-table"><thead><tr><th>특가명</th><th>라운딩</th><th>정상가</th><th>특가</th><th>할인</th><th>적용 팀</th><th>상태</th><th>관리</th></tr></thead><tbody>${offers.map(offer=>`<tr><td><b>${esc(offer.name)}</b></td><td>${esc(offer.roundDate)}<br>${esc(offer.time)}</td><td><s>${money(offer.regularPrice)}</s></td><td><b class="deal-amount">${money(offer.specialPrice)}</b></td><td>${money(offer.discountAmount)}<br><b>${offer.discountRate}%</b></td><td>${offer.teamLimit}팀</td><td><span class="badge ${esc(offer.status)}">${esc(offer.statusLabel)}</span></td><td><button class="secondary" data-server-edit-deal="${esc(offer.id)}">수정</button> <button class="${offer.paused?'success':'danger'}" data-server-pause-deal="${esc(offer.id)}">${offer.paused?'재개':'중지'}</button> <button class="danger" data-server-delete-deal="${esc(offer.id)}">삭제</button></td></tr>`).join('')||'<tr><td colspan="8" class="empty">등록된 특가가 없습니다.</td></tr>'}</tbody></table></div></section>`;
}
function serverCourseView(data){
  const dash=data.dash||{},course=dash.course||{},account=dash.account||{},master=currentCourse()||{};
  return `<section class="panel"><div class="panel-head"><div><h2>골프장 정보</h2><p>제휴 승인 정보와 서버 계정입니다.</p></div><span class="mode-chip server">서버 연동</span></div><div class="master-box"><h3>제휴 승인 정보</h3><dl><div><dt>골프장명</dt><dd>${esc(course.name||master.name||'-')}</dd></div><div><dt>지역</dt><dd>${esc(course.region||master.region||'')} ${esc(course.city||master.city||'')}</dd></div><div><dt>주소</dt><dd>${esc(course.address||master.address||'확인 필요')}</dd></div><div><dt>운영형태</dt><dd>${operationLabel(course.operationType||master.operationType)}</dd></div><div><dt>홀 수</dt><dd>${course.holes||master.holes?`${course.holes||master.holes}홀`:'확인 필요'}</dd></div><div><dt>대표 전화</dt><dd>${esc(course.phone||master.phone||'확인 필요')}</dd></div></dl></div><h3 class="subhead">로그인 계정</h3><div class="master-box"><dl><div><dt>담당자</dt><dd>${esc(account.name||'-')}</dd></div><div><dt>이메일</dt><dd>${esc(account.email||'-')}</dd></div><div><dt>권한</dt><dd>${esc(account.roleLabel||'-')}</dd></div><div><dt>상태</dt><dd>${esc(account.statusLabel||'-')}</dd></div><div><dt>마지막 로그인</dt><dd>${esc(String(account.lastLoginAt||'-').slice(0,16).replace('T',' '))}</dd></div></dl></div><p class="notice">계정 추가·비활성화는 본사 관리자만 할 수 있습니다. 승인 정보 수정은 다음 단계에서 지원할 예정입니다.</p></section>`;
}
const serverNum=id=>{const value=val(id).trim();return value===''?null:Number(value)};
function invalidateOnError(response){
  if(!response||!response.status)return;
  if(response.status===401){serverSession=null;if(apiClient.clearPartnerToken)apiClient.clearPartnerToken();alert((response.error&&response.error.message)||'로그인이 만료되었습니다. 다시 로그인해주세요.');render();return}
  alert((response.error&&response.error.message)||'요청을 처리하지 못했습니다.');
}
function serverTeeModal(tee){
  const item=tee||{date:selectedDate,time:'07:30',session:'1부',course:'전체',capacityTeams:1,maxPlayers:4,greenFee:150000,status:'open',note:''};
  modal.innerHTML=`<div class="modal-bg"><section class="modal"><h2>${tee?'티타임 수정':'티타임 추가'}</h2><p>${esc((serverCourse()||{}).name||'')} · 서버에 저장됩니다.</p><div class="form-grid"><label class="field">코스명<input id="st-course" maxlength="30" value="${esc(item.course||'전체')}" placeholder="예: 동코스 (전체 가능)"></label><label class="field">라운드 날짜<input id="st-date" type="date" value="${esc(item.date||selectedDate)}"></label><label class="field">티오프 시간<input id="st-time" type="time" value="${esc(item.time||'')}"></label><label class="field">부<select id="st-session">${['1부','2부','3부'].map(name=>`<option ${item.session===name?'selected':''}>${name}</option>`).join('')}</select></label><label class="field">예약 가능 팀 수<input id="st-capacity" type="number" min="1" max="20" value="${item.capacityTeams??1}"></label><label class="field">최대 예약 인원<select id="st-max">${[2,3,4].map(value=>`<option value="${value}" ${Number(item.maxPlayers)===value?'selected':''}>${value}명</option>`).join('')}</select></label><label class="field">기본 그린피(1인)<input id="st-price" type="number" min="0" value="${item.greenFee??0}"></label><label class="field">상태<select id="st-status"><option value="open" ${item.status==='open'?'selected':''}>판매 중</option><option value="stopped" ${item.status==='stopped'?'selected':''}>판매 중지</option><option value="closed" ${item.status==='closed'?'selected':''}>마감</option></select></label><label class="field full">메모(선택)<input id="st-note" maxlength="200" value="${esc(item.note||'')}"></label></div><div class="form-error" id="st-error"></div><div class="modal-actions"><button class="secondary" data-modal-close>닫기</button><button class="primary" id="st-save">저장</button></div></section></div>`;
  document.querySelector('[data-modal-close]').onclick=closeModal;
  document.querySelector('#st-save').onclick=async()=>{
    const date=val('st-date'),time=val('st-time'),hour=Number((time||'00:00').slice(0,2));
    const error=document.querySelector('#st-error');
    if(!date||!time){error.textContent='날짜와 티오프 시간을 입력해주세요.';return}
    const body={course:val('st-course'),date,time,session:val('st-session'),capacityTeams:Number(val('st-capacity')),maxPlayers:Number(val('st-max')),greenFee:Number(val('st-price')),status:val('st-status'),note:val('st-note')};
    if(hour<4||hour>20){error.textContent='티오프 시간은 04:00~20:00 사이로 입력해주세요.';return}
    const expected=hour<10?'1부':hour<14?'2부':'3부';
    if(body.session!==expected){error.textContent=`${time}에 맞는 부는 ${expected}입니다.`;return}
    const button=document.querySelector('#st-save');button.disabled=true;button.textContent='저장 중…';
    const response=tee?await partnerRequest(`/api/partner/tee-times/${encodeURIComponent(tee.id)}`,{method:'PATCH',body:{...body,version:tee.version}}):await partnerRequest('/api/partner/tee-times',{method:'POST',body});
    button.disabled=false;button.textContent='저장';
    if(!response.ok){error.textContent=(response.error&&response.error.message)||'저장하지 못했습니다.';return}
    closeModal();invalidateServer();render();
  };
}
function serverRecurringModal(){
  modal.innerHTML=`<div class="modal-bg"><section class="modal"><h2>날짜 반복 티타임 등록</h2><p>${esc((serverCourse()||{}).name||'')} · 같은 날짜·시간·코스는 건너뜁니다.</p><div class="form-grid"><label class="field">시작 날짜<input id="sr-start" type="date" value="${selectedDate}"></label><label class="field">종료 날짜<input id="sr-end" type="date" value="${selectedDate}"></label><label class="field">코스명<input id="sr-course" maxlength="30" value="전체"></label><label class="field">티오프 시간<input id="sr-time" type="time" value="07:30"></label><label class="field">예약 가능 팀 수<input id="sr-capacity" type="number" min="1" max="20" value="1"></label><label class="field">최대 인원<select id="sr-max">${[2,3,4].map(value=>`<option value="${value}" ${value===4?'selected':''}>${value}명</option>`).join('')}</select></label><label class="field">기본 그린피(1인)<input id="sr-price" type="number" min="0" value="150000"></label><label class="field">상태<select id="sr-status"><option value="open">판매 중</option><option value="stopped">판매 중지</option><option value="closed">마감</option></select></label></div><fieldset class="repeat-days"><legend>반복 요일</legend>${['일','월','화','수','목','금','토'].map((label,index)=>`<label><input type="checkbox" name="server-repeat-weekday" value="${index}" ${index>0&&index<6?'checked':''}> ${label}</label>`).join('')}</fieldset><p class="notice">최대 90일 · 서버에 저장되며 사용자 앱에 반영됩니다.</p><div class="form-error" id="sr-error"></div><div class="modal-actions"><button class="secondary" data-modal-close>닫기</button><button class="primary" id="sr-save">등록</button></div></section></div>`;
  document.querySelector('[data-modal-close]').onclick=closeModal;
  document.querySelector('#sr-save').onclick=async()=>{
    const weekdays=[...modal.querySelectorAll('[name="server-repeat-weekday"]:checked')].map(el=>Number(el.value));
    const error=document.querySelector('#sr-error');
    if(!weekdays.length){error.textContent='반복 요일을 하나 이상 선택해주세요.';return}
    const body={startDate:val('sr-start'),endDate:val('sr-end'),course:val('sr-course'),time:val('sr-time'),capacityTeams:Number(val('sr-capacity')),maxPlayers:Number(val('sr-max')),greenFee:Number(val('sr-price')),status:val('sr-status'),weekdays};
    const button=document.querySelector('#sr-save');button.disabled=true;button.textContent='등록 중…';
    const response=await partnerRequest('/api/partner/tee-times/recurring',{method:'POST',body});
    button.disabled=false;button.textContent='등록';
    if(!response.ok){error.textContent=(response.error&&response.error.message)||'등록하지 못했습니다.';return}
    closeModal();invalidateServer();render();
    alert(`${response.data.created}건 등록, ${response.data.skipped}건 건너뜀`);
  };
}
async function toggleServerTee(id,tee){
  if(!tee)return;
  const next=tee.status==='open'?'stopped':'open';
  if(!confirm(next==='stopped'?'이 티타임의 판매를 중지할까요?':'이 티타임을 다시 판매할까요?'))return;
  const response=await partnerRequest(`/api/partner/tee-times/${encodeURIComponent(id)}`,{method:'PATCH',body:{version:tee.version,status:next}});
  if(!response.ok){invalidateOnError(response);return}
  invalidateServer();render();
}
async function deleteServerTee(id,tee){
  if(!tee)return;
  if(!confirm('이 티타임을 삭제할까요? 예약·임시확보나 특가가 연결되어 있으면 삭제되지 않습니다.'))return;
  const response=await partnerRequest(`/api/partner/tee-times/${encodeURIComponent(id)}?version=${encodeURIComponent(tee.version)}`,{method:'DELETE'});
  if(!response.ok){invalidateOnError(response);return}
  invalidateServer();render();
}
async function saveServerRates(current){
  const body={baseGreenFee:serverNum('sr-base'),threePlayerGreenFee:serverNum('sr-three'),threePlayerSurcharge:serverNum('sr-three-surcharge')||0,fourPlayerGreenFee:serverNum('sr-four'),twoPlayerSurcharge:serverNum('sr-two-surcharge')||0,weekdayGreenFee:serverNum('sr-weekday'),weekendGreenFee:serverNum('sr-weekend'),cartFee:serverNum('sr-cart'),caddieFee:serverNum('sr-caddie'),depositType:val('sr-deposit-type'),depositValue:serverNum('sr-deposit-value')||0,cancellationPolicy:{sevenPlus:serverNum('sr-policy-seven')??0,fourToSix:serverNum('sr-policy-six')??0,twoToThree:serverNum('sr-policy-three')??0,oneDay:serverNum('sr-policy-one')??0,sameDay:serverNum('sr-policy-today')??0,cutoffHoursBefore:serverNum('sr-policy-cutoff')},version:current?current.version:0};
  if(body.baseGreenFee==null||!Number.isInteger(body.baseGreenFee)||body.baseGreenFee<0){alert('기본 그린피를 0원 이상 숫자로 입력해주세요.');return}
  const policyValues=Object.values(body.cancellationPolicy).filter(value=>value!=null);
  if(policyValues.some(value=>!Number.isFinite(Number(value))||Number(value)<0||Number(value)>720)){alert('취소·환불 정책 값을 확인해주세요. (환불률 0~100, 기한 0~720시간)');return}
  const response=await partnerRequest('/api/partner/rates',{method:'PUT',body});
  if(!response.ok){invalidateOnError(response);return}
  invalidateServer();render();
  alert('요금이 저장되었습니다. 고객 앱 계산에 반영됩니다.');
}
function serverDealModal(offer,teeTimes){
  const list=(teeTimes||[]).filter(tee=>tee.status==='open'&&(offer?true:tee.date===selectedDate));
  if(!list.length){alert('이 날짜에 판매 중인 티타임이 없습니다. 먼저 티타임을 등록해주세요.');return}
  const selected=list.find(tee=>tee.id===offer?.teeTimeId)||list[0];
  const now=new Date(),local=value=>`${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}T${String(value.getHours()).padStart(2,'0')}:${String(value.getMinutes()).padStart(2,'0')}`;
  const start=offer?.saleStartAt?String(offer.saleStartAt).slice(0,16):local(now);
  const end=offer?.saleEndAt?String(offer.saleEndAt).slice(0,16):local(new Date(Date.now()+86400000));
  modal.innerHTML=`<div class="modal-bg"><section class="modal deal-modal"><h2>${offer?'특가 수정':'특가 등록'}</h2><p>티타임에 연결되는 서버 특가입니다. 정상가·할인율은 서버가 계산합니다.</p><div class="form-grid"><label class="field">티타임<select id="sd-tee">${list.map(tee=>`<option value="${esc(tee.id)}" ${tee.id===selected.id?'selected':''}>${esc(tee.date)} ${esc(tee.time)} · ${esc(tee.course||'전체')} · ${money(tee.greenFee)}</option>`).join('')}</select></label><label class="field">특가명<input id="sd-name" maxlength="60" value="${esc(offer?.name||'')}" placeholder="예: 평일 오전 한정 특가"></label><label class="field full">설명(선택)<textarea id="sd-description" rows="2">${esc(offer?.description||'')}</textarea></label><label class="field">정상 그린피<input id="sd-regular" type="number" min="1" value="${offer?.regularPrice??selected.greenFee}"></label><label class="field">특가 그린피<input id="sd-special" type="number" min="0" value="${offer?.specialPrice??''}"></label><label class="field">적용 팀 수<input id="sd-team-limit" type="number" min="1" max="20" value="${offer?.teamLimit??selected.capacityTeams}"></label><label class="field">판매 시작<input id="sd-start" type="datetime-local" value="${esc(start)}"></label><label class="field">판매 종료<input id="sd-end" type="datetime-local" value="${esc(end)}"></label><label class="check"><input id="sd-visible" type="checkbox" ${offer?.visible===false?'':'checked'}> 사용자 화면 노출</label><label class="check"><input id="sd-paused" type="checkbox" ${offer?.paused?'checked':''}> 판매 중지</label></div><div class="form-error" id="sd-error"></div><div class="modal-actions"><button class="secondary" data-modal-close>취소</button><button class="primary" id="sd-save">저장</button></div></section></div>`;
  const syncTee=()=>{const tee=list.find(item=>item.id===val('sd-tee'));if(!tee)return;document.querySelector('#sd-regular').value=tee.greenFee;document.querySelector('#sd-team-limit').max=tee.capacityTeams};
  document.querySelector('#sd-tee').onchange=syncTee;
  document.querySelector('[data-modal-close]').onclick=closeModal;
  document.querySelector('#sd-save').onclick=async()=>{
    const error=document.querySelector('#sd-error');
    const body={teeTimeId:val('sd-tee'),name:val('sd-name'),description:val('sd-description'),roundDate:selectedDate,regularPrice:Number(val('sd-regular')),specialPrice:Number(val('sd-special')),teamLimit:Number(val('sd-team-limit')),saleStartAt:val('sd-start'),saleEndAt:val('sd-end'),visible:checked('sd-visible'),paused:checked('sd-paused')};
    const tee=list.find(item=>item.id===body.teeTimeId);if(tee)body.roundDate=tee.date;
    if(!body.name||body.name.trim().length<2){error.textContent='특가명을 2자 이상 입력해주세요.';return}
    if(!Number.isFinite(body.specialPrice)||body.specialPrice>=body.regularPrice){error.textContent='특가 그린피는 정상 그린피보다 낮아야 합니다.';return}
    if(!body.saleStartAt||!body.saleEndAt){error.textContent='판매 시작·종료 일시를 입력해주세요.';return}
    const button=document.querySelector('#sd-save');button.disabled=true;button.textContent='저장 중…';
    const response=offer?await partnerRequest(`/api/partner/special-offers/${encodeURIComponent(offer.id)}`,{method:'PATCH',body:{...body,version:offer.version}}):await partnerRequest('/api/partner/special-offers',{method:'POST',body});
    button.disabled=false;button.textContent='저장';
    if(!response.ok){error.textContent=(response.error&&response.error.message)||'저장하지 못했습니다.';return}
    closeModal();invalidateServer();render();
  };
}
async function pauseServerDeal(offer,paused){
  if(!offer)return;
  const response=await partnerRequest(`/api/partner/special-offers/${encodeURIComponent(offer.id)}`,{method:'PATCH',body:{version:offer.version,paused}});
  if(!response.ok){invalidateOnError(response);return}
  invalidateServer();render();
}
async function deleteServerDeal(offer){
  if(!offer)return;
  if(!confirm('이 특가를 삭제할까요? 예약 기록은 보존됩니다.'))return;
  const response=await partnerRequest(`/api/partner/special-offers/${encodeURIComponent(offer.id)}`,{method:'DELETE'});
  if(!response.ok){invalidateOnError(response);return}
  invalidateServer();render();
}

function render(){
  if(view==='apply'){app.innerHTML=applyPage();bindApply();return}
  if(view==='status'){app.innerHTML=statusPage();bindStatus();return}
  if(isServerMode()){renderServer();return}
  if(!localStorage.getItem(SESSION)){app.innerHTML=login();bindLogin();return}
  const pages={dashboard,tees:teePage,bookings:bookingsPage,rates:ratesPage,course:coursePage,deals:dealsPage};
  app.innerHTML=(pages[view]||dashboard)();bind();
}
const hasPartnerSession=()=>Boolean(localStorage.getItem(SESSION));
app.addEventListener('click',event=>{const target=event.target.closest('[data-view]');if(!target)return;view=target.dataset.view;location.hash=view;render()});
window.addEventListener('hashchange',()=>{const next=hashView();if(VIEWS.includes(next)){view=next;applyCourse=hashCourse();render()}});
window.addEventListener('storage',event=>{if(partnerApi&&event.key===partnerApi.KEY){courses=partnerCourses();render()}else if(event.key===store.RESERVATION_KEY&&hasPartnerSession())render()});
window.addEventListener('allgolf:partnerschange',()=>{courses=partnerCourses();render()});
window.addEventListener('allgolf:reservationschange',()=>{if(hasPartnerSession())render()});
window.addEventListener('allgolf:datachange',()=>{if(hasPartnerSession())render()});
render();
