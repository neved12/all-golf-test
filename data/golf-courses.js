// ALL:GOLF 충청권 골프장 마스터 (검증 기준일: 2026-09-23)
// 실제 요금/티타임/제휴 여부는 추정하지 않는다. 시연 재고는 demo-teetimes.js에만 둔다.
window.ALL_GOLF_REGIONS=[{code:'전체',label:'전체'},{code:'충남',label:'충남'},{code:'충북',label:'충북'},{code:'세종',label:'세종'},{code:'대전',label:'대전'}];
const SRC={kgba:'https://www.kgba.co.kr/guidebook/2025/guidebook2025_04.pdf',kpgca:'https://www.kpgca.co.kr/sub03/sub01.php',kga:'https://www.kgagolf.or.kr/web/handicap/calculator'};
const rows=[
['cn-golden-bay','골든베이 골프&리조트','충남','태안'],['cn-gcz-cheonan','골프존카운티 천안','충남','천안'],['cn-dogo','도고 CC','충남','아산'],['cn-maron','마론 CC','충남','천안'],['cn-baekje','백제 CC','충남','부여'],['cn-boryeong-base','보령베이스 CC','충남','보령'],['cn-buyeo-skyhill','롯데스카이힐 부여 CC','충남','부여'],['cn-seosansu','서산수 골프앤리조트','충남','서산'],['cn-solago','솔라고 CC','충남','태안'],['cn-stonebeach','스톤비치 CC','충남','태안'],['cn-arista','아리스타 CC','충남','논산'],['cn-sg-beautiful','SG아름다운 골프&리조트','충남','아산'],['cn-edinburgh','에딘버러 CC','충남','금산'],['cn-esn','에스앤 CC','충남','보령'],['cn-yemiji','예미지 CC','충남','청양'],['woojeong','우정힐스 CC','충남','천안'],['cn-cheonan-sangnok','천안상록 CC','충남','천안'],['cn-pinestone','파인스톤 CC','충남','당진'],['cn-panacea','파나시아 GC','충남','당진'],['cn-flamingo','플라밍고 CC','충남','당진'],['princess','프린세스 CC','충남','공주'],['cn-royallinks','로얄링스 CC','충남','태안'],['cn-thehill','더힐 CC','충남','논산'],['cn-goldriver','골드리버 CC','충남','공주'],['cn-gyeryongsan','계룡산 CC','충남','공주'],
['cb-gamgok','감곡 CC','충북','음성'],['cb-goldnine','골드나인 CC','충북','청주'],['cb-gcz-jincheon','골프존카운티 진천','충북','진천'],['cb-gcz-hwarang','골프존카운티 화랑','충북','진천'],['cb-daeyoung-base','대영베이스 CC','충북','충주'],['cb-daeyoung-hills','대영힐스 CC','충북','충주'],['cb-daeho-danyang','대호단양 CC','충북','단양'],['cb-dongchon','동촌 GC','충북','충주'],['cb-tejebe','떼제베 CC','충북','청주'],['cb-rainbow','레인보우힐스 CC','충북','음성'],['cb-royalfore','올데이 로얄포레 CC','충북','충주'],['cb-monarch','모나크 CC','충북','음성'],['cb-belleforet','블랙스톤 벨포레 CC','충북','증평'],['cb-serenity','세레니티 CC','충북','청주'],['cb-centerium','센테리움 CC','충북','충주'],['cb-cygnus','시그너스 CC','충북','충주'],['cb-ananti','아난티중앙 CC','충북','진천'],['cb-ecolian','에콜리안 제천 CC','충북','제천'],['cb-allday','올데이 골프&리조트','충북','충주'],['cb-evendale','이븐데일 CC','충북','청주'],['cb-illite','일라이트 CC','충북','영동'],['cb-imperial','올데이 임페리얼레이크 CC','충북','충주'],['cb-gensfield','젠스필드 CC','충북','음성'],['cb-jinyang','진양밸리 CC','충북','음성'],['cb-grand','그랜드 CC','충북','청주'],['cb-cheonryong','천룡 CC','충북','진천'],['cb-jungwon','중원 CC','충북','충주'],['cb-kosca','코스카 CC','충북','음성'],['cb-clubd-boeun','클럽디 보은 CC','충북','보은'],['cb-clubd-sokri','클럽디 속리산 CC','충북','보은'],['cb-kingsdale','킹스데일 GC','충북','충주'],['cb-kingsrock','킹즈락 CC','충북','제천'],['cb-hiddenvalley','히든밸리 CC','충북','진천'],['cb-eumseong-hildesheim','음성힐데스하임 CC','충북','음성'],['cb-moka','모카 CC','충북','충주'],['cb-star','스타 CC','충북','충주'],['cb-sunvalley','썬밸리 CC','충북','음성'],['cb-ochang-edinburgh','오창에딘버러 CC','충북','청주'],
['emerson','세종에머슨 CC','세종','전의'],['sj-lakecastle','세종레이캐슬 CC','세종','전의'],['sj-field','세종필드 GC','세종','산울'],['dj-yuseong','유성 CC','대전','유성'],['dj-science-daedeok','사이언스대덕 CC','대전','유성']];
const v={};
const add=(ids,data)=>ids.split(' ').forEach(id=>v[id]={...(v[id]||{}),...data});
add('cn-golden-bay',{address:'충남 태안군 근흥면 정산포로 217',operationType:'membership',holes:27,courses:['마운틴','오션','밸리'],sources:[SRC.kgba,SRC.kga]});
add('cn-gcz-cheonan',{address:'충남 천안시 동남구 병천면 매성2길 103',operationType:'public',holes:18,courses:['아웃','인'],sources:[SRC.kgba,SRC.kpgca]});
add('cn-dogo',{address:'충남 아산시 선장면 삼봉산길 188',operationType:'membership',holes:18,sources:[SRC.kgba]});
add('cn-maron',{address:'충남 천안시 동남구 북면 납안5길 74',operationType:'public',holes:18,officialWebsite:'https://www.maronnewday.com/',sources:[SRC.kgba,'https://www.maronnewday.com/html/guide01.asp']});
add('cn-buyeo-skyhill',{address:'충남 부여군 규암면 백제문로 470',operationType:'public',holes:18,sources:[SRC.kgba]});
add('cn-seosansu',{address:'충남 서산시 대산읍 삼길포7로 6',operationType:'public',holes:18,sources:[SRC.kgba]});
add('cn-solago',{address:'충남 태안군 태안읍 소곳이길 92-234',operationType:'public',holes:36,sources:[SRC.kpgca]});
add('cn-sg-beautiful',{address:'충남 아산시 영인면 영인산로 440',operationType:'public',holes:27,sources:[SRC.kgba]});
add('cn-edinburgh',{address:'충남 금산군 진산면 살구정길 167',operationType:'membership',holes:18,sources:[SRC.kgba]});
add('woojeong',{address:'충남 천안시 동남구 목천읍 충절로 1048-68',operationType:'membership',holes:18,sources:[SRC.kgba]});
add('cn-cheonan-sangnok',{address:'충남 천안시 동남구 수신면 수신로 576',operationType:'public',holes:27,sources:[SRC.kgba]});
add('cn-panacea',{address:'충남 당진시 신평면 매산로 24',operationType:'public',holes:9,officialWebsite:'https://www.panaceagc.com/',sources:['https://www.panaceagc.com/']});
add('princess',{address:'충남 공주시 정안면 방자들길 81-50',operationType:'public',holes:18,officialWebsite:'https://www.princessgc.co.kr/',officialBookingUrl:'https://m.princessgc.co.kr/',sources:[SRC.kgba,'https://m.princessgc.co.kr/guide/fee']});
add('cb-gamgok',{address:'충북 음성군 감곡면 오갑길 195',operationType:'public',holes:18,officialWebsite:'http://www.gamgokcc.com/',sources:[SRC.kpgca]});
add('cb-goldnine',{address:'충북 청주시 청원구 낭성면 산성로 1520-17',operationType:'public',holes:9,officialWebsite:'https://www.gold-9.co.kr/',sources:['https://www.gold-9.co.kr/']});
add('cb-gcz-hwarang',{address:'충북 진천군 문백면 농다리로 809',operationType:'public',holes:18,officialWebsite:'https://www.golfzoncounty.com/',sources:[SRC.kpgca]});
add('cb-daeyoung-base',{address:'충북 충주시 대소원면 성종두담길 113',operationType:'public',holes:18,officialWebsite:'http://www.basecc.co.kr/',sources:['http://www.basecc.co.kr/']});
add('cb-daeyoung-hills',{address:'충북 충주시 대소원면 성종두담길 114',operationType:'public',holes:27,officialWebsite:'https://dyhills.basecc.co.kr:6443/Main/Main.aspx',sources:['https://dyhills.basecc.co.kr:6443/Main/Main.aspx']});
add('cb-daeho-danyang',{address:'충북 단양군 매포읍 고양5길 43',operationType:'public',holes:18,officialWebsite:'http://www.daehocc.co.kr/',sources:['http://www.daehocc.co.kr/']});
add('cb-dongchon',{address:'충북 충주시 노은면 감노로 1327',operationType:'public',holes:18,officialWebsite:'https://www.dongchongc.co.kr:442/',sources:['https://www.dongchongc.co.kr:442/']});
add('cb-tejebe',{address:'충북 청주시 흥덕구 옥산면 동림2길 149',operationType:'public',holes:36,officialWebsite:'https://www.onetheclub.com/tgv/main',sources:['https://www.onetheclub.com/tgv/main']});
add('cb-rainbow',{address:'충북 음성군 생극면 차생로 168',operationType:'public',holes:27,officialWebsite:'https://www.rainbowhills.co.kr/',sources:['https://www.rainbowhills.co.kr/']});
add('cb-royalfore',{address:'충북 충주시 신니면 화치3길 35',operationType:'public',holes:18,sources:[SRC.kgba]});
add('cb-monarch',{address:'충북 음성군 금왕읍 육령리 197-5',operationType:'public',holes:18,sources:['https://www.jobkorea.co.kr/company/45292652/recruit']});
add('cb-belleforet',{address:'충북 증평군 도안면 벨포레길 346',operationType:'public',holes:18,officialWebsite:'https://belleforetresort.com/',sources:['https://belleforetresort.com/']});
add('cb-serenity',{address:'충북 청주시 서원구 남이면 문곡구절골길 235',operationType:'mixed',holes:27,sources:[SRC.kgba]});
add('cb-centerium',{address:'충북 충주시 노은면 솔고개로 750',operationType:'public',holes:27,sources:[SRC.kgba]});
add('cb-cygnus',{address:'충북 충주시 앙성면 중방곡길 57-44',operationType:'mixed',holes:27,officialWebsite:'https://www.cygnuscc.com/',sources:['https://www.cygnuscc.com/']});
add('cb-ananti',{address:'충북 진천군 백곡면 배티로 818-105',operationType:'membership',holes:27,sources:[SRC.kgba]});
add('cb-ecolian',{address:'충북 제천시 송학면 오미로 241',operationType:'public',holes:9,officialWebsite:'https://www.ecolian.or.kr/common/main.do?coDiv=103',sources:['https://www.ecolian.or.kr/common/main.do?coDiv=103']});
add('cb-allday',{address:'충북 충주시 앙성면 비내길 189',operationType:'public',holes:18,officialWebsite:'https://www.alldaygolf.co.kr/',sources:['https://www.alldaygolf.co.kr/']});
add('cb-illite',{address:'충북 영동군 영동읍 영동힐링로 161',operationType:'public',holes:18,officialWebsite:'https://illitegolfnresort.co.kr/golf/main',sources:['https://illitegolfnresort.co.kr/golf/main']});
add('cb-imperial',{address:'충북 충주시 금가면 다래울길 52',operationType:'public',holes:18,sources:[SRC.kgba]});
add('cb-grand',{address:'충북 청주시 청원구 오창읍 꽃화산길 51-20',operationType:'membership',holes:27,officialWebsite:'https://www.grandgolf.co.kr/',sources:[SRC.kgba]});
add('cb-cheonryong',{address:'충북 진천군 이월면 진안로 347-123',operationType:'mixed',holes:36,sources:[SRC.kgba]});
add('cb-jungwon',{address:'충북 충주시 산척면 인등로 392',operationType:'public',holes:27,sources:[SRC.kpgca]});
add('cb-kosca',{address:'충북 음성군 음성읍 동음로 318',operationType:'public',holes:27,sources:[SRC.kgba]});
add('cb-kingsdale',{address:'충북 충주시 주덕읍 기업도시3로 2',operationType:'public',holes:18,sources:[SRC.kgba]});
add('cb-kingsrock',{address:'충북 제천시 내토로7길 136',operationType:'public',holes:27,sources:[SRC.kgba]});
add('cb-moka',{address:'충북 충주시 신니면 동락길 207',operationType:'public',holes:18,officialWebsite:'https://www.mokacc.co.kr/',sources:['https://www.mokacc.co.kr/']});
add('cb-star',{address:'충북 충주시 앙성면 상대촌1길 198',operationType:'membership',holes:18,officialWebsite:'https://starcc.net/',sources:['https://starcc.net/']});
add('cb-sunvalley',{address:'충북 음성군 삼성면 범말길 49',operationType:'public',holes:18,officialWebsite:'https://www.sunvalley.co.kr/iljuk/golf/intro',sources:[SRC.kgba]});
add('cb-ochang-edinburgh',{address:'충북 청주시 청원구 오창읍 두릉유리로 846',operationType:'public',holes:9,officialWebsite:'https://www.ochangedincc.com/',sources:['https://www.ochangedincc.com/']});
add('emerson',{address:'세종특별자치시 전의면 운주산로 1510',operationType:'membership',holes:27,officialWebsite:'http://www.sejongemerson.co.kr/',sources:[SRC.kgba]});
add('sj-lakecastle',{address:'세종특별자치시 전의면 의당전의로 252',operationType:'public',holes:27,courses:['세종','레이','캐슬'],officialWebsite:'https://www.sjraycastle.com/',sources:['https://www.sjraycastle.com/']});
add('sj-field',{address:'세종특별자치시 정안세종로 1569',operationType:'public',holes:18,courses:['세종','행복'],officialWebsite:'https://www.sejongcc.com/',sources:['https://www.sejongcc.com/']});
add('dj-yuseong',{address:'대전광역시 유성구 현충원로 200',operationType:'membership',holes:18,officialWebsite:'https://yscc.co.kr/',sources:[SRC.kgba]});
window.ALL_GOLF_COURSES=rows.map(([id,name,region,city])=>{const x=v[id]||{},operationType=x.operationType||'unknown';const verification={name:true,region:true,city:true,address:Boolean(x.address),operationType:operationType!=='unknown',holes:Number.isFinite(x.holes),courses:Boolean(x.courses?.length),website:Boolean(x.officialWebsite)};return{id,name,region,city,area:city,address:x.address||null,operationType,type:operationType==='membership'?'member':operationType,membershipType:operationType==='membership'?'member':operationType==='unknown'?null:operationType,holes:x.holes??null,courses:x.courses||[],officialWebsite:x.officialWebsite||null,officialBookingUrl:x.officialBookingUrl||null,website:x.officialWebsite||null,operatingStatus:x.sources?.length?'active':'unknown',verified:Object.values(verification).every(Boolean),verification,sources:x.sources||[],source:(x.sources||[])[0]||null,lastVerified:'2026-09-23',lastUpdated:'2026-09',greenFee:null,verifiedGreenFee:null,cartFee:null,caddieFee:null,bookingType:null,bookingStatus:'demo',partner:false,latitude:null,longitude:null,description:'',amenities:[],cancellationPolicy:null,dataMode:'demo'}});
