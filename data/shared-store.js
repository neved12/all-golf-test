(function(){
  const OPS_KEY='allGolfOperationsV1';
  const RESERVATION_KEY='allGolfReservations';
  const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback))}catch{return fallback}};
  const write=(key,value)=>localStorage.setItem(key,JSON.stringify(value));
  const emptyState=()=>({version:2,teeTimes:{},rates:{},courseOverrides:{},specialOffers:{},updatedAt:null});
  const state=()=>{const current=read(OPS_KEY,emptyState());return {...emptyState(),...current,teeTimes:current.teeTimes||{},rates:current.rates||{},courseOverrides:current.courseOverrides||{},specialOffers:current.specialOffers||{}}};
  const save=value=>{value.updatedAt=new Date().toISOString();write(OPS_KEY,value);window.dispatchEvent(new CustomEvent('allgolf:datachange'));return value};
  const key=(courseId,date)=>`${courseId}::${date}`;
  const normalize=(courseId,date,item,index=0)=>({
    id:item.id||`${courseId}::${date}::${item.time}`,courseId,date,time:item.time,
    session:item.session||(+item.time.slice(0,2)<10?'1부':+item.time.slice(0,2)<14?'2부':'3부'),
    price:Number(item.price||0),regular:Number(item.regular||item.price||0),
    maxPlayers:Number(item.maxPlayers||4),remaining:Number(item.remaining??1),
    closed:Boolean(item.closed),special:Boolean(item.special),instant:item.instant!==false,
    sort:index,updatedAt:item.updatedAt||null
  });
  const seedTimes=(courseId,date,fallback=[])=>{
    const data=state(),storageKey=key(courseId,date);
    if(!data.teeTimes[storageKey]){
      data.teeTimes[storageKey]=fallback.map((item,index)=>normalize(courseId,date,item,index));
      save(data);
    }
    return data.teeTimes[storageKey];
  };
  const getTeeTimes=(courseId,date,fallback=[])=>seedTimes(courseId,date,fallback).map(item=>({...item}));
  const setTeeTimes=(courseId,date,items)=>{const data=state();data.teeTimes[key(courseId,date)]=items.map((item,index)=>normalize(courseId,date,item,index));save(data);return data.teeTimes[key(courseId,date)]};
  const upsertTeeTime=(courseId,date,item)=>{const items=getTeeTimes(courseId,date);const index=items.findIndex(x=>x.id===item.id||x.time===item.time);if(index<0)items.push(item);else items[index]={...items[index],...item};return setTeeTimes(courseId,date,items)};
  const deleteTeeTime=(courseId,date,id)=>setTeeTimes(courseId,date,getTeeTimes(courseId,date).filter(item=>item.id!==id));
  const reserveTee=(courseId,date,time)=>{const items=getTeeTimes(courseId,date);const tee=items.find(x=>x.time===time);if(!tee||tee.closed||tee.remaining<1)return false;tee.remaining-=1;if(tee.remaining===0)tee.closed=true;setTeeTimes(courseId,date,items);return true};
  const releaseTee=(courseId,date,time)=>{const items=getTeeTimes(courseId,date);const tee=items.find(x=>x.time===time);if(!tee)return false;tee.remaining+=1;tee.closed=false;setTeeTimes(courseId,date,items);return true};
  const DEFAULT_CANCELLATION_POLICY={sevenPlus:100,fourToSix:70,twoToThree:50,oneDay:0,sameDay:0};
  const getRates=courseId=>({weekdayGreenFee:null,weekendGreenFee:null,cartFee:null,caddieFee:null,depositType:null,depositValue:null,cancellationPolicy:{...DEFAULT_CANCELLATION_POLICY},dataMode:'demo',...(state().rates[courseId]||{})});
  const setRates=(courseId,rates)=>{const data=state();data.rates[courseId]={...getRates(courseId),...rates,updatedAt:new Date().toISOString()};save(data);return data.rates[courseId]};
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
    return {paidDeposit,daysBefore,refundRate:Number(refundRate||0),refundAmount,cancellationFee:Math.max(0,paidDeposit-refundAmount),policy};
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
  const setReservations=items=>{write(RESERVATION_KEY,items);window.dispatchEvent(new CustomEvent('allgolf:reservationschange'));return items};
  const cancelReservation=(reference,cancelReason='사용자 취소')=>{
    const items=getReservations();
    const index=items.findIndex(item=>item.number===reference||item.id===reference);
    if(index<0)return {ok:false,reason:'not_found'};
    const current=items[index];
    if(current.status==='cancelled')return {ok:true,alreadyCancelled:true,inventoryRestored:false,reservation:current};
    let inventoryRestored=false;
    if(!current.inventoryRestoredAt&&current.courseId&&current.dateISO&&current.time){
      inventoryRestored=releaseTee(current.courseId,current.dateISO,current.time);
    }
    const cancelledAt=new Date().toISOString(),refund=calculateCancellation(current,new Date(cancelledAt));
    const updated={...current,status:'cancelled',cancelledAt,cancelReason,paidDeposit:refund.paidDeposit,cancellationFee:refund.cancellationFee,refundAmount:refund.refundAmount,refundStatus:'demo_refunded'};
    if(inventoryRestored)updated.inventoryRestoredAt=cancelledAt;
    items[index]=updated;
    setReservations(items);
    return {ok:true,alreadyCancelled:false,inventoryRestored,reservation:updated};
  };
  window.ALL_GOLF_STORE={OPS_KEY,RESERVATION_KEY,DEFAULT_CANCELLATION_POLICY,getTeeTimes,setTeeTimes,upsertTeeTime,deleteTeeTime,reserveTee,releaseTee,getRates,setRates,calculateDeposit,calculateCancellation,getCourseOverride,setCourseOverride,getSpecialOffers,getSpecialOffer,getActiveSpecialOffer,applySpecialOffer,validateSpecialOffer,saveSpecialOffer,setSpecialOfferPaused,deleteSpecialOffer,offerStatus,getReservations,setReservations,cancelReservation};
})();
