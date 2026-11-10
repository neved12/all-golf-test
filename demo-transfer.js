/* Local demo transfer: allowlisted operational fields only; never copy browser storage wholesale. */
(function () {
  'use strict';
  const FORMAT = 'all-golf-demo-backup';
  const KEYS = ['allGolfReservations', 'allGolfOperationsV1', 'allGolfPartners', 'allGolfPartnerTeeTimes', 'allGolfPartnershipStatusV1'];
  const catalog = new Map((window.ALL_GOLF_COURSES || []).map(c => [c.id, c]));
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const fail = message => { throw new Error(message); };
  const record = x => object(x) ? x : fail('객체 형식이 올바르지 않습니다.');
  const safeKey = k => !['__proto__', 'prototype', 'constructor'].includes(k);
  const id = x => typeof x === 'string' && /^[a-zA-Z0-9_:.-]{1,160}$/.test(x) ? x : fail('식별자 형식이 올바르지 않습니다.');
  const course = x => catalog.has(x) ? x : fail('현재 골프장 목록에 없는 골프장 ID입니다.');
  const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : fail('수치 형식이 올바르지 않습니다.');
  const bool = x => typeof x === 'boolean' ? x : fail('참/거짓 형식이 올바르지 않습니다.');
  const choice = values => x => values.includes(x) ? x : fail('지원하지 않는 상태 값입니다.');
  const date = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x)) ? x : fail('날짜 형식이 올바르지 않습니다.');
  const stamp = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT[\d:.+Z-]+$/.test(x) && !Number.isNaN(Date.parse(x)) ? x : fail('일시 형식이 올바르지 않습니다.');
  const time = x => typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x) ? x : fail('시간 형식이 올바르지 않습니다.');
  const fields = (input, schema, required = []) => {
    record(input);
    required.forEach(k => { if (!own(input, k) || input[k] == null) fail('필수 필드가 없습니다: ' + k); });
    const out = {};
    for (const [k, validate] of Object.entries(schema)) if (own(input, k)) out[k] = input[k] == null ? null : validate(input[k]);
    return out;
  };
  const list = (x, clean) => Array.isArray(x) && x.length <= 100000 ? x.map(clean) : fail('목록 형식이나 건수가 올바르지 않습니다.');
  const map = (x, clean, keyCheck = id) => {
    record(x); const out = {};
    for (const [k, v] of Object.entries(x)) { if (!safeKey(k)) fail('허용하지 않는 키입니다.'); keyCheck(k); out[k] = clean(v, k); }
    return out;
  };
  const status = choice(['confirmed','cancelled','completed','no_show','no-show','refund-complete','pending']);
  const policy = x => fields(x, Object.fromEntries(['sevenPlus','fourToSix','twoToThree','oneDay','sameDay','cutoffHoursBefore'].map(k => [k, number])));
  const moneyFields = names => Object.fromEntries(names.split(' ').map(k => [k, number]));
  const dates = Object.fromEntries(['createdAt','updatedAt','cancelledAt','inventoryRestoredAt','deletedAt'].map(k => [k, stamp]));
  const tee = x => fields(x, {id, courseId:course, date, time, session:choice(['1부','2부','3부']), ...moneyFields('price regular maxPlayers remaining capacityTeams sort players'), closed:bool, special:bool, instant:bool, ...dates}, ['id','time','price','remaining']);
  const offer = x => ({...fields(x, {id,courseId:course,roundDate:date,teeTimeId:id,time,saleStartAt:stamp,saleEndAt:stamp,...moneyFields('regularPrice specialPrice discountAmount discountRate teamLimit'),visible:bool,paused:bool,...dates}, ['id','courseId','roundDate','teeTimeId','time']), name:'시연 특가', description:'', dataMode:'demo'});
  const reservation = x => {
    record(x);
    if (!x.dateISO) {
      const match=typeof x.date==='string' && /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s*\([일월화수목금토]\))?$/.exec(x.date);
      x={...x,dateISO:match?`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`:date(x.date)};
    }
    const out = fields(x, {id,number:id,courseId:course,dateISO:date,time,teeTimeId:id,status,paymentStatus:choice(['demo_paid','demo_refunded','pending','paid']),refundStatus:choice(['demo_refunded','pending']),specialOfferId:id,...moneyFields('people holes baseGreenFee playerSurcharge regularGreenFee appliedGreenFee discountAmount greenFee greenTotal cart caddie totalEstimated paidDeposit online onsite deposit refundAmount cancellationFee'),pricingSnapshot:v => fields(v,{dateType:choice(['weekday','weekend']),...moneyFields('people playerSurcharge')}),specialOfferSnapshot:v => ({...fields(v,{id,...moneyFields('regularPrice specialPrice discountRate'),roundDate:date,time}),name:'시연 특가'}),cancellationPolicySnapshot:policy,...dates}, ['id','courseId','dateISO','time','people','status']);
    out.courseName = catalog.get(out.courseId).name;
    if (out.dateISO) out.date = out.dateISO;
    out.booker = '시연 이용자'; out.phone = ''; out.companions = []; out.demo = true;
    return out;
  };
  const rates = x => ({...fields(x,{...moneyFields('weekdayGreenFee weekendGreenFee twoPlayerSurcharge threePlayerSurcharge cartFee caddieFee depositValue'),depositType:choice(['none','team','person','percent']),cancellationPolicy:policy,updatedAt:stamp}),dataMode:'demo'});
  const wait = x => ({...fields(x,{id,courseId:course,date,fromTime:time,toTime:time,teeTimeId:id,...moneyFields('people maxPrice'),status:choice(['active','cancelled','completed','expired']),reservationNumber:id,...dates},['id','courseId','date','fromTime','toTime','status']),applicantName:null,applicantPhone:null,dataMode:'demo'});
  const note = x => ({...fields(x,{id,waitId:id,marker:id,courseId:course,date,teeTimeId:id,time,price:number,read:bool,createdAt:stamp},['id','courseId']),message:'희망 조건에 맞는 시연용 티타임이 열렸습니다.'});
  const teeKey = k => { const split = k.split('::'); if (split.length !== 2) fail('티타임 저장 키가 올바르지 않습니다.'); course(split[0]); date(split[1]); };
  const operations = x => {
    record(x); if (own(x,'version') && x.version !== 4) fail('지원하지 않는 운영 저장소 버전입니다.');
    const out = {version:4,teeTimes:{},rates:{},courseOverrides:{},specialOffers:{},bookingHolds:{},waitlist:[],notifications:[],updatedAt:null};
    if (own(x,'teeTimes')) out.teeTimes = map(x.teeTimes,(items,k) => list(items,item => {const t=tee(item); if(t.courseId && t.courseId!==k.split('::')[0] || t.date && t.date!==k.split('::')[1]) fail('티타임 골프장/날짜가 일치하지 않습니다.');return t;}),teeKey);
    if (own(x,'rates')) out.rates = map(x.rates,rates,course);
    if (own(x,'courseOverrides')) out.courseOverrides = map(x.courseOverrides,v => fields(v,{bookingEnabled:bool,updatedAt:stamp}),course);
    if (own(x,'specialOffers')) out.specialOffers = map(x.specialOffers,(v,k) => { const o=offer(v); if(o.id!==k) fail('특가 ID가 일치하지 않습니다.');return o; });
    if (own(x,'waitlist')) out.waitlist = list(x.waitlist,wait);
    if (own(x,'notifications')) out.notifications = list(x.notifications,note);
    if (x.updatedAt != null) out.updatedAt = stamp(x.updatedAt);
    return out;
  };
  const partner = x => ({...fields(x,{id,fee:number,cycle:choice(['매월 15일','매월 말일']),created:date,status:choice(['정상 운영','심사 중','중지','해지'])},['id']),name:'시연 제휴 골프장',manager:'',phone:'',region:''});
  const cleaners = {
    allGolfReservations:x => list(x,reservation), allGolfOperationsV1:operations,
    allGolfPartners:x => list(x,partner), allGolfPartnerTeeTimes:x => list(x,tee),
    allGolfPartnershipStatusV1:x => map(x,v => ({...fields(v,{status:choice(['unknown','none','talking','complete']),updatedAt:stamp},['status']),note:''}),course)
  };
  function cleanData(data) {
    record(data); const out = {};
    for (const k of KEYS) if (own(data,k)) out[k] = cleaners[k](data[k]);
    if (!Object.keys(out).length) fail('복원 가능한 시연 데이터가 없습니다.');
    // Reservations and their inventory must travel together.
    if (own(out,'allGolfReservations') !== own(out,'allGolfOperationsV1')) fail('예약과 운영 데이터는 함께 백업·복원해야 합니다.');
    return out;
  }
  const snapshot = () => Object.fromEntries(KEYS.map(k => [k,localStorage.getItem(k)]));
  const fromSnapshot = raw => {
    const data = {}; for (const k of KEYS) if (raw[k] !== null) { try {data[k]=JSON.parse(raw[k]);} catch {fail('현재 저장 데이터 JSON 오류: '+k);} }
    if (!own(data,'allGolfReservations')) data.allGolfReservations=[];
    if (!own(data,'allGolfOperationsV1')) data.allGolfOperationsV1={version:4};
    return cleanData(data);
  };
  const envelope = data => ({format:FORMAT,version:1,createdAt:new Date().toISOString(),courseCatalogCount:catalog.size,privacy:'개인정보·자유 입력 문구·인증 정보 제외. 개인 식별값을 넣지 않은 시연 운영 ID만 사용하세요.',data});
  function parse(text) {
    if (typeof text !== 'string' || text.length > 20*1024*1024) fail('20MB 이하의 JSON 파일을 선택해주세요.');
    const value=JSON.parse(text.replace(/^\uFEFF/,'')); record(value);
    if(value.format!==FORMAT || value.version!==1 || value.courseCatalogCount!==catalog.size) fail('백업 형식·버전 또는 골프장 수가 현재 프로젝트와 다릅니다.');
    const data=cleanData(value.data);
    if(data.allGolfOperationsV1) for(const k of ['teeTimes','rates','specialOffers','waitlist','notifications']) if(!own(value.data.allGolfOperationsV1,k)) fail('운영 백업 필드가 누락되었습니다: '+k);
    return data;
  }
  function download(value,prefix) {
    const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download=prefix+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  const summary = data => `예약 ${(data.allGolfReservations||[]).length}건 · 티타임 ${Object.values(data.allGolfOperationsV1?.teeTimes||{}).reduce((n,v)=>n+v.length,0)}개 · 특가 ${Object.keys(data.allGolfOperationsV1?.specialOffers||{}).length}건 · 제휴 상태 ${Object.keys(data.allGolfPartnershipStatusV1||{}).length}곳`;
  let pending=null, safety=null;
  function view(shell) {
    pending=null;safety=null;
    return shell('시연 데이터 백업·복원',`<section class="panel"><h2>현재 브라우저의 시연 데이터</h2><p class="notice">예약·티타임·요금·취소 정책·특가·대기·알림·제휴 상태를 JSON으로 옮깁니다. 244개 골프장 마스터 파일은 변경하지 않습니다. 같은 주소와 브라우저에서만 저장소가 공유됩니다.</p><p>이름·연락처·동반자·요청사항·메모·회원·문의·비밀번호·인증 토큰은 제외됩니다. 특가명과 제휴사명은 시연용 문구로 대체합니다. 운영 ID에 개인정보를 입력하지 마세요. 개인정보가 제거된 백업으로는 원래 개인정보를 복구할 수 없습니다. 임시 예약 잠금은 이전하지 않습니다.</p><button class="primary" id="demo-export">시연 데이터 JSON 다운로드</button></section><section class="panel"><h2>JSON 복원</h2><p>1. 파일 검증 → 2. 현재 데이터 백업 다운로드 및 저장 확인 → 3. 덮어쓰기 확인. 파일에 포함된 저장 항목만 교체하며, 포함되지 않은 항목은 유지합니다. 복원 중에는 다른 탭에서 예약·수정을 중단해주세요.</p><label class="field">백업 JSON 파일<input type="file" id="demo-import-file" accept=".json,application/json"></label><p id="demo-transfer-status" role="status" aria-live="polite"></p><div id="demo-restore-controls" hidden><p id="demo-transfer-preview"></p><button class="secondary" id="demo-before-export">복원 전 현재 데이터 백업 다운로드</button><label class="field"><span><input type="checkbox" id="demo-backup-saved"> 다운로드된 백업 파일이 저장된 것을 확인했습니다.</span></label><button class="danger" id="demo-restore" disabled>확인 후 덮어쓰기 복원</button></div></section>`);
  }
  function bind() {
    const exportButton=document.querySelector('#demo-export');if(!exportButton)return;
    const status=document.querySelector('#demo-transfer-status'),controls=document.querySelector('#demo-restore-controls'),check=document.querySelector('#demo-backup-saved'),restore=document.querySelector('#demo-restore');
    const report=error=>{status.textContent=error.message||String(error);};
    exportButton.onclick=()=>{try{download(envelope(fromSnapshot(snapshot())),'all-golf-demo-backup');status.textContent='개인정보를 제외한 백업 다운로드를 요청했습니다. 다운로드 폴더를 확인해주세요.';}catch(e){report(e);}};
    document.querySelector('#demo-import-file').onchange=async event=>{
      pending=null;safety=null;controls.hidden=true;check.checked=false;restore.disabled=true;
      const file=event.target.files[0];if(!file)return;
      try{if(file.size>20*1024*1024)fail('20MB 이하의 JSON 파일을 선택해주세요.');const text=await file.text();if(event.target.files[0]!==file)return;pending=parse(text);document.querySelector('#demo-transfer-preview').textContent=summary(pending);controls.hidden=false;status.textContent='검증 완료. 아직 저장 데이터를 변경하지 않았습니다.';}catch(e){report(e);}
    };
    document.querySelector('#demo-before-export').onclick=()=>{try{const raw=snapshot();download(envelope(fromSnapshot(raw)),'all-golf-demo-before-restore');safety=raw;check.checked=false;restore.disabled=true;status.textContent='복원 전 백업 다운로드를 요청했습니다. 실제 파일 저장을 확인한 후 체크해주세요.';}catch(e){safety=null;restore.disabled=true;report(e);}};
    check.onchange=()=>{restore.disabled=!(pending&&safety&&check.checked);};
    restore.onclick=()=>{
      try {
        if(!localStorage.getItem('allGolfAdminAuth'))fail('본사 관리자 로그인이 필요합니다.');
        if(!pending||!safety||!check.checked)fail('복원 전 백업 파일 저장을 먼저 확인해주세요.');
        if(JSON.stringify(snapshot())!==JSON.stringify(safety))fail('백업 후 데이터가 변경되었습니다. 현재 데이터를 다시 백업해주세요.');
        const incoming=cleanData(pending);
        if(!confirm('선택한 JSON에 포함된 항목으로 현재 시연 데이터를 덮어쓸까요?\n'+summary(incoming)+'\n개인정보는 복원되지 않습니다.'))return;
        if(JSON.stringify(snapshot())!==JSON.stringify(safety))fail('확인 중 데이터가 변경되었습니다. 다시 백업해주세요.');
        // Roll back exact originals in memory if a quota/write error occurs. Never clear storage.
        const written=[];
        try {for(const k of KEYS)if(own(incoming,k)){const encoded=JSON.stringify(incoming[k]);localStorage.setItem(k,encoded);written.push(k);}}
        catch(error){for(const k of written.reverse())if(safety[k]===null)localStorage.removeItem(k);else localStorage.setItem(k,safety[k]);throw error;}
        pending=null;safety=null;restore.disabled=true;check.checked=false;controls.hidden=true;
        window.dispatchEvent(new CustomEvent('allgolf:datachange'));window.dispatchEvent(new CustomEvent('allgolf:reservationschange'));
        status.textContent='복원 완료. 사용자 앱과 골프장 관리자 탭을 새로고침해주세요. 골프장 마스터와 로그인 정보는 유지했습니다.';
      }catch(e){report(e);}
    };
  }
  window.ALL_GOLF_DEMO_TRANSFER={view,bind,parse,cleanData,createBackup:()=>envelope(fromSnapshot(snapshot()))};
})();