// 예약 플로우 시연 전용. 실제 가격·티타임·제휴 데이터가 아니다.
// 실서비스 DB로 이전할 때는 이 파일의 값을 골프장 마스터/실판매 재고로 복사하지 않는다.
const demoOverrides = {
  woojeong: {demoGreenFee:170000,demoTeeTimes:[['07:18',170000,1,true],['07:25',170000,2,false],['08:03',190000,1,false],['13:12',155000,3,false]]},
  emerson: {demoGreenFee:150000,demoTeeTimes:[['06:42',150000,2,false],['07:21',160000,1,true],['08:14',170000,2,false],['14:32',129000,1,true]]},
  princess: {demoGreenFee:145000,demoTeeTimes:[['07:12',145000,2,false],['08:24',155000,3,false],['11:06',150000,1,false],['15:18',135000,2,true]]}
};

const demoSlots = ['06:42','07:18','08:07','12:31','13:20'];
const allCourses=window.ALL_GOLF_COURSES||[];
// 전국 마스터 전체를 같은 시연 예약 엔진에 연결한다. 기존 시연 골프장은 별도로
// 표시해 생성 규칙을 그대로 보존하고, 새 골프장에만 가상 데이터 규칙을 적용한다.
const originalDemoIds=new Set(allCourses.filter(course=>course.bookingStatus==='demo'||course.dataMode==='demo').map(course=>course.id));
const stableSeed=value=>[...String(value)].reduce((sum,char)=>((sum*31)+char.charCodeAt(0))>>>0,2166136261);
const isWeekend=date=>[0,6].includes(new Date(`${date}T00:00:00`).getDay());
const shiftTime=(time,minutes)=>{const [hour,minute]=time.split(':').map(Number),total=hour*60+minute+minutes;return `${String(Math.floor(total/60)%24).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`};

window.ALL_GOLF_DEMO_COURSES = Object.fromEntries(allCourses.map((course,index)=>{
  const seed=[...course.id].reduce((sum,char)=>sum+char.charCodeAt(0),0);
  const base=95000+(seed%9)*10000;
  const override=demoOverrides[course.id];
  const demoTeeTimes=(override?.demoTeeTimes||demoSlots.map((time,slot)=>[
    time,base+(slot===2?10000:slot===4?-5000:0),1+((seed+slot)%3),slot===4
  ])).map(([time,price,remaining,special])=>({time,price,remaining,special}));
  return [course.id,{
    dataMode:'demo',
    generatedDemo:!originalDemoIds.has(course.id),
    demoGreenFee:override?.demoGreenFee??base,
    demoTeeTimes,
    demoRemainingTeams:demoTeeTimes.map(slot=>slot.remaining),
    demoCartFee:100000,
    demoCaddieFee:150000,
    demoDeposit:30000,
    demoNoCaddie:course.id==='princess',
    demoDeal:course.id==='woojeong'||course.id==='emerson'||index%7===0,
    demoThreePlayerSurcharge:originalDemoIds.has(course.id)?0:10000,
    demoNotice:'시연용 예약이며 실제 골프장 예약이 아닙니다'
  }];
}));

// 날짜별 재고 키(courseId::date::time)를 만들 때 사용하는 결정론적 가상 데이터.
// 같은 골프장·날짜에는 항상 같은 값이 나오므로 새로고침해도 값이 흔들리지 않는다.
window.ALL_GOLF_DEMO_FOR_DATE=(courseId,date)=>{
  const demo=window.ALL_GOLF_DEMO_COURSES[courseId];
  if(!demo)return [];
  if(!demo.generatedDemo)return demo.demoTeeTimes.map(item=>({...item}));
  const seed=stableSeed(`${courseId}:${date}`),weekend=isWeekend(date),minuteShift=(seed%4)*3;
  return demoSlots.map((time,index)=>{
    const base=Number(demo.demoGreenFee||0)+(weekend?20000:0);
    const price=base+(index===2?10000:index===4?-5000:0);
    return {time:shiftTime(time,minuteShift),price,remaining:1+((seed+index)%3),special:false,virtual:true,dataMode:'demo'};
  });
};
