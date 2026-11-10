(function(){
  const OPS_KEY='allGolfOperationsV1';
  const RESERVATION_KEY='allGolfReservations';
  const MAX_TEAMS_PER_TEE=20;
  const HOLD_TTL_MS=5*60*1000;
  const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback))}catch{return fallback}};
  const write=(key,value)=>localStorage.setItem(key,JSON.stringify(value));
  const emptyState=()=>({version:4,teeTimes:{},rates:{},courseOverrides:{},specialOffers:{},bookingHolds:{},waitlist:[],notifications:[],updatedAt:null});
  const state=()=>{const current=read(OPS_KEY,emptyState());return {...emptyState(),...current,version:4,teeTimes:current.teeTimes||{},rates:current.rates||{},courseOverrides:current.courseOverrides||{},specialOffers:current.specialOffers||{},bookingHolds:current.bookingHolds||{},waitlist:current.waitlist||[],notifications:current.notifications||[]}};
  const save=value=>{value.updatedAt=new Date().toISOString();write(OPS_KEY,value);window.dispatchEvent(new CustomEvent('allgolf:datachange'));return value};
  const key=(courseId,date)=>`${courseId}::${date}`;
  const boundedInt=(value,min,max,fallback)=>{const number=Number(value);return Number.isInteger(number)?Math.min(max,Math.max(min,number)):fallback};
  const normalize=(courseId,date,item,index=0)=>({
    id:item.id||`${courseId}::${date}::${item.time}`,courseId,date,time:item.time,
    session:item.session||(+item.time.slice(0,2)<10?'1부':+item.time.slice(0,2)<14?'2부':'3부'),
    price:Number(item.price||0),regular:Number(item.regular||item.price||0),
    maxPlayers:boundedInt(item.maxPlayers,2,4,4),remaining:boundedInt(item.remaining,0,MAX_TEAMS_PER_TEE,1),capacityTeams:Math.max(boundedInt(item.remaining,0,MAX_TEAMS_PER_TEE,1),boundedInt(item.capacityTeams??item.remaining,0,MAX_TEAMS_PER_TEE,1)),
    closed:Boolean(item.closed),special:Boolean(item.special),instant:item.instant!==false,
    sort:index,updatedAt:item.updatedAt||null
  });
  const seedTimes=(courseId,date,fallback=[])=>{
    const data=state(),storageKey=key(courseId,date);
    if(!data.teeTimes[storageKey]){
      data.teeTimes[storageKey]=fallback.map((item,index)=>normalize(courseId,date,item,index));
      // Lazy demo seeding is an internal cache fill, not a user-visible change.
      write(OPS_KEY,data);
    }
    return data.teeTimes[storageKey];
  };
  const getTeeTimes=(courseId,date,fallback=[])=>seedTimes(courseId,date,fallback).map(item=>({...item}));
  const notifyMatchingWaiters=(data,courseId,date,items)=>{for(const entry of data.waitlist){if(entry.status!=='active'||entry.courseId!==courseId||entry.date!==date)continue;const match=items.find(tee=>!tee.closed&&tee.remaining>0&&(!entry.teeTimeId||tee.id===entry.teeTimeId)&&tee.time>=entry.fromTime&&tee.time<=entry.toTime&&tee.price<=entry.maxPrice&&tee.maxPlayers>=entry.people);if(!match)continue;const marker=`${entry.id}::${match.id}`;if(data.notifications.some(item=>item.marker===marker))continue;data.notifications.unshift({id:`note-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,marker,waitId:entry.id,courseId,date,teeTimeId:match.id,time:match.time,price:match.price,read:false,createdAt:new Date().toISOString(),message:'희망 조건에 맞는 시연용 티타임이 열렸습니다. 예약은 별도로 완료해야 합니다.'})}};
  const setTeeTimes=(courseId,date,items)=>{expireWaitlist();const data=state(),previous=data.teeTimes[key(courseId,date)]||[];data.teeTimes[key(courseId,date)]=items.map((item,index)=>normalize(courseId,date,item,index));const opened=data.teeTimes[key(courseId,date)].filter(tee=>{const old=previous.find(item=>item.id===tee.id);return !old||old.closed&&!tee.closed||old.remaining<tee.remaining});if(opened.length)notifyMatchingWaiters(data,courseId,date,opened);save(data);return data.teeTimes[key(courseId,date)]};
  const upsertTeeTime=(courseId,date,item)=>{const items=getTeeTimes(courseId,date);const index=items.findIndex(x=>x.id===item.id||x.time===item.time);if(index<0)items.push(item);else items[index]={...items[index],...item};return setTeeTimes(courseId,date,items)};
  const recurringPlan=(courseId,input,fallbackForDate=()=>[])=>{
    const {startDate,endDate,time}=input,weekdays=(input.weekdays||[]).map(Number),start=new Date(`${startDate}T00:00:00`),end=new Date(`${endDate}T00:00:00`);
    const span=Math.round((end-start)/86400000);
    if(!courseId||!/^\d{2}:\d{2}$/.test(time||'')||!Number.isFinite(span)||span<0||span>89||!weekdays.length||weekdays.some(day=>!Number.isInteger(day)||day<0||day>6))return {ok:false,message:'날짜 범위(최대 90일), 시간, 반복 요일을 확인해주세요.'};
    const price=Number(input.price),regular=Number(input.regular),maxPlayers=Number(input.maxPlayers),remaining=Number(input.remaining);
    if(!Number.isFinite(price)||price<0||!Number.isFinite(regular)||regular<0||!Number.isInteger(maxPlayers)||maxPlayers<2||maxPlayers>4||!Number.isInteger(remaining)||remaining<1||remaining>MAX_TEAMS_PER_TEE)return {ok:false,message:'그린피·인원·잔여 팀 설정을 확인해주세요.'};
    const existing=state().teeTimes,plan=[];
    for(let offset=0;offset<=span;offset++){
      const day=new Date(start);day.setDate(day.getDate()+offset);
      if(!weekdays.includes(day.getDay()))continue;
      const date=`${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
      const items=existing[key(courseId,date)]||fallbackForDate(date).map((item,index)=>normalize(courseId,date,item,index));
      const duplicate=items.some(item=>item.time===time)||getReservations().some(item=>item.courseId===courseId&&item.dateISO===date&&item.time===time);
      plan.push({date,time,duplicate});
    }
    return {ok:true,plan,createCount:plan.filter(item=>!item.duplicate).length,skipCount:plan.filter(item=>item.duplicate).length};
  };
  const registerRecurringTeeTimes=(courseId,input,fallbackForDate=()=>[])=>{
    const preview=recurringPlan(courseId,input,fallbackForDate);if(!preview.ok)return preview;
    let created=0,skipped=0;
    for(const entry of preview.plan){
      const date=entry.date,items=getTeeTimes(courseId,date,fallbackForDate(date));
      if(items.some(item=>item.time===input.time)||getReservations().some(item=>item.courseId===courseId&&item.dateISO===date&&item.time===input.time)){skipped++;continue}
      items.push({id:`${courseId}::${date}::${input.time}`,time:input.time,price:Number(input.price),regular:Number(input.regular),maxPlayers:Number(input.maxPlayers),remaining:Number(input.remaining),capacityTeams:Number(input.remaining),closed:false,instant:true});
      setTeeTimes(courseId,date,items);created++;
    }
    return {ok:true,created,skipped};
  };
  const deleteTeeTime=(courseId,date,id)=>setTeeTimes(courseId,date,getTeeTimes(courseId,date).filter(item=>item.id!==id));
  const reserveTee=(courseId,date,time)=>{const items=getTeeTimes(courseId,date);const tee=items.find(x=>x.time===time);if(!tee||tee.closed||tee.remaining<1)return false;tee.remaining-=1;if(tee.remaining===0)tee.closed=true;setTeeTimes(courseId,date,items);return true};
  const releaseTee=(courseId,date,time)=>{const items=getTeeTimes(courseId,date);const tee=items.find(x=>x.time===time);if(!tee)return false;const capacity=Number(tee.capacityTeams??tee.remaining+1);if(tee.remaining>=capacity)return false;tee.remaining=Math.min(capacity,tee.remaining+1);tee.closed=false;setTeeTimes(courseId,date,items);return true};
  const DEFAULT_CANCELLATION_POLICY={sevenPlus:100,fourToSix:70,twoToThree:50,oneDay:0,sameDay:0,cutoffHoursBefore:null};
  const getRates=courseId=>({weekdayGreenFee:null,weekendGreenFee:null,twoPlayerSurcharge:0,threePlayerSurcharge:0,cartFee:null,caddieFee:null,depositType:null,depositValue:null,cancellationPolicy:{...DEFAULT_CANCELLATION_POLICY},dataMode:'demo',...(state().rates[courseId]||{})});
  const setRates=(courseId,rates)=>{const data=state();data.rates[courseId]={...getRates(courseId),...rates,updatedAt:new Date().toISOString()};save(data);return data.rates[courseId]};
  const getGreenFeeForDate=(courseId,date,fallback)=>{const rates=getRates(courseId),day=new Date(`${date}T00:00:00`).getDay(),configured=day===0||day===6?rates.weekendGreenFee:rates.weekdayGreenFee;return configured==null||configured===''?Number(fallback||0):Math.max(0,Number(configured)||0)};
  const getPlayerSurcharge=(courseId,people,fallback=0)=>{const configured=state().rates[courseId],rates=getRates(courseId);if(Number(people)===2)return configured?Math.max(0,Number(rates.twoPlayerSurcharge||0)):0;if(Number(people)===3)return configured?Math.max(0,Number(rates.threePlayerSurcharge||0)):Math.max(0,Number(fallback||0));return 0};
  const calculateDeposit=(courseId,totalEstimated,people,fallbackPerPerson=0)=>{
    const rates=getRates(courseId),type=rates.depositType||'person',value=Number(rates.depositValue??fallbackPerPerson??0);
    if(type==='none')return 0;
    if(type==='team')return Math.max(0,value);
    if(type==='percent')return Math.max(0,Math.round(Number(totalEstimated||0)*value/100));
    return Math.max(0,value*Number(people||0));
  };
  const calculateCancellation=(reservation,at=new Date())=>{
    const paidDeposit=Number(reservation.paidDeposit??reservation.online??reservation.deposit??0);
    const policy={...DEFAULT_CANCELLATION_POLICY,...(reservation.cancellationPolicySnapshot||getRates(reservation.courseId).cancellationPolicy)};
    const roundDate=reservation.dateISO?new Date(`${reservation.dateISO}T00:00:00`):null;
    const baseDate=new Date(at);baseDate.setHours(0,0,0,0);
    const daysBefore=roundDate?Math.ceil((roundDate-baseDate)/86400000):0;
    const refundRate=daysBefore>=7?policy.sevenPlus:daysBefore>=4?policy.fourToSix:daysBefore>=2?policy.twoToThree:daysBefore===1?policy.oneDay:policy.sameDay;
    const refundAmount=Math.max(0,Math.round(paidDeposit*Number(refundRate||0)/100));
    const cutoff=policy.cutoffHoursBefore==null?null:Number(policy.cutoffHoursBefore);
    const roundAt=reservation.dateISO&&reservation.time?new Date(`${reservation.dateISO}T${reservation.time}:00`):null;
    const deadlineAt=roundAt&&cutoff!=null&&Number.isFinite(cutoff)?new Date(roundAt.getTime()-cutoff*3600000):null;
    return {paidDeposit,daysBefore,refundRate:Number(refundRate||0),refundAmount,cancellationFee:Math.max(0,paidDeposit-refundAmount),policy,deadlineAt:deadlineAt?.toISOString()||null,canCancel:!deadlineAt||new Date(at).getTime()<=deadlineAt.getTime()};
  };
  const getCourseOverride=courseId=>state().courseOverrides[courseId]||{};
  const setCourseOverride=(courseId,override)=>{const data=state();data.courseOverrides[courseId]={...getCourseOverride(courseId),...override,updatedAt:new Date().toISOString()};save(data);return data.courseOverrides[courseId]};
  const offerStatus=(offer,at=new Date())=>{
    if(offer.deletedAt)return 'deleted';
    if(offer.paused)return 'paused';
    const now=new Date(at).getTime(),start=new Date(offer.saleStartAt).getTime(),end=new Date(offer.saleEndAt).getTime();
    if(Number.isFinite(start)&&now<start)return 'scheduled';
    if(Number.isFinite(end)&&now>end)return 'ended';
    return 'active';
  };
  const getSpecialOffers=(courseId=null,{includeDeleted=false}={})=>Object.values(state().specialOffers).filter(offer=>(!courseId||offer.courseId===courseId)&&(includeDeleted||!offer.deletedAt)).map(offer=>({...offer,status:offerStatus(offer)})).sort((a,b)=>String(a.roundDate).localeCompare(String(b.roundDate))||String(a.time).localeCompare(String(b.time)));
  const getSpecialOffer=id=>{const offer=state().specialOffers[id];return offer?{...offer,status:offerStatus(offer)}:null};
  const rangesOverlap=(aStart,aEnd,bStart,bEnd)=>new Date(aStart).getTime()<new Date(bEnd).getTime()&&new Date(bStart).getTime()<new Date(aEnd).getTime();
  const validateSpecialOffer=(input,ignoreId=null)=>{
    const regularPrice=Number(input.regularPrice),specialPrice=Number(input.specialPrice),teamLimit=Number(input.teamLimit);
    if(!input.courseId||!input.roundDate||!input.teeTimeId||!input.time||!input.name)return {ok:false,message:'골프장, 날짜, 티타임, 특가명을 모두 입력해주세요.'};
    if(!Number.isFinite(specialPrice)||specialPrice<0||!Number.isFinite(regularPrice)||specialPrice>=regularPrice)return {ok:false,message:'특가는 0원 이상이며 정상가보다 낮아야 합니다.'};
    if(!Number.isInteger(teamLimit)||teamLimit<1)return {ok:false,message:'특가 적용 팀 수를 1팀 이상 입력해주세요.'};
    if(new Date(input.saleEndAt).getTime()<=new Date(input.saleStartAt).getTime())return {ok:false,message:'판매 종료일시는 시작일시보다 늦어야 합니다.'};
    const tee=getTeeTimes(input.courseId,input.roundDate).find(item=>item.id===input.teeTimeId);
    if(!tee)return {ok:false,message:'연결할 기존 티타임을 찾을 수 없습니다.'};
    const usedTeams=ignoreId?getReservations().filter(item=>item.specialOfferId===ignoreId&&item.status!=='cancelled').length:0;
    if(!ignoreId&&(tee.closed||tee.remaining<1))return {ok:false,message:'마감되었거나 잔여 팀이 없는 티타임에는 특가를 등록할 수 없습니다.'};
    if(teamLimit<usedTeams)return {ok:false,message:'특가 적용 팀 수는 이미 확정된 특가 예약 수보다 작게 변경할 수 없습니다.'};
    if(teamLimit>tee.remaining+usedTeams)return {ok:false,message:'특가 적용 팀 수는 티타임 잔여 수량과 기존 특가 예약 수의 합을 초과할 수 없습니다.'};
    const conflict=getSpecialOffers(input.courseId).find(offer=>offer.id!==ignoreId&&offer.roundDate===input.roundDate&&offer.teeTimeId===input.teeTimeId&&!offer.deletedAt&&!offer.paused&&rangesOverlap(input.saleStartAt,input.saleEndAt,offer.saleStartAt,offer.saleEndAt));
    if(conflict)return {ok:false,message:'같은 티타임의 판매 기간과 겹치는 특가가 이미 있습니다.'};
    return {ok:true,tee};
  };
  const saveSpecialOffer=input=>{
    const validation=validateSpecialOffer(input,input.id||null);if(!validation.ok)return validation;
    const data=state(),now=new Date().toISOString(),id=input.id||`sp-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const regularPrice=Math.round(Number(input.regularPrice)),specialPrice=Math.round(Number(input.specialPrice));
    const previous=data.specialOffers[id]||{};
    const offer={...previous,...input,id,courseId:input.courseId,roundDate:input.roundDate,teeTimeId:input.teeTimeId,time:input.time,name:String(input.name).trim(),description:String(input.description||'').trim(),regularPrice,specialPrice,discountAmount:regularPrice-specialPrice,discountRate:Math.round((regularPrice-specialPrice)*100/regularPrice),teamLimit:Number(input.teamLimit),visible:input.visible!==false,paused:Boolean(input.paused),dataMode:'demo',createdAt:previous.createdAt||now,updatedAt:now,deletedAt:null};
    data.specialOffers[id]=offer;save(data);return {ok:true,offer:{...offer,status:offerStatus(offer)}};
  };
  const setSpecialOfferPaused=(id,paused)=>{const data=state(),offer=data.specialOffers[id];if(!offer)return {ok:false,reason:'not_found'};if(!paused){const tee=getTeeTimes(offer.courseId,offer.roundDate).find(item=>item.id===offer.teeTimeId);if(!tee||tee.closed||tee.remaining<1)return {ok:false,message:'마감되었거나 잔여 팀이 없는 티타임은 재개할 수 없습니다.'};const validation=validateSpecialOffer({...offer,paused:false},id);if(!validation.ok)return validation}offer.paused=Boolean(paused);offer.updatedAt=new Date().toISOString();save(data);return {ok:true,offer:{...offer,status:offerStatus(offer)}}};
  const deleteSpecialOffer=id=>{const data=state(),offer=data.specialOffers[id];if(!offer)return {ok:false,reason:'not_found'};const used=getReservations().some(item=>item.specialOfferId===id);if(used){offer.deletedAt=new Date().toISOString();offer.paused=true;offer.visible=false;offer.updatedAt=offer.deletedAt;save(data);return {ok:true,softDeleted:true}}delete data.specialOffers[id];save(data);return {ok:true,softDeleted:false}};
  const getActiveSpecialOffer=(courseId,date,teeTimeId,at=new Date())=>getSpecialOffers(courseId).find(offer=>offer.roundDate===date&&offer.teeTimeId===teeTimeId&&offer.visible!==false&&offerStatus(offer,at)==='active')||null;
  const applySpecialOffer=(courseId,date,tee,at=new Date())=>{const offer=getActiveSpecialOffer(courseId,date,tee.id,at);if(!offer)return {...tee,regularPrice:Number(tee.regular||tee.price),appliedPrice:Number(tee.price),specialOffer:null};const offerReservations=getReservations().filter(item=>item.specialOfferId===offer.id&&item.status!=='cancelled').length;const soldOut=offerReservations>=offer.teamLimit||tee.remaining<1;return {...tee,regularPrice:offer.regularPrice,appliedPrice:soldOut?Number(tee.price):offer.specialPrice,price:soldOut?Number(tee.price):offer.specialPrice,special:!soldOut,specialOffer:soldOut?null:{...offer,remainingOfferTeams:Math.max(0,offer.teamLimit-offerReservations)}}};
  const getReservations=()=>read(RESERVATION_KEY,[]);
  const expireWaitlist=()=>{const data=state(),now=new Date(),today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`,clock=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;let changed=false;data.waitlist.forEach(item=>{if(item.status==='active'&&(item.date<today||item.date===today&&item.toTime<clock)){item.status='expired';item.updatedAt=now.toISOString();changed=true}});if(changed)write(OPS_KEY,data);return data};
  const getWaitlist=()=>expireWaitlist().waitlist.map(item=>({...item}));
  const saveWait=(input)=>{const courseId=String(input.courseId||''),date=String(input.date||''),fromTime=String(input.fromTime||''),toTime=String(input.toTime||''),people=Number(input.people),maxPrice=Number(input.maxPrice);if(!courseId||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d\d:\d\d$/.test(fromTime)||!/^\d\d:\d\d$/.test(toTime)||fromTime>toTime||![3,4].includes(people)||!Number.isFinite(maxPrice)||maxPrice<0)return {ok:false,message:'대기 조건을 다시 확인해주세요.'};const teeTimeId=String(input.teeTimeId||''),applicantName=String(input.applicantName||'').trim(),applicantPhone=String(input.applicantPhone||'').replace(/\D/g,'');if(teeTimeId){const tee=getTeeTimes(courseId,date).find(item=>item.id===teeTimeId);if(!tee||tee.remaining>0&&!tee.closed)return {ok:false,message:'마감된 티타임만 대기 등록할 수 있습니다.'};if(!applicantName||!/^01\d{8,9}$/.test(applicantPhone))return {ok:false,message:'신청자 이름과 휴대전화번호를 확인해주세요.'}}const now=new Date(),today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`,clock=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;if(date<today||date===today&&toTime<clock)return {ok:false,message:'지난 날짜와 시간에는 대기를 등록할 수 없습니다.'};const data=expireWaitlist(),existing=data.waitlist.find(item=>item.status==='active'&&item.courseId===courseId&&item.date===date&&(teeTimeId?item.teeTimeId===teeTimeId&&item.applicantPhone===applicantPhone:item.fromTime===fromTime)&&item.toTime===toTime&&item.people===people&&item.maxPrice===maxPrice);if(existing)return {ok:false,message:'같은 조건의 대기 신청이 이미 있습니다.'};const entry={teeTimeId:teeTimeId||null,applicantName:applicantName||null,applicantPhone:applicantPhone||null,id:`wait-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,courseId,date,fromTime,toTime,people,maxPrice,status:'active',createdAt:new Date().toISOString(),dataMode:'demo'};data.waitlist.unshift(entry);save(data);return {ok:true,entry}};
  const cancelWait=id=>{const data=expireWaitlist(),entry=data.waitlist.find(item=>item.id===id);if(!entry||entry.status!=='active')return false;entry.status='cancelled';entry.updatedAt=new Date().toISOString();save(data);return true};
  const completeMatchingWaits=reservation=>{const data=expireWaitlist();let changed=false;data.waitlist.forEach(item=>{if(item.status==='active'&&item.courseId===reservation.courseId&&item.date===reservation.dateISO&&(!item.teeTimeId||item.teeTimeId===reservation.teeTimeId)&&(!item.applicantPhone||item.applicantPhone===String(reservation.phone||'').replace(/\D/g,''))&&item.fromTime<=reservation.time&&item.toTime>=reservation.time&&Number(item.people)===Number(reservation.people)&&Number(item.maxPrice)>=Number(reservation.appliedGreenFee??reservation.greenFee??0)){item.status='completed';item.reservationNumber=reservation.number;item.updatedAt=new Date().toISOString();changed=true}});if(changed)save(data);return changed};
  const getNotifications=()=>state().notifications.map(item=>({...item}));
  const markNotificationRead=id=>{const data=state(),item=data.notifications.find(entry=>entry.id===id);if(!item)return false;item.read=true;save(data);return true};
  const setReservations=items=>{const previous=getReservations(),existing=new Set(previous.map(item=>item.number||item.id));write(RESERVATION_KEY,items);items.filter(item=>item.status==='confirmed'&&!existing.has(item.number||item.id)).forEach(completeMatchingWaits);window.dispatchEvent(new CustomEvent('allgolf:reservationschange'));return items};
  const cancelReservation=(reference,cancelReason='사용자 취소')=>{
    const items=getReservations();
    const index=items.findIndex(item=>item.number===reference||item.id===reference);
    if(index<0)return {ok:false,reason:'not_found'};
    const current=items[index];
    if(current.status==='cancelled')return {ok:true,alreadyCancelled:true,inventoryRestored:false,reservation:current};
    const refund=calculateCancellation(current);
    if(!refund.canCancel)return {ok:false,reason:'deadline_passed',refund};
    let inventoryRestored=false;
    if(!current.inventoryRestoredAt&&current.courseId&&current.dateISO&&current.time){
      inventoryRestored=releaseTee(current.courseId,current.dateISO,current.time);
    }
    const cancelledAt=new Date().toISOString();
    const updated={...current,status:'cancelled',cancelledAt,cancelReason,paidDeposit:refund.paidDeposit,cancellationFee:refund.cancellationFee,refundAmount:refund.refundAmount,refundStatus:'demo_refunded'};
    if(inventoryRestored)updated.inventoryRestoredAt=cancelledAt;
    items[index]=updated;
    setReservations(items);
    return {ok:true,alreadyCancelled:false,inventoryRestored,reservation:updated};
  };
  const pruneHolds=data=>{const now=Date.now();Object.keys(data.bookingHolds).forEach(teeId=>{const active=(data.bookingHolds[teeId]||[]).filter(hold=>new Date(hold.expiresAt).getTime()>now);if(active.length)data.bookingHolds[teeId]=active;else delete data.bookingHolds[teeId]});return data};
  const acquireTeeHold=(courseId,date,teeTimeId,ownerId,ttlMs=HOLD_TTL_MS)=>{
    const tees=getTeeTimes(courseId,date),tee=tees.find(item=>item.id===teeTimeId);if(!tee||tee.closed||tee.remaining<1)return {ok:false,reason:'sold_out'};
    const data=pruneHolds(state()),list=data.bookingHolds[teeTimeId]||[],existing=list.find(hold=>hold.ownerId===ownerId);
    if(existing){existing.expiresAt=new Date(Date.now()+ttlMs).toISOString();save(data);return {ok:true,hold:{...existing},reused:true}}
    if(list.length>=tee.remaining)return {ok:false,reason:'held_by_other'};
    const hold={id:`hold-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,ownerId,courseId,date,teeTimeId,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+ttlMs).toISOString()};
    data.bookingHolds[teeTimeId]=[...list,hold];save(data);return {ok:true,hold:{...hold},reused:false};
  };
  const releaseTeeHold=(holdId,ownerId=null)=>{const data=pruneHolds(state());let released=false;Object.keys(data.bookingHolds).forEach(teeId=>{const before=data.bookingHolds[teeId],after=before.filter(hold=>{const match=hold.id===holdId&&(!ownerId||hold.ownerId===ownerId);if(match)released=true;return !match});if(after.length)data.bookingHolds[teeId]=after;else delete data.bookingHolds[teeId]});if(released)save(data);return released};
  const commitTeeHold=(holdId,ownerId)=>{const data=pruneHolds(state());let hold=null,holdKey='';Object.entries(data.bookingHolds).some(([teeId,list])=>{hold=list.find(item=>item.id===holdId&&item.ownerId===ownerId)||null;if(hold)holdKey=teeId;return Boolean(hold)});if(!hold)return {ok:false,reason:'hold_expired'};const storageKey=key(hold.courseId,hold.date),tees=data.teeTimes[storageKey]||[],tee=tees.find(item=>item.id===hold.teeTimeId);if(!tee||tee.closed||tee.remaining<1)return {ok:false,reason:'sold_out'};tee.remaining-=1;if(tee.remaining===0)tee.closed=true;data.bookingHolds[holdKey]=(data.bookingHolds[holdKey]||[]).filter(item=>item.id!==holdId);if(!data.bookingHolds[holdKey].length)delete data.bookingHolds[holdKey];save(data);return {ok:true,tee:{...tee}}};
  const getActiveHolds=(courseId,date,teeTimeId)=>{const data=pruneHolds(state());return (data.bookingHolds[teeTimeId]||[]).filter(hold=>hold.courseId===courseId&&hold.date===date).map(hold=>({...hold}))};
  window.ALL_GOLF_STORE={OPS_KEY,RESERVATION_KEY,DEFAULT_CANCELLATION_POLICY,MAX_TEAMS_PER_TEE,HOLD_TTL_MS,getTeeTimes,setTeeTimes,upsertTeeTime,deleteTeeTime,recurringPlan,registerRecurringTeeTimes,reserveTee,releaseTee,getRates,setRates,getGreenFeeForDate,getPlayerSurcharge,calculateDeposit,calculateCancellation,getCourseOverride,setCourseOverride,getSpecialOffers,getSpecialOffer,getActiveSpecialOffer,applySpecialOffer,validateSpecialOffer,saveSpecialOffer,setSpecialOfferPaused,deleteSpecialOffer,offerStatus,getReservations,setReservations,cancelReservation,acquireTeeHold,releaseTeeHold,commitTeeHold,getActiveHolds,getWaitlist,saveWait,cancelWait,getNotifications,markNotificationRead};
})();
