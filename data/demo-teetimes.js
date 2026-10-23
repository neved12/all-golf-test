// 예약 플로우 시연 전용. 실제 가격·티타임·제휴 데이터가 아니다.
// 실서비스 DB로 이전할 때는 이 파일의 값을 골프장 마스터/실판매 재고로 복사하지 않는다.
const demoOverrides = {
  woojeong: {demoGreenFee:170000,demoTeeTimes:[['07:18',170000,1,true],['07:25',170000,2,false],['08:03',190000,1,false],['13:12',155000,3,false]]},
  emerson: {demoGreenFee:150000,demoTeeTimes:[['06:42',150000,2,false],['07:21',160000,1,true],['08:14',170000,2,false],['14:32',129000,1,true]]},
  princess: {demoGreenFee:145000,demoTeeTimes:[['07:12',145000,2,false],['08:24',155000,3,false],['11:06',150000,1,false],['15:18',135000,2,true]]}
};

const demoSlots = ['06:42','07:18','08:07','12:31','13:20'];
const demoEligibleCourses=(window.ALL_GOLF_COURSES||[]).filter(course=>course.bookingStatus==='demo'||course.dataMode==='demo');
window.ALL_GOLF_DEMO_COURSES = Object.fromEntries(demoEligibleCourses.map((course,index)=>{
  const seed=[...course.id].reduce((sum,char)=>sum+char.charCodeAt(0),0);
  const base=95000+(seed%9)*10000;
  const override=demoOverrides[course.id];
  const demoTeeTimes=(override?.demoTeeTimes||demoSlots.map((time,slot)=>[
    time,base+(slot===2?10000:slot===4?-5000:0),1+((seed+slot)%3),slot===4
  ])).map(([time,price,remaining,special])=>({time,price,remaining,special}));
  return [course.id,{
    dataMode:'demo',
    demoGreenFee:override?.demoGreenFee??base,
    demoTeeTimes,
    demoRemainingTeams:demoTeeTimes.map(slot=>slot.remaining),
    demoCartFee:100000,
    demoCaddieFee:150000,
    demoDeposit:30000,
    demoNoCaddie:course.id==='princess',
    demoDeal:course.id==='woojeong'||course.id==='emerson'||index%7===0
  }];
}));
